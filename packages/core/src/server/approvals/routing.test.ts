import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type ClientSession, Types } from 'mongoose';
import { connectDb, withTransaction } from '@pulse/db';
import { ActionError } from '../../actions';
import { EMPLOYMENT_STATUS, type EmploymentStatus } from '../../account';
import { AuditLogModel } from '../audit/model';
import { DepartmentModel } from '../departments/model';
import { EmployeeModel } from '../employees/model';
import { NotificationModel } from '../notifications/model';
import { UserModel } from '../users/model';
import { ApprovalRequestModel } from './model';
import { type ApprovalStepSpec, registerApprovalType, unregisterApprovalType } from './registry';
import {
  activeBoardApprovers,
  activeHrApprovers,
  activeSystemAdministrators,
  loadRequester,
  NO_OTHER_SYSTEM_ADMINISTRATOR,
  routeApprovalSteps,
} from './routing';
import { getApproval, submitApproval } from './service';

// Routing a request's steps (docs/modules/core.md#approvals and #reporting-lines,
// docs/TESTING.md#approvals-tests). Made-up data only. Every test starts from an empty set of
// people, so "every active System Administrator" means only the ones the test adds.

interface Person {
  id: string;
  userId: Types.ObjectId;
  employeeId: Types.ObjectId;
  name: string;
}

let counter = 0;

async function departmentId(code: string): Promise<Types.ObjectId> {
  const found = await DepartmentModel.findOne({ code }, { _id: 1 }).lean();
  if (found) return found._id;
  return (await DepartmentModel.create({ name: `Department ${code}`, code }))._id;
}

/** An employee with a user account. */
async function person(
  firstName: string,
  {
    department = 'NET',
    status = 'Regular',
    reportingTo = [],
    admin = false,
  }: {
    department?: string;
    status?: EmploymentStatus;
    reportingTo?: Person[];
    admin?: boolean;
  } = {},
): Promise<Person> {
  counter += 1;
  const employee = await EmployeeModel.create({
    employeeNumber: `2024-${String(counter).padStart(2, '0')}`,
    firstName,
    lastName: 'Test',
    departmentId: await departmentId(department),
    positionId: new Types.ObjectId(),
    reportingTo: reportingTo.map((supervisor) => supervisor.employeeId),
    employmentStatus: status,
    dateHired: new Date('2024-01-01T00:00:00+08:00'),
    separationDate:
      EMPLOYMENT_STATUS[status] === 'active' ? null : new Date('2024-06-01T00:00:00+08:00'),
  });
  const user = await UserModel.create({
    email: `routing${counter}@xtreme-works.com`,
    passwordHash: 'not-a-real-hash',
    employeeId: employee._id,
    isSystemAdministrator: admin,
  });
  return {
    id: user._id.toHexString(),
    userId: user._id,
    employeeId: employee._id,
    name: `${firstName} Test`,
  };
}

async function route(
  requester: Person,
  steps: ApprovalStepSpec[],
  whenEmpty?: 'skip' | 'hr' | 'systemAdministrator',
) {
  return withTransaction(async (session) =>
    routeApprovalSteps(steps, whenEmpty, await loadRequester(requester.userId, session), session),
  );
}

const ids = (approvers: { userId: Types.ObjectId }[]) =>
  approvers.map((approver) => approver.userId.toHexString()).sort();
const idsOf = (...people: Person[]) => people.map((p) => p.id).sort();

const SUPERVISOR_STEP: ApprovalStepSpec = { kind: 'reportingTo', label: 'Supervisor' };

beforeAll(async () => {
  await connectDb();
  await Promise.all([
    ApprovalRequestModel.init(),
    UserModel.init(),
    EmployeeModel.init(),
    DepartmentModel.init(),
    AuditLogModel.init(),
    NotificationModel.init(),
  ]);
});

beforeEach(async () => {
  await Promise.all([
    UserModel.collection.deleteMany({}),
    EmployeeModel.collection.deleteMany({}),
    ApprovalRequestModel.collection.deleteMany({}),
  ]);
});

describe('reportingTo', () => {
  it('reaches every active supervisor and leaves out inactive and separated ones', async () => {
    const first = await person('Bea');
    const second = await person('Carlo', { status: 'Probationary' });
    const resigned = await person('Dina', { status: 'Resigned' });
    const retired = await person('Eli', { status: 'Retired' });
    const noAccount = await EmployeeModel.create({
      employeeNumber: '2024-99',
      firstName: 'Fe',
      lastName: 'Test',
      departmentId: new Types.ObjectId(),
      positionId: new Types.ObjectId(),
      employmentStatus: 'Regular',
      dateHired: new Date('2024-01-01T00:00:00+08:00'),
    });
    const requester = await person('Ana', { reportingTo: [first, resigned, second, retired] });
    await EmployeeModel.updateOne(
      { _id: requester.employeeId },
      { $push: { reportingTo: noAccount._id } },
    );

    const [step] = await route(requester, [SUPERVISOR_STEP]);
    expect(step).toMatchObject({ kind: 'reportingTo', rule: 'any', status: 'waiting' });
    expect(step?.routedToSystemAdministrator).toBe(false);
    expect(step?.approvers.map((a) => a.userId.toHexString())).toEqual([first.id, second.id]);
    expect(step?.approvers.map((a) => a.nameSnapshot)).toEqual(['Bea Test', 'Carlo Test']);
  });

  it('follows whenEmpty for a requester with no supervisor, and refuses without it', async () => {
    const hr = await person('Hana', { department: 'HR' });
    const admin = await person('Ivo', { admin: true });
    const requester = await person('Ana');

    const [skipped] = await route(requester, [SUPERVISOR_STEP], 'skip');
    expect(skipped).toMatchObject({ status: 'skipped', approvers: [] });

    const [toHr] = await route(requester, [SUPERVISOR_STEP], 'hr');
    expect(ids(toHr?.approvers ?? [])).toEqual(idsOf(hr));
    expect(toHr).toMatchObject({ rule: 'any', routedToSystemAdministrator: false });

    const [toAdmin] = await route(requester, [SUPERVISOR_STEP], 'systemAdministrator');
    expect(ids(toAdmin?.approvers ?? [])).toEqual(idsOf(admin));
    expect(toAdmin?.routedToSystemAdministrator).toBe(true);

    await expect(route(requester, [SUPERVISOR_STEP])).rejects.toThrow(ActionError);
    await expect(route(requester, [SUPERVISOR_STEP])).rejects.toThrow(/no active supervisor/);
  });

  it('treats a line to only inactive supervisors as empty', async () => {
    const gone = await person('Bea', { status: 'Terminated' });
    const requester = await person('Ana', { reportingTo: [gone] });
    const [step] = await route(requester, [SUPERVISOR_STEP], 'skip');
    expect(step?.status).toBe('skipped');
  });

  it('keeps the approvers fixed when reportingTo changes after submit', async () => {
    registerApprovalType('test.fixed', {
      module: 'core',
      label: 'Fixed',
      allowedDecisions: ['approve', 'return'],
      steps: [SUPERVISOR_STEP],
      onSettled: () => {},
    });
    const before = await person('Bea');
    const after = await person('Carlo');
    const requester = await person('Ana', { reportingTo: [before] });
    const { id } = await withTransaction((session) =>
      submitApproval(
        {
          type: 'test.fixed',
          record: { type: 'test.thing', id: new Types.ObjectId(), label: 'Thing' },
          title: 'Fixed approvers',
          href: '/approvals',
          requesterUserId: requester.userId,
        },
        { session },
      ),
    );
    await EmployeeModel.updateOne(
      { _id: requester.employeeId },
      { $set: { reportingTo: [after.employeeId] } },
    );
    const detail = await getApproval({ id: before.id, isSystemAdministrator: false }, id);
    expect(detail?.steps[0]?.approvers.map((a) => a.userId)).toEqual([before.id]);
    expect(await getApproval({ id: after.id, isSystemAdministrator: false }, id)).toBeNull();
    unregisterApprovalType('test.fixed');
  });
});

describe('the requester never decides', () => {
  it('removes the requester from every set', async () => {
    const other = await person('Bea', { department: 'BOD' });
    const requester = await person('Ana', { department: 'BOD' });
    const [board] = await route(requester, [
      { kind: 'anyOf', label: 'Board', approvers: { set: 'board' } },
    ]);
    expect(ids(board?.approvers ?? [])).toEqual(idsOf(other));
  });

  it('sends a step whose only approver is the requester to every active System Administrator', async () => {
    const adminA = await person('Ivo', { admin: true });
    const adminB = await person('Jo', { admin: true });
    await person('Kit', { admin: true, status: 'Resigned' });
    const requester = await person('Ana');

    for (const kind of ['anyOf', 'allOf'] as const) {
      const [step] = await route(requester, [
        { kind, label: 'Only me', approvers: { userIds: [requester.userId] } },
      ]);
      expect(step).toMatchObject({ kind, rule: 'any', routedToSystemAdministrator: true });
      expect(ids(step?.approvers ?? [])).toEqual(idsOf(adminA, adminB));
      expect(step?.approvers.every((a) => a.asSystemAdministrator)).toBe(true);
      expect(ids(step?.approvers ?? [])).not.toContain(requester.id);
    }
  });

  it('routes a supervisor-less HR user’s HR step to the System Administrator, never to them', async () => {
    const admin = await person('Ivo', { admin: true });
    const requester = await person('Hana', { department: 'HR' });
    const [step] = await route(requester, [SUPERVISOR_STEP], 'hr');
    expect(ids(step?.approvers ?? [])).toEqual(idsOf(admin));
    expect(step?.routedToSystemAdministrator).toBe(true);
  });

  it('routes a System Administrator’s self-only step to the other System Administrators', async () => {
    const other = await person('Ivo', { admin: true });
    const requester = await person('Ana', { admin: true });
    const [step] = await route(requester, [
      { kind: 'anyOf', label: 'Only me', approvers: { userIds: [requester.userId] } },
    ]);
    expect(ids(step?.approvers ?? [])).toEqual(idsOf(other));
  });

  it('refuses the submit when no other System Administrator is active', async () => {
    await person('Kit', { admin: true, status: 'Resigned' });
    const requester = await person('Ana', { admin: true });
    const step: ApprovalStepSpec = {
      kind: 'anyOf',
      label: 'Only me',
      approvers: { userIds: [requester.userId] },
    };
    await expect(route(requester, [step])).rejects.toThrow(NO_OTHER_SYSTEM_ADMINISTRATOR);
    await expect(route(requester, [SUPERVISOR_STEP], 'systemAdministrator')).rejects.toThrow(
      NO_OTHER_SYSTEM_ADMINISTRATOR,
    );
  });

  it('fills the requester’s place in an all-of step with any one System Administrator', async () => {
    const director = await person('Bea');
    const admin = await person('Ivo', { admin: true });
    const requester = await person('Ana');
    const [step] = await route(requester, [
      {
        kind: 'allOf',
        label: 'Payment approvers',
        approvers: { userIds: [requester.userId, director.userId] },
      },
    ]);
    expect(step).toMatchObject({ rule: 'all', routedToSystemAdministrator: true });
    expect(step?.approvers.map((a) => [a.userId.toHexString(), a.asSystemAdministrator])).toEqual([
      [director.id, false],
      [admin.id, true],
    ]);
  });

  it('refuses an all-of step holding the requester when no other System Administrator can fill it', async () => {
    const director = await person('Bea');
    const requester = await person('Ana', { admin: true });
    await expect(
      route(requester, [
        {
          kind: 'allOf',
          label: 'Payment approvers',
          approvers: { userIds: [requester.userId, director.userId] },
        },
      ]),
    ).rejects.toThrow(NO_OTHER_SYSTEM_ADMINISTRATOR);
  });
});

describe('sets', () => {
  it('lists active Board, HR and System Administrator users, the system account included', async () => {
    const board = await person('Bea', { department: 'BOD' });
    await person('Carlo', { department: 'BOD', status: 'Resigned' });
    const hr = await person('Hana', { department: 'HR' });
    const admin = await person('Ivo', { admin: true });
    const system = await UserModel.create({
      email: 'system@xtreme-works.com',
      passwordHash: 'not-a-real-hash',
      isSystemAccount: true,
      isSystemAdministrator: true,
    });

    expect(ids(await activeBoardApprovers())).toEqual(idsOf(board));
    expect(ids(await activeHrApprovers())).toEqual(idsOf(hr));
    expect(ids(await activeSystemAdministrators())).toEqual(
      [admin.id, system._id.toHexString()].sort(),
    );

    await UserModel.updateOne({ _id: system._id }, { $set: { systemAccountDisabled: true } });
    expect(ids(await activeSystemAdministrators())).toEqual(idsOf(admin));
  });

  it('leaves inactive named users out of an all-of step, and follows whenEmpty when none is left', async () => {
    const active = await person('Bea');
    const gone = await person('Carlo', { status: 'Resigned' });
    const requester = await person('Ana');
    const [step] = await route(requester, [
      { kind: 'allOf', label: 'Both', approvers: { userIds: [active.userId, gone.userId] } },
    ]);
    expect(ids(step?.approvers ?? [])).toEqual(idsOf(active));

    const [empty] = await route(
      requester,
      [{ kind: 'allOf', label: 'Gone', approvers: { userIds: [gone.userId] } }],
      'skip',
    );
    expect(empty?.status).toBe('skipped');
  });

  it('refuses a requester whose account isn’t active', async () => {
    const requester = await person('Ana', { status: 'Resigned' });
    await expect(
      withTransaction((session: ClientSession) => loadRequester(requester.userId, session)),
    ).rejects.toThrow(ActionError);
  });
});
