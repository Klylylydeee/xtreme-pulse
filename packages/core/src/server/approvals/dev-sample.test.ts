import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { ActionError } from '../../actions';
import { AuditLogModel } from '../audit/model';
import { DepartmentModel } from '../departments/model';
import { EmployeeModel } from '../employees/model';
import { NotificationModel } from '../notifications/model';
import { UserModel } from '../users/model';
import { parseDevSampleStep, submitDevSampleApproval } from './dev-sample';
import { ApprovalRequestModel } from './model';
import {
  DEV_SAMPLE_APPROVAL_TYPE,
  devSampleApprovalHooks,
  findApprovalType,
  registerCoreApprovalTypes,
  unregisterApprovalType,
} from './registry';
import { activeSystemAdministrators } from './routing';
import { countApprovalsWaiting, decideApproval, getApproval } from './service';

// The development sample type and `pnpm dev:approval` (docs/modules/core.md#approvals, decision
// 109 in docs/BUILD_PLAN.md, docs/TESTING.md#approvals-tests). Made-up data only.

interface Person {
  id: string;
  userId: Types.ObjectId;
  employeeId: Types.ObjectId;
  email: string;
  name: string;
}

let counter = 0;

async function departmentId(code: string): Promise<Types.ObjectId> {
  const found = await DepartmentModel.findOne({ code }, { _id: 1 }).lean();
  if (found) return found._id;
  return (await DepartmentModel.create({ name: `Department ${code}`, code }))._id;
}

async function person(
  firstName: string,
  {
    department = 'NET',
    reportingTo = [],
    admin = false,
  }: { department?: string; reportingTo?: Person[]; admin?: boolean } = {},
): Promise<Person> {
  counter += 1;
  const employee = await EmployeeModel.create({
    employeeNumber: `2024-${String(counter).padStart(2, '0')}`,
    firstName,
    lastName: `Sample${counter}`,
    departmentId: await departmentId(department),
    positionId: new Types.ObjectId(),
    reportingTo: reportingTo.map((supervisor) => supervisor.employeeId),
    employmentStatus: 'Regular',
    dateHired: new Date('2024-01-01T00:00:00+08:00'),
  });
  const email = `sample${counter}@xtreme-works.com`;
  const user = await UserModel.create({
    email,
    passwordHash: 'not-a-real-hash',
    employeeId: employee._id,
    isSystemAdministrator: admin,
  });
  return {
    id: user._id.toHexString(),
    userId: user._id,
    employeeId: employee._id,
    email,
    name: `${firstName} Sample${counter}`,
  };
}

const emailsOf = (recipients: { email: string }[]) => recipients.map((r) => r.email).sort();

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

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('registration', () => {
  it('registers dev.sample only outside production', () => {
    unregisterApprovalType(DEV_SAMPLE_APPROVAL_TYPE);
    vi.stubEnv('NODE_ENV', 'production');
    registerCoreApprovalTypes();
    expect(findApprovalType(DEV_SAMPLE_APPROVAL_TYPE)).toBeNull();

    vi.unstubAllEnvs();
    registerCoreApprovalTypes();
    expect(findApprovalType(DEV_SAMPLE_APPROVAL_TYPE)).toMatchObject({
      module: 'core',
      allowedDecisions: ['approve', 'return', 'reject'],
    });
  });

  it('refuses to run in production', async () => {
    const requester = await person('Ana');
    vi.stubEnv('NODE_ENV', 'production');
    await expect(
      submitDevSampleApproval({ requesterEmail: requester.email, step: 'self' }),
    ).rejects.toThrow(/development only/);
    expect(await ApprovalRequestModel.countDocuments({ requesterUserId: requester.userId })).toBe(
      0,
    );
  });
});

describe('step options', () => {
  it('reads supervisors, board, all:<emails> and self, and refuses anything else', () => {
    expect(parseDevSampleStep('supervisors')).toEqual({ kind: 'supervisors' });
    expect(parseDevSampleStep('board')).toEqual({ kind: 'board' });
    expect(parseDevSampleStep('self')).toEqual({ kind: 'self' });
    expect(
      parseDevSampleStep('all:A@xtreme-works.com, b@xtreme-works.com,a@xtreme-works.com'),
    ).toEqual({
      kind: 'all',
      emails: ['a@xtreme-works.com', 'b@xtreme-works.com'],
    });
    for (const bad of ['', 'all:', 'everyone', 'Board']) {
      expect(() => parseDevSampleStep(bad)).toThrow(ActionError);
    }
  });

  it('reaches every supervisor, and the first approval settles it and notifies the others', async () => {
    const [bea, carlo] = [await person('Bea'), await person('Carlo')];
    const ana = await person('Ana', { reportingTo: [bea, carlo] });
    const onSettled = vi.spyOn(devSampleApprovalHooks, 'onSettled');

    const result = await submitDevSampleApproval({
      requesterEmail: ana.email,
      step: 'supervisors',
    });
    expect(result).toMatchObject({ status: 'pending', routedToSystemAdministrator: false });
    expect(emailsOf(result.recipients)).toEqual([bea.email, carlo.email].sort());
    expect(Object.keys(result.recipients[0] ?? {}).sort()).toEqual(['email', 'name']);

    const detail = await getApproval(
      { id: bea.id, isSystemAdministrator: false },
      result.requestId,
    );
    expect(detail?.steps[0]).toMatchObject({ kind: 'reportingTo', rule: 'any' });
    await decideApproval({ id: bea.id, email: bea.email }, result.requestId, {
      decision: 'approve',
      version: 0,
    });
    expect(onSettled).toHaveBeenCalledTimes(1);
    const settled = await NotificationModel.find({
      'record.id': new Types.ObjectId(result.requestId),
      event: 'core.approvalSettled',
    }).lean();
    expect(settled.map((n) => n.recipientUserId.toHexString())).toEqual([carlo.id]);
    expect(await countApprovalsWaiting(carlo.id)).toBe(0);
  });

  it('sends board to any one Board member but the requester', async () => {
    const [mara, nilo] = [
      await person('Mara', { department: 'BOD' }),
      await person('Nilo', { department: 'BOD' }),
    ];
    const result = await submitDevSampleApproval({ requesterEmail: mara.email, step: 'board' });
    expect(emailsOf(result.recipients)).toEqual([nilo.email]);
    expect((await ApprovalRequestModel.findById(result.requestId).lean())?.steps[0]).toMatchObject({
      kind: 'anyOf',
      rule: 'any',
    });
  });

  it('sends all:<emails> to all of the listed users', async () => {
    const [bea, carlo] = [await person('Bea'), await person('Carlo')];
    const ana = await person('Ana');
    const result = await submitDevSampleApproval({
      requesterEmail: ana.email,
      step: `all:${bea.email},${carlo.email}`,
    });
    expect(emailsOf(result.recipients)).toEqual([bea.email, carlo.email].sort());
    expect((await ApprovalRequestModel.findById(result.requestId).lean())?.steps[0]).toMatchObject({
      kind: 'allOf',
      rule: 'all',
    });
    await expect(
      submitDevSampleApproval({ requesterEmail: ana.email, step: 'all:nobody@xtreme-works.com' }),
    ).rejects.toThrow(/No user has the email nobody@xtreme-works.com/);
  });

  it('sends self to the System Administrators, never to the requester', async () => {
    const admin = await person('Ivo', { admin: true });
    const ana = await person('Ana');
    const result = await submitDevSampleApproval({ requesterEmail: ana.email, step: 'self' });
    expect(result.routedToSystemAdministrator).toBe(true);
    const administrators = (await activeSystemAdministrators()).map((a) => a.email).sort();
    expect(emailsOf(result.recipients)).toEqual(administrators);
    expect(emailsOf(result.recipients)).toContain(admin.email);
    expect(emailsOf(result.recipients)).not.toContain(ana.email);
  });

  it('refuses an unknown requester', async () => {
    await expect(
      submitDevSampleApproval({ requesterEmail: 'nobody@xtreme-works.com', step: 'self' }),
    ).rejects.toThrow(ActionError);
  });
});
