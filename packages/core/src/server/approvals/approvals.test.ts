import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { connectDb, withTransaction } from '@pulse/db';
import { AccessDeniedError, ActionError } from '../../actions';
import { EMPLOYMENT_STATUS, type EmploymentStatus } from '../../account';
import { APPROVAL_CHANGED_ELSEWHERE, type ApprovalDecision } from '../../approvals';
import { AuditLogModel } from '../audit/model';
import { DepartmentModel } from '../departments/model';
import { EmployeeModel } from '../employees/model';
import { NotificationModel } from '../notifications/model';
import { notify } from '../notifications/service';
import { UserModel } from '../users/model';
import { ApprovalRequestModel } from './model';
import { activeHrApprovers, activeSystemAdministrators } from './routing';
import {
  type ApprovalStepSpec,
  type ApprovalTypeDefinition,
  ApprovalTypeNotRegisteredError,
  registerApprovalType,
  unregisterApprovalType,
} from './registry';
import {
  type ApprovalSignatureStamp,
  type ApprovalSigner,
  ApprovalSignerNotRegisteredError,
  registerApprovalSigner,
  unregisterApprovalSigner,
} from './signer';
import {
  assertApproverCanView,
  countApprovalsWaiting,
  decideApproval,
  getApproval,
  isApproverFor,
  listApprovalsDecided,
  listApprovalsForRecord,
  listApprovalsWaiting,
  oldestApprovalWaitingSubmittedAt,
  submitApproval,
  type SubmitApprovalInput,
} from './service';

// The approvals engine (docs/modules/core.md#approvals, SECURITY.md#exceptions-to-module-access,
// docs/TESTING.md#approvals-tests). Made-up data only.

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
    // 99 numbers a year: move to the next year after that.
    employeeNumber: `${2024 + Math.floor((counter - 1) / 99)}-${String(((counter - 1) % 99) + 1).padStart(2, '0')}`,
    firstName,
    lastName: `Test${counter}`,
    departmentId: await departmentId(department),
    positionId: new Types.ObjectId(),
    reportingTo: reportingTo.map((supervisor) => supervisor.employeeId),
    employmentStatus: status,
    dateHired: new Date('2024-01-01T00:00:00+08:00'),
    separationDate:
      EMPLOYMENT_STATUS[status] === 'active' ? null : new Date('2024-06-01T00:00:00+08:00'),
  });
  const email = `engine${counter}@xtreme-works.com`;
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
    name: `${firstName} Test${counter}`,
  };
}

const viewer = (p: Person, isSystemAdministrator = false) => ({ id: p.id, isSystemAdministrator });

// --- Types used by the tests -------------------------------------------------------------------

const hooks = {
  onSettled: vi.fn<NonNullable<ApprovalTypeDefinition['onSettled']>>(),
  onStepApproved: vi.fn<NonNullable<ApprovalTypeDefinition['onStepApproved']>>(),
};

function register(
  type: string,
  overrides: Partial<ApprovalTypeDefinition> = {},
): Readonly<ApprovalTypeDefinition> {
  const definition: ApprovalTypeDefinition = {
    module: 'talent',
    label: 'Test request',
    allowedDecisions: ['approve', 'return', 'reject'],
    onSettled: (context) => hooks.onSettled(context),
    onStepApproved: (context) => hooks.onStepApproved(context),
    ...overrides,
  };
  registerApprovalType(type, definition);
  return definition;
}

const SUPERVISOR: ApprovalStepSpec = { kind: 'reportingTo', label: 'Supervisor' };

// The e-signature signer (build step 2.2). A fake stands in for Pulse Talent's: by default it
// finds no signature on file and returns null, so approves are stored unsigned.
const signer = vi.fn<ApprovalSigner>();
const fakeSigner: ApprovalSigner = (context) => signer(context);
const unsigned = async () => null;

/** Submits in a transaction of its own, the way a module's change would. */
function submit(requester: Person, input: Partial<SubmitApprovalInput> = {}) {
  return withTransaction((session) =>
    submitApproval(
      {
        type: 'talent.anyOne',
        record: { type: 'talent.leaveRequest', id: new Types.ObjectId(), label: 'LV-0001' },
        title: 'Leave on 2026-11-02',
        href: '/talent/leave',
        requesterUserId: requester.userId,
        ...input,
      },
      { session },
    ),
  );
}

function decide(
  actor: Person,
  requestId: string,
  decision: ApprovalDecision,
  version: number,
  remarks: string | null = null,
) {
  return decideApproval({ id: actor.id, email: actor.email }, requestId, {
    decision,
    remarks,
    version,
  });
}

async function notificationsFor(requestId: string, event?: string) {
  return NotificationModel.find({
    'record.id': new Types.ObjectId(requestId),
    ...(event ? { event } : {}),
  }).lean();
}

const recipientsOf = (notifications: { recipientUserId: Types.ObjectId }[]) =>
  notifications.map((n) => n.recipientUserId.toHexString()).sort();
const idsOf = (...people: Person[]) => people.map((p) => p.id).sort();

/** Every active System Administrator but `except`, as sorted ids (other tests add some too). */
async function adminIds(...except: Person[]) {
  return (await activeSystemAdministrators())
    .map((a) => a.userId.toHexString())
    .filter((id) => !except.some((p) => p.id === id))
    .sort();
}

/** Every active HR user, as sorted ids. */
async function hrIds() {
  return (await activeHrApprovers()).map((a) => a.userId.toHexString()).sort();
}

async function stored(requestId: string) {
  return ApprovalRequestModel.findById(requestId).lean().orFail();
}

/** Lets the clock move on, so two decisions get different times. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

let admin: Person;

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
  admin = await person('Ivo', { admin: true });
  signer.mockImplementation(unsigned);
  registerApprovalSigner(fakeSigner);
  register('talent.anyOne', { steps: [SUPERVISOR] });
  register('talent.approveReturn', {
    allowedDecisions: ['approve', 'return'],
    steps: [SUPERVISOR],
  });
});

afterEach(() => {
  hooks.onSettled.mockReset();
  hooks.onStepApproved.mockReset();
  signer.mockReset();
  signer.mockImplementation(unsigned);
  vi.unstubAllEnvs();
  registerApprovalSigner(fakeSigner);
});

describe('any-one steps', () => {
  it('reaches every supervisor; the first approval settles it and the others lose the item', async () => {
    const [bea, carlo, dina] = [await person('Bea'), await person('Carlo'), await person('Dina')];
    const ana = await person('Ana', { reportingTo: [bea, carlo, dina] });
    const submitted = await submit(ana);
    expect(submitted.status).toBe('pending');
    expect(submitted.pendingApprovers.map((a) => a.userId).sort()).toEqual(idsOf(bea, carlo, dina));

    const requested = await notificationsFor(submitted.id, 'core.approvalRequested');
    expect(recipientsOf(requested)).toEqual(idsOf(bea, carlo, dina));
    expect(requested[0]).toMatchObject({
      module: 'core',
      href: `/approvals?request=${submitted.id}`,
      title: 'Approval needed: Leave on 2026-11-02',
    });
    for (const approver of [bea, carlo, dina]) {
      expect(await countApprovalsWaiting(approver.id)).toBe(1);
    }

    const result = await decide(carlo, submitted.id, 'approve', 0);
    expect(result).toEqual({ status: 'approved', currentStep: 0, version: 1 });

    const settled = await notificationsFor(submitted.id, 'core.approvalSettled');
    expect(recipientsOf(settled)).toEqual(idsOf(bea, dina));
    expect(settled[0]?.title).toBe(`Settled by ${carlo.name}, no action needed`);
    const outcome = await notificationsFor(submitted.id, 'core.approvalApproved');
    expect(recipientsOf(outcome)).toEqual(idsOf(ana));
    expect(outcome[0]?.title).toBe('Approved: Leave on 2026-11-02');

    for (const approver of [bea, carlo, dina]) {
      expect(await countApprovalsWaiting(approver.id)).toBe(0);
      expect((await listApprovalsWaiting(viewer(approver))).rows).toEqual([]);
      expect((await listApprovalsDecided(viewer(approver))).rows.map((r) => r.id)).toEqual([
        submitted.id,
      ]);
    }
    expect(hooks.onSettled).toHaveBeenCalledTimes(1);
    expect(hooks.onSettled.mock.calls[0]?.[0].request.status).toBe('approved');

    // A later decision by another supervisor is refused and changes nothing.
    await expect(decide(bea, submitted.id, 'reject', 1, 'Too late')).rejects.toThrow(
      `${carlo.name} already settled this request`,
    );
    const request = await stored(submitted.id);
    expect(request.version).toBe(1);
    expect(request.settledBy?.toHexString()).toBe(carlo.id);
    expect(request.steps[0]?.decisions).toHaveLength(1);
  });

  it('lets exactly one of two overlapping decisions win', async () => {
    const [bea, carlo] = [await person('Bea'), await person('Carlo')];
    const ana = await person('Ana', { reportingTo: [bea, carlo] });
    const { id } = await submit(ana);

    const results = await Promise.allSettled([
      decide(bea, id, 'approve', 0),
      decide(carlo, id, 'return', 0, 'Wrong dates'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected');
    expect(refused?.status === 'rejected' && refused.reason).toBeInstanceOf(ActionError);

    const request = await stored(id);
    expect(request.version).toBe(1);
    expect(request.steps[0]?.decisions).toHaveLength(1);
    const updates = await AuditLogModel.countDocuments({
      'record.id': new Types.ObjectId(id),
      action: 'update',
    });
    expect(updates).toBe(1);
    expect(hooks.onSettled).toHaveBeenCalledTimes(1);
  });

  it('refuses a stale form', async () => {
    const [bea, carlo] = [await person('Bea'), await person('Carlo')];
    register('talent.allOfTwo', {
      steps: [{ kind: 'allOf', label: 'Both', approvers: { userIds: [bea.userId, carlo.userId] } }],
    });
    const ana = await person('Ana');
    const { id } = await submit(ana, { type: 'talent.allOfTwo' });
    await decide(bea, id, 'approve', 0);
    await expect(decide(carlo, id, 'approve', 0)).rejects.toThrow(APPROVAL_CHANGED_ELSEWHERE);
    expect((await stored(id)).status).toBe('pending');
  });
});

describe('all-of steps', () => {
  it('needs every approver, in any order', async () => {
    const [md, sd] = [await person('Mara'), await person('Sid')];
    register('fiscal.payment', {
      module: 'fiscal',
      label: 'Payment',
      allowedDecisions: ['approve', 'return'],
      steps: [
        {
          kind: 'allOf',
          label: 'Payment approvers',
          approvers: { userIds: [md.userId, sd.userId] },
        },
      ],
    });
    const ana = await person('Ana');

    for (const order of [
      [md, sd],
      [sd, md],
    ]) {
      const { id } = await submit(ana, {
        type: 'fiscal.payment',
        record: { type: 'fiscal.payment', id: new Types.ObjectId(), label: 'PAY-0001' },
      });
      const [first, second] = order as [Person, Person];
      expect(await decide(first, id, 'approve', 0)).toMatchObject({ status: 'pending' });
      const row = (await listApprovalsWaiting(viewer(second))).rows.find((r) => r.id === id);
      expect(row?.progress).toEqual({ approved: 1, required: 2 });
      expect(await countApprovalsWaiting(first.id)).toBe(0);
      expect(await notificationsFor(id, 'core.approvalSettled')).toHaveLength(0);

      expect(await decide(second, id, 'approve', 1)).toMatchObject({ status: 'approved' });
      expect(recipientsOf(await notificationsFor(id, 'core.approvalApproved'))).toEqual(idsOf(ana));
    }
  });

  it('ends the request on one return', async () => {
    const [md, sd] = [await person('Mara'), await person('Sid')];
    register('fiscal.both', {
      module: 'fiscal',
      steps: [{ kind: 'allOf', label: 'Both', approvers: { userIds: [md.userId, sd.userId] } }],
    });
    const ana = await person('Ana');
    const { id } = await submit(ana, { type: 'fiscal.both' });
    await decide(md, id, 'approve', 0);
    await decide(sd, id, 'reject', 1, 'Duplicate bill');
    const request = await stored(id);
    expect(request.status).toBe('rejected');
    expect(request.pendingApproverIds).toEqual([]);
    const outcome = await notificationsFor(id, 'core.approvalRejected');
    expect(outcome[0]?.body).toContain('Remarks: Duplicate bill');
  });

  it('lets any one System Administrator fill the requester’s place', async () => {
    const md = await person('Mara');
    const otherAdmin = await person('Jo', { admin: true });
    const sd = await person('Sid');
    register('fiscal.self', {
      module: 'fiscal',
      steps: [{ kind: 'allOf', label: 'Both', approvers: { userIds: [md.userId, sd.userId] } }],
    });
    const { id } = await submit(sd, { type: 'fiscal.self' });
    const detail = await getApproval(viewer(admin, true), id);
    const approvers = detail?.steps[0]?.approvers ?? [];
    expect(approvers[0]).toMatchObject({ userId: md.id, asSystemAdministrator: false });
    expect(approvers.slice(1).every((a) => a.asSystemAdministrator)).toBe(true);
    expect(
      approvers
        .slice(1)
        .map((a) => a.userId)
        .sort(),
    ).toEqual(await adminIds(sd));
    expect((await getApproval(viewer(otherAdmin), id))?.sentToYouAsSystemAdministrator).toBe(true);
    expect((await getApproval(viewer(md), id))?.sentToYouAsSystemAdministrator).toBe(false);

    await decide(otherAdmin, id, 'approve', 0);
    expect(recipientsOf(await notificationsFor(id, 'core.approvalSettled'))).toEqual(
      await adminIds(otherAdmin),
    );
    expect(await countApprovalsWaiting(admin.id)).toBe(0);
    expect(await decide(md, id, 'approve', 1)).toMatchObject({ status: 'approved' });
  });
});

describe('several steps', () => {
  it('makes the next step pending and notifies its approvers when one is approved', async () => {
    const bea = await person('Bea');
    const hr = await person('Hana', { department: 'HR' });
    register('talent.timesheet', {
      allowedDecisions: ['approve', 'return'],
      steps: [SUPERVISOR, { kind: 'anyOf', label: 'HR', approvers: { set: 'hr' } }],
    });
    const ana = await person('Ana', { reportingTo: [bea] });
    const { id } = await submit(ana, { type: 'talent.timesheet' });

    expect(
      await isApproverFor(hr.id, 'talent.leaveRequest', (await stored(id)).record.id.toHexString()),
    ).toBe(false);
    expect(await countApprovalsWaiting(hr.id)).toBe(0);

    expect(await decide(bea, id, 'approve', 0, 'Hours check out.')).toMatchObject({
      status: 'pending',
      currentStep: 1,
    });
    expect(hooks.onStepApproved).toHaveBeenCalledTimes(1);
    expect(hooks.onStepApproved.mock.calls[0]?.[0]).toMatchObject({
      stepIndex: 0,
      stepLabel: 'Supervisor',
    });
    expect(hooks.onSettled).not.toHaveBeenCalled();
    expect(recipientsOf(await notificationsFor(id, 'core.approvalRequested'))).toEqual(
      [bea.id, ...(await hrIds())].sort(),
    );
    expect(await countApprovalsWaiting(hr.id)).toBe(1);
    // Bea decided, so the request shows under Decided while HR's step is pending.
    expect((await listApprovalsDecided(viewer(bea))).rows.map((r) => r.id)).toContain(id);

    await expect(decide(bea, id, 'approve', 1)).rejects.toThrow(ActionError);
    expect(await decide(hr, id, 'approve', 1)).toMatchObject({ status: 'approved' });
    expect(hooks.onStepApproved).toHaveBeenCalledTimes(2);
    expect(hooks.onSettled).toHaveBeenCalledTimes(1);
  });

  it('skips a leading empty step, and approves at once when every step is skipped', async () => {
    const hr = await person('Hana', { department: 'HR' });
    register('engage.quote', {
      module: 'engage',
      whenEmpty: 'skip',
      steps: [SUPERVISOR, { kind: 'anyOf', label: 'HR', approvers: { set: 'hr' } }],
    });
    register('engage.skipAll', { module: 'engage', whenEmpty: 'skip', steps: [SUPERVISOR] });
    const ana = await person('Ana');

    const first = await submit(ana, { type: 'engage.quote' });
    expect(first).toMatchObject({ status: 'pending', currentStep: 1 });
    expect(first.pendingApprovers.map((a) => a.userId).sort()).toEqual(await hrIds());
    expect(await hrIds()).toContain(hr.id);
    expect((await stored(first.id)).steps.map((s) => s.status)).toEqual(['skipped', 'pending']);

    const second = await submit(ana, { type: 'engage.skipAll' });
    expect(second).toMatchObject({ status: 'approved', pendingApprovers: [] });
    expect((await stored(second.id)).settledAt).not.toBeNull();
  });
});

describe('decisions', () => {
  it('needs remarks for a return or a rejection', async () => {
    const bea = await person('Bea');
    const ana = await person('Ana', { reportingTo: [bea] });
    const { id } = await submit(ana);
    for (const decision of ['return', 'reject'] as const) {
      await expect(decide(bea, id, decision, 0)).rejects.toMatchObject({
        name: 'ActionError',
        field: 'remarks',
      });
    }
    await decide(bea, id, 'return', 0, 'Wrong dates.');
    const outcome = await notificationsFor(id, 'core.approvalReturned');
    expect(outcome[0]).toMatchObject({ title: 'Returned: Leave on 2026-11-02' });
    expect(outcome[0]?.body).toContain('Remarks: Wrong dates.');
  });

  it('refuses a decision the type doesn’t allow', async () => {
    const bea = await person('Bea');
    const ana = await person('Ana', { reportingTo: [bea] });
    const { id } = await submit(ana, { type: 'talent.approveReturn' });
    await expect(decide(bea, id, 'reject', 0, 'No')).rejects.toThrow(/can’t be rejected/);
    expect((await stored(id)).status).toBe('pending');
  });

  it('refuses anyone but a named approver of the pending step', async () => {
    const bea = await person('Bea');
    const stranger = await person('Zed');
    const ana = await person('Ana', { reportingTo: [bea] });
    const { id } = await submit(ana);
    await expect(decide(stranger, id, 'approve', 0)).rejects.toThrow(/no longer exists/);
    // Its requester and a System Administrator may read it, so they're told they aren't approvers.
    await expect(decide(ana, id, 'approve', 0)).rejects.toThrow(AccessDeniedError);
    await expect(
      decideApproval({ id: admin.id, email: admin.email, isSystemAdministrator: true }, id, {
        decision: 'approve',
        remarks: null,
        version: 0,
      }),
    ).rejects.toThrow(AccessDeniedError);
    expect((await stored(id)).version).toBe(0);
  });

  it('answers someone who may not read a request as if it didn’t exist', async () => {
    const bea = await person('Bea');
    const stranger = await person('Zed');
    const ana = await person('Ana', { reportingTo: [bea] });
    const { id } = await submit(ana);
    const missing = new Types.ObjectId().toHexString();

    const refusal = async (requestId: string) => {
      const error: unknown = await decide(stranger, requestId, 'approve', 0).then(
        () => null,
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(ActionError);
      return { name: (error as Error).name, message: (error as Error).message };
    };
    const forReal = await refusal(id);
    expect(forReal).toEqual(await refusal(missing));
    expect(forReal.message).toMatch(/no longer exists/);
    expect((await stored(id)).version).toBe(0);
  });

  it('refuses an approver whose account is no longer active', async () => {
    const bea = await person('Bea');
    const ana = await person('Ana', { reportingTo: [bea] });
    const { id } = await submit(ana);
    await EmployeeModel.updateOne(
      { _id: bea.employeeId },
      {
        $set: {
          employmentStatus: 'Resigned',
          separationDate: new Date('2026-01-01T00:00:00+08:00'),
        },
      },
    );
    await expect(decide(bea, id, 'approve', 0)).rejects.toThrow(/no longer active/);
  });

  it('refuses submitting an unregistered type, and a submit without the module’s session', async () => {
    const ana = await person('Ana');
    await expect(submit(ana, { type: 'talent.nobody' })).rejects.toThrow(
      ApprovalTypeNotRegisteredError,
    );
    await expect(
      submitApproval(
        {
          type: 'talent.anyOne',
          record: { type: 'talent.leaveRequest', id: new Types.ObjectId(), label: 'LV' },
          title: 'No session',
          href: '/talent',
          requesterUserId: ana.userId,
        },
        undefined as never,
      ),
    ).rejects.toThrow(/session/);
    expect(await ApprovalRequestModel.countDocuments({ requesterUserId: ana.userId })).toBe(0);
  });
});

describe('transactions', () => {
  it('rolls back the decision, its audit entry and its notifications when a hook throws', async () => {
    const bea = await person('Bea');
    const marker = await person('Mark');
    register('talent.failing', {
      steps: [SUPERVISOR],
      onSettled: async ({ session }) => {
        // The module's own write, in the decision's transaction, then a failure.
        await notify(
          {
            recipients: [marker.userId],
            module: 'talent',
            event: 'talent.hookRan',
            title: 'Hook ran',
            href: '/talent',
          },
          { session },
        );
        throw new Error('The module refused.');
      },
    });
    const ana = await person('Ana', { reportingTo: [bea] });
    const { id } = await submit(ana, { type: 'talent.failing' });
    const notificationsBefore = await NotificationModel.countDocuments({});

    await expect(decide(bea, id, 'approve', 0)).rejects.toThrow('The module refused.');
    const request = await stored(id);
    expect(request).toMatchObject({ status: 'pending', version: 0, settledBy: null });
    expect(request.steps[0]?.decisions).toEqual([]);
    expect(
      await AuditLogModel.countDocuments({ 'record.id': new Types.ObjectId(id), action: 'update' }),
    ).toBe(0);
    expect(await NotificationModel.countDocuments({})).toBe(notificationsBefore);
    expect(await NotificationModel.countDocuments({ recipientUserId: marker.userId })).toBe(0);
  });

  it('commits the hook’s writes with the decision', async () => {
    const bea = await person('Bea');
    const marker = await person('Mark');
    register('talent.writing', {
      steps: [SUPERVISOR],
      onSettled: async ({ session, request }) => {
        await notify(
          {
            recipients: [marker.userId],
            module: 'talent',
            event: 'talent.hookRan',
            title: `Hook saw ${request.status}`,
            href: '/talent',
          },
          { session },
        );
      },
    });
    const ana = await person('Ana', { reportingTo: [bea] });
    const { id } = await submit(ana, { type: 'talent.writing' });
    await decide(bea, id, 'approve', 0);
    const marked = await NotificationModel.find({ recipientUserId: marker.userId }).lean();
    expect(marked.map((n) => n.title)).toEqual(['Hook saw approved']);
  });

  it('rolls a submit back with the module’s own transaction', async () => {
    const bea = await person('Bea');
    const ana = await person('Ana', { reportingTo: [bea] });
    const recordId = new Types.ObjectId();
    await expect(
      withTransaction(async (session) => {
        await submitApproval(
          {
            type: 'talent.anyOne',
            record: { type: 'talent.leaveRequest', id: recordId, label: 'LV-9' },
            title: 'Rolled back',
            href: '/talent',
            requesterUserId: ana.userId,
          },
          { session },
        );
        throw new Error('The module’s change failed.');
      }),
    ).rejects.toThrow('The module’s change failed.');
    expect(await ApprovalRequestModel.countDocuments({ 'record.id': recordId })).toBe(0);
    expect(await AuditLogModel.countDocuments({ actorId: ana.userId })).toBe(0);
    expect(await NotificationModel.countDocuments({ recipientUserId: bea.userId })).toBe(0);
  });
});

describe('e-signatures on decisions', () => {
  const stamp = (version: number): ApprovalSignatureStamp => ({
    applicationId: new Types.ObjectId().toHexString(),
    signatureId: new Types.ObjectId().toHexString(),
    version,
  });

  it('signs an approve only, as the approver, in the decision’s transaction', async () => {
    const bea = await person('Bea');
    const ana = await person('Ana', { reportingTo: [bea] });
    const approved = await submit(ana);
    await decide(bea, approved.id, 'approve', 0);
    expect(signer).toHaveBeenCalledTimes(1);
    const context = signer.mock.calls[0]?.[0];
    expect(context).toMatchObject({
      actor: { id: bea.id, email: bea.email },
      target: { type: 'core.approvalRequest', id: approved.id, label: 'Test request · LV-0001' },
      purpose: 'Approval: Test request · LV-0001',
      request: { id: approved.id, status: 'pending' },
      stepIndex: 0,
      stepLabel: 'Supervisor',
    });
    expect(context?.session).toBeDefined();

    signer.mockClear();
    const returned = await submit(ana);
    await decide(bea, returned.id, 'return', 0, 'Fix the dates.');
    const rejected = await submit(ana);
    await decide(bea, rejected.id, 'reject', 0, 'No.');
    expect(signer).not.toHaveBeenCalled();
    for (const id of [returned.id, rejected.id]) {
      expect((await stored(id)).steps[0]?.decisions[0]?.signature).toBeNull();
    }
  });

  it('stores the stamp on the decision, passes it to the hooks and shows its version', async () => {
    const bea = await person('Bea');
    const ana = await person('Ana', { reportingTo: [bea] });
    const signed = stamp(3);
    signer.mockResolvedValue(signed);
    const { id } = await submit(ana);
    await decide(bea, id, 'approve', 0);

    const decision = (await stored(id)).steps[0]?.decisions[0];
    expect(decision?.signature?.applicationId.toHexString()).toBe(signed.applicationId);
    expect(decision?.signature?.signatureId.toHexString()).toBe(signed.signatureId);
    expect(decision?.signature?.version).toBe(3);
    expect(hooks.onStepApproved.mock.calls[0]?.[0].decision.signature).toEqual(signed);
    expect(hooks.onSettled.mock.calls[0]?.[0].decision.signature).toEqual(signed);

    const detail = await getApproval(viewer(ana), id);
    expect(detail?.steps[0]?.approvers[0]?.decision?.signatureVersion).toBe(3);
  });

  it('stores signature null when the approver has no signature on file', async () => {
    const bea = await person('Bea');
    const ana = await person('Ana', { reportingTo: [bea] });
    const { id } = await submit(ana);
    const result = await decide(bea, id, 'approve', 0);
    expect(result.status).toBe('approved');
    expect((await stored(id)).steps[0]?.decisions[0]?.signature).toBeNull();
    expect(hooks.onSettled.mock.calls[0]?.[0].decision.signature).toBeNull();
    const detail = await getApproval(viewer(ana), id);
    expect(detail?.steps[0]?.approvers[0]?.decision?.signatureVersion).toBeNull();
  });

  it('refuses an approve when no signer is registered, and still allows a return', async () => {
    const bea = await person('Bea');
    const ana = await person('Ana', { reportingTo: [bea] });
    const { id } = await submit(ana);
    unregisterApprovalSigner();
    await expect(decide(bea, id, 'approve', 0)).rejects.toThrow(ApprovalSignerNotRegisteredError);
    expect(await stored(id)).toMatchObject({ status: 'pending', version: 0 });
    expect(hooks.onSettled).not.toHaveBeenCalled();

    await decide(bea, id, 'return', 0, 'Fix the dates.');
    expect((await stored(id)).status).toBe('returned');
  });

  it('rolls back the decision, its audit entry and its notifications when the signer throws', async () => {
    const bea = await person('Bea');
    const marker = await person('Mark');
    const ana = await person('Ana', { reportingTo: [bea] });
    const { id } = await submit(ana);
    signer.mockImplementation(async ({ session }) => {
      // The signer's own write, in the decision's transaction, then a failure.
      await notify(
        {
          recipients: [marker.userId],
          module: 'talent',
          event: 'talent.signerRan',
          title: 'Signer ran',
          href: '/talent',
        },
        { session },
      );
      throw new Error('The signature could not be applied.');
    });
    const notificationsBefore = await NotificationModel.countDocuments({});

    await expect(decide(bea, id, 'approve', 0)).rejects.toThrow(
      'The signature could not be applied.',
    );
    const request = await stored(id);
    expect(request).toMatchObject({ status: 'pending', version: 0, settledBy: null });
    expect(request.steps[0]?.decisions).toEqual([]);
    expect(
      await AuditLogModel.countDocuments({ 'record.id': new Types.ObjectId(id), action: 'update' }),
    ).toBe(0);
    expect(await NotificationModel.countDocuments({})).toBe(notificationsBefore);
    expect(hooks.onSettled).not.toHaveBeenCalled();
  });

  it('refuses an invalid stamp', async () => {
    const bea = await person('Bea');
    const ana = await person('Ana', { reportingTo: [bea] });
    const { id } = await submit(ana);
    signer.mockResolvedValue({ ...stamp(1), version: 0 });
    await expect(decide(bea, id, 'approve', 0)).rejects.toThrow(/invalid stamp/);
    signer.mockResolvedValue({ ...stamp(1), signatureId: 'nope' });
    await expect(decide(bea, id, 'approve', 0)).rejects.toThrow(/invalid stamp/);
    expect((await stored(id)).status).toBe('pending');
  });

  it('has one slot: replaced outside production, a different signer throws in production', () => {
    const other: ApprovalSigner = async () => null;
    registerApprovalSigner(other);
    registerApprovalSigner(fakeSigner);
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => registerApprovalSigner(fakeSigner)).not.toThrow();
    expect(() => registerApprovalSigner(other)).toThrow(/already registered/);
  });
});

describe('the requester’s photo', () => {
  it('shows the requester’s current profile photo on the row', async () => {
    const bea = await person('Bea');
    const ana = await person('Ana', { reportingTo: [bea] });
    const { id } = await submit(ana);
    expect((await getApproval(viewer(bea), id))?.requester.photoUrl).toBeNull();
    const photoFileId = new Types.ObjectId();
    await EmployeeModel.updateOne({ _id: ana.employeeId }, { $set: { photoFileId } });
    expect((await getApproval(viewer(bea), id))?.requester.photoUrl).toBe(
      `/files/${photoFileId.toHexString()}?inline=1`,
    );
    const [row] = (await listApprovalsWaiting(viewer(bea))).rows;
    expect(row?.requester.photoUrl).toBe(`/files/${photoFileId.toHexString()}?inline=1`);
  });
});

describe('audit', () => {
  it('writes a create entry on submit and an update entry per decision, with the remarks', async () => {
    const bea = await person('Bea');
    const ana = await person('Ana', { reportingTo: [bea] });
    const { id } = await submit(ana);
    await decide(bea, id, 'return', 0, 'Fix the dates.');

    const entries = await AuditLogModel.find({ 'record.id': new Types.ObjectId(id) })
      .sort({ _id: 1 })
      .lean();
    expect(entries.map((e) => e.action)).toEqual(['create', 'update']);
    expect(entries[0]).toMatchObject({
      module: 'core',
      actorEmail: ana.email,
      record: { type: 'core.approvalRequest', label: 'Test request · LV-0001' },
      before: null,
    });
    expect(entries[1]).toMatchObject({
      module: 'core',
      actorEmail: bea.email,
      reason: 'Fix the dates.',
      before: { status: 'pending' },
      after: { status: 'returned' },
    });
    expect(entries[1]?.actorId?.toHexString()).toBe(bea.id);
  });
});

describe('one pending request per record', () => {
  it('refuses a second pending request, also when two submits overlap', async () => {
    const bea = await person('Bea');
    const ana = await person('Ana', { reportingTo: [bea] });
    const record = { type: 'talent.leaveRequest', id: new Types.ObjectId(), label: 'LV-2' };
    await submit(ana, { record });
    await expect(submit(ana, { record })).rejects.toThrow(/already has a request waiting/);

    const overlapping = { type: 'talent.leaveRequest', id: new Types.ObjectId(), label: 'LV-3' };
    const results = await Promise.allSettled([
      submit(ana, { record: overlapping }),
      submit(ana, { record: overlapping }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      await ApprovalRequestModel.countDocuments({ 'record.id': overlapping.id, status: 'pending' }),
    ).toBe(1);
  });

  it('links a resubmission after a return to the old request and starts from the first step', async () => {
    const bea = await person('Bea');
    const hr = await person('Hana', { department: 'HR' });
    register('talent.twoSteps', {
      steps: [SUPERVISOR, { kind: 'anyOf', label: 'HR', approvers: { set: 'hr' } }],
    });
    const ana = await person('Ana', { reportingTo: [bea] });
    const record = { type: 'talent.timesheet', id: new Types.ObjectId(), label: 'TS-1' };
    const first = await submit(ana, { type: 'talent.twoSteps', record });
    await decide(bea, first.id, 'approve', 0);
    await decide(hr, first.id, 'return', 1, 'Missing Friday.');

    const second = await submit(ana, {
      type: 'talent.twoSteps',
      record,
      previousRequestId: first.id,
    });
    expect(second).toMatchObject({ status: 'pending', currentStep: 0 });
    expect((await stored(second.id)).previousRequestId?.toHexString()).toBe(first.id);
    expect((await stored(first.id)).status).toBe('returned');
    const history = await listApprovalsForRecord(viewer(ana), record.type, record.id.toHexString());
    expect(history.map((h) => h.id)).toEqual([second.id, first.id]);
  });
});

describe('the requester never decides', () => {
  it('sends a self-only step to the System Administrators, never to the requester', async () => {
    const otherAdmin = await person('Jo', { admin: true });
    const ana = await person('Ana');
    register('talent.self', {
      steps: [{ kind: 'anyOf', label: 'Only me', approvers: { userIds: [] } }],
    });
    const { id } = await submit(ana, {
      type: 'talent.self',
      steps: [{ kind: 'anyOf', label: 'Only me', approvers: { userIds: [ana.userId] } }],
    });
    const requested = await notificationsFor(id, 'core.approvalRequested');
    expect(recipientsOf(requested)).toEqual(await adminIds());
    expect(recipientsOf(requested)).toEqual(expect.arrayContaining(idsOf(admin, otherAdmin)));
    expect(recipientsOf(requested)).not.toContain(ana.id);
    expect(requested[0]?.body).toContain('Sent to you as System Administrator');
    const row = (await listApprovalsWaiting(viewer(admin))).rows.find((r) => r.id === id);
    expect(row?.sentToYouAsSystemAdministrator).toBe(true);
    expect(await countApprovalsWaiting(ana.id)).toBe(0);
    await decide(otherAdmin, id, 'approve', 0);
    expect(recipientsOf(await notificationsFor(id, 'core.approvalSettled'))).toEqual(
      await adminIds(otherAdmin),
    );
  });
});

describe('outcome recipients', () => {
  it('sends the outcome to the type’s outcomeRecipients instead of the requester', async () => {
    const bea = await person('Bea');
    const accounting = await person('Acct', { department: 'ACCT' });
    register('fiscal.withRecipients', {
      module: 'fiscal',
      steps: [SUPERVISOR],
      outcomeRecipients: () => [accounting.userId],
    });
    const ana = await person('Ana', { reportingTo: [bea] });
    const { id } = await submit(ana, { type: 'fiscal.withRecipients' });
    await decide(bea, id, 'approve', 0);
    expect(recipientsOf(await notificationsFor(id, 'core.approvalApproved'))).toEqual(
      idsOf(accounting),
    );
  });
});

describe('who sees a request', () => {
  it('shows it to its approvers, its requester and System Administrators only', async () => {
    const bea = await person('Bea');
    const stranger = await person('Zed');
    const ana = await person('Ana', { reportingTo: [bea] });
    const { id } = await submit(ana);

    const forBea = await getApproval(viewer(bea), id);
    expect(forBea).toMatchObject({
      id,
      typeLabel: 'Test request',
      requester: { userId: ana.id, name: ana.name },
      status: 'pending',
      allowedDecisions: ['approve', 'return', 'reject'],
    });
    expect((await getApproval(viewer(ana), id))?.allowedDecisions).toEqual([]);
    expect(await getApproval(viewer(admin, true), id)).not.toBeNull();
    expect(await getApproval(viewer(stranger), id)).toBeNull();
    expect(await getApproval(viewer(bea), new Types.ObjectId().toHexString())).toBeNull();
    expect(await getApproval(viewer(bea), 'not-an-id')).toBeNull();
  });

  it('pages the Waiting list with a cursor', async () => {
    const bea = await person('Bea');
    const ana = await person('Ana', { reportingTo: [bea] });
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) ids.push((await submit(ana)).id);
    const first = await listApprovalsWaiting(viewer(bea), { limit: 2 });
    expect(first.rows).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await listApprovalsWaiting(viewer(bea), { limit: 2, cursor: first.nextCursor });
    expect(second.nextCursor).toBeNull();
    expect([...first.rows, ...second.rows].map((r) => r.id).sort()).toEqual([...ids].sort());
  });
});

describe('the Decided list', () => {
  it('lists a request settled by another approver while a later step is pending', async () => {
    const [bea, carlo] = [await person('Bea'), await person('Carlo')];
    await person('Hana', { department: 'HR' });
    register('talent.supervisorThenHr', {
      steps: [SUPERVISOR, { kind: 'anyOf', label: 'HR', approvers: { set: 'hr' } }],
    });
    const ana = await person('Ana', { reportingTo: [bea, carlo] });
    const { id } = await submit(ana, { type: 'talent.supervisorThenHr' });
    expect((await listApprovalsDecided(viewer(bea))).rows).toEqual([]);

    await decide(carlo, id, 'approve', 0);
    expect(await countApprovalsWaiting(bea.id)).toBe(0);
    expect((await listApprovalsWaiting(viewer(bea))).rows).toEqual([]);
    for (const approver of [bea, carlo]) {
      const rows = (await listApprovalsDecided(viewer(approver))).rows;
      expect(rows.map((r) => r.id)).toEqual([id]);
      // Still pending at HR's step: the row shows where it stands now.
      expect(rows[0]).toMatchObject({
        status: 'pending',
        step: { index: 1, label: 'HR', status: 'pending' },
        sentToYouAsSystemAdministrator: false,
      });
    }
  });

  it('lists a request for a System Administrator whose all-of place another one filled', async () => {
    const md = await person('Mara');
    const sd = await person('Sid');
    const [jo, kim] = [await person('Jo', { admin: true }), await person('Kim', { admin: true })];
    register('fiscal.selfFilled', {
      module: 'fiscal',
      steps: [{ kind: 'allOf', label: 'Both', approvers: { userIds: [md.userId, sd.userId] } }],
    });
    const { id } = await submit(sd, { type: 'fiscal.selfFilled' });
    expect(await countApprovalsWaiting(kim.id)).toBe(1);

    await decide(jo, id, 'approve', 0);
    expect((await stored(id)).status).toBe('pending');
    expect(await countApprovalsWaiting(kim.id)).toBe(0);
    expect((await listApprovalsDecided(viewer(kim))).rows.map((r) => r.id)).toEqual([id]);
    expect((await listApprovalsDecided(viewer(jo))).rows.map((r) => r.id)).toEqual([id]);
    // Mara hasn't decided and her part hasn't ended: Waiting only.
    expect((await listApprovalsWaiting(viewer(md))).rows.map((r) => r.id)).toEqual([id]);
    expect((await listApprovalsDecided(viewer(md))).rows).toEqual([]);
  });

  it('keeps the viewer’s order when another approver decides a request later', async () => {
    const bea = await person('Bea');
    const hana = await person('Hana', { department: 'HR' });
    register('talent.supervisorThenHrOrder', {
      steps: [SUPERVISOR, { kind: 'anyOf', label: 'HR', approvers: { set: 'hr' } }],
    });
    const ana = await person('Ana', { reportingTo: [bea] });
    const first = (await submit(ana, { type: 'talent.supervisorThenHrOrder' })).id;
    const second = (await submit(ana, { type: 'talent.supervisorThenHrOrder' })).id;
    await decide(bea, first, 'approve', 0);
    await tick();
    await decide(bea, second, 'approve', 0);
    const order = async () => (await listApprovalsDecided(viewer(bea))).rows.map((r) => r.id);
    expect(await order()).toEqual([second, first]);

    await tick();
    await decide(hana, first, 'approve', 1);
    expect((await stored(first)).status).toBe('approved');
    expect(await order()).toEqual([second, first]);
    expect((await listApprovalsDecided(viewer(hana))).rows[0]?.id).toBe(first);
  });

  it('breaks ties on the same time by id when paging', async () => {
    const bea = await person('Bea');
    const ana = await person('Ana', { reportingTo: [bea] });
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const { id } = await submit(ana);
      await decide(bea, id, 'approve', 0);
      ids.push(id);
    }
    // The same time for all three, written straight to the collection (the engine never would).
    const same = new Date('2026-10-01T02:00:00Z');
    await ApprovalRequestModel.collection.updateMany(
      { _id: { $in: ids.map((id) => new Types.ObjectId(id)) } },
      { $set: { 'decidedFor.$[mine].decidedAt': same } },
      { arrayFilters: [{ 'mine.userId': bea.userId }] },
    );
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 4; page += 1) {
      const result = await listApprovalsDecided(viewer(bea), { limit: 1, cursor });
      seen.push(...result.rows.map((r) => r.id));
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    expect(cursor).toBeNull();
    expect(seen).toEqual([...ids].reverse());
  });

  it('orders by the viewer’s latest step and lists the request once', async () => {
    const [bea, carlo] = [await person('Bea'), await person('Carlo')];
    register('talent.beaTwice', {
      steps: [
        { kind: 'anyOf', label: 'First look', approvers: { userIds: [bea.userId] } },
        { kind: 'anyOf', label: 'Middle', approvers: { userIds: [carlo.userId] } },
        { kind: 'anyOf', label: 'Last look', approvers: { userIds: [bea.userId] } },
      ],
    });
    const ana = await person('Ana');
    const early = (await submit(ana, { type: 'talent.beaTwice' })).id;
    const later = (await submit(ana, { type: 'talent.beaTwice' })).id;
    const order = async () => (await listApprovalsDecided(viewer(bea))).rows.map((r) => r.id);

    await decide(bea, early, 'approve', 0);
    await tick();
    await decide(bea, later, 'approve', 0);
    await decide(carlo, early, 'approve', 1);
    expect(await order()).toEqual([later, early]);
    // Asked again at the last step: in both segments.
    expect((await listApprovalsWaiting(viewer(bea))).rows.map((r) => r.id)).toEqual([early]);

    await tick();
    await decide(bea, early, 'approve', 2);
    expect((await stored(early)).status).toBe('approved');
    expect(await order()).toEqual([early, later]);
  });

  it('lists an all-of request for the approvers still pending when it is returned', async () => {
    const [md, sd, cy] = [await person('Mara'), await person('Sid'), await person('Cy')];
    register('fiscal.threeReturn', {
      module: 'fiscal',
      steps: [
        {
          kind: 'allOf',
          label: 'All three',
          approvers: { userIds: [md.userId, sd.userId, cy.userId] },
        },
      ],
    });
    const ana = await person('Ana');
    const { id } = await submit(ana, { type: 'fiscal.threeReturn' });
    await decide(md, id, 'return', 0, 'Missing receipt');

    for (const approver of [md, sd, cy]) {
      expect(await countApprovalsWaiting(approver.id)).toBe(0);
      const rows = (await listApprovalsDecided(viewer(approver))).rows;
      expect(rows.map((r) => r.id)).toEqual([id]);
      expect(rows[0]?.status).toBe('returned');
    }
    expect(recipientsOf(await notificationsFor(id, 'core.approvalSettled'))).toEqual(idsOf(sd, cy));
  });

  it('is newest first by when the user’s part ended, and pages with a cursor', async () => {
    const bea = await person('Bea');
    const ana = await person('Ana', { reportingTo: [bea] });
    const [first, second, third] = [
      (await submit(ana)).id,
      (await submit(ana)).id,
      (await submit(ana)).id,
    ];
    await decide(bea, second, 'approve', 0);
    await tick();
    await decide(bea, first, 'return', 0, 'Wrong dates');
    await tick();
    await decide(bea, third, 'approve', 0);

    expect((await listApprovalsDecided(viewer(bea))).rows.map((r) => r.id)).toEqual([
      third,
      first,
      second,
    ]);
    const page1 = await listApprovalsDecided(viewer(bea), { limit: 2 });
    expect(page1.rows.map((r) => r.id)).toEqual([third, first]);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await listApprovalsDecided(viewer(bea), { limit: 2, cursor: page1.nextCursor });
    expect(page2.rows.map((r) => r.id)).toEqual([second]);
    expect(page2.nextCursor).toBeNull();
  });
});

describe('isApproverFor', () => {
  it('holds for current and past approvers, while pending and afterwards', async () => {
    const bea = await person('Bea');
    const carlo = await person('Carlo');
    const stranger = await person('Zed');
    const ana = await person('Ana', { reportingTo: [bea, carlo] });
    const record = { type: 'talent.leaveRequest', id: new Types.ObjectId(), label: 'LV-7' };
    const recordId = record.id.toHexString();
    const { id } = await submit(ana, { record });

    expect(await isApproverFor(bea.id, record.type, recordId)).toBe(true);
    expect(await isApproverFor(stranger.id, record.type, recordId)).toBe(false);
    expect(await isApproverFor(bea.id, 'talent.other', recordId)).toBe(false);
    // A malformed record type is refused before the query, an operator object included.
    for (const malformed of ['', 'talent', 'Talent.leaveRequest', 'talent.leave.request']) {
      expect(await isApproverFor(bea.id, malformed, recordId)).toBe(false);
    }
    expect(await isApproverFor(bea.id, { $exists: true } as unknown as string, recordId)).toBe(
      false,
    );

    await decide(bea, id, 'approve', 0);
    expect(await isApproverFor(bea.id, record.type, recordId)).toBe(true);
    expect(await isApproverFor(carlo.id, record.type, recordId)).toBe(true);

    await expect(assertApproverCanView(viewer(carlo), record.type, recordId)).resolves.toBe(
      undefined,
    );
    await expect(assertApproverCanView(viewer(admin, true), record.type, recordId)).resolves.toBe(
      undefined,
    );
    await expect(assertApproverCanView(viewer(stranger), record.type, recordId)).rejects.toThrow(
      AccessDeniedError,
    );
  });
});

describe('the registry', () => {
  it('refuses a bad name, a type that can’t be approved and an unknown module', () => {
    const base = { module: 'core' as const, label: 'X', allowedDecisions: ['approve'] as const };
    expect(() => registerApprovalType('nodot', { ...base, onSettled: () => {} })).toThrow();
    expect(() =>
      registerApprovalType('core.noApprove', {
        ...base,
        allowedDecisions: ['return'],
        onSettled: () => {},
      }),
    ).toThrow();
    expect(() =>
      registerApprovalType('core.badModule', {
        ...base,
        module: 'nope' as never,
        onSettled: () => {},
      }),
    ).toThrow();
  });

  it('replaces a registration outside production and refuses one in production', () => {
    const base = {
      module: 'core' as const,
      label: 'Once',
      allowedDecisions: ['approve'] as const,
      onSettled: () => {},
    };
    registerApprovalType('core.once', base);
    expect(() => registerApprovalType('core.once', { ...base, label: 'Twice' })).not.toThrow();
    vi.stubEnv('NODE_ENV', 'production');
    try {
      expect(() => registerApprovalType('core.once', base)).toThrow(/already registered/);
    } finally {
      vi.unstubAllEnvs();
      unregisterApprovalType('core.once');
    }
  });

  it('refuses to decide a request whose type is no longer registered', async () => {
    const bea = await person('Bea');
    register('talent.gone', { steps: [SUPERVISOR] });
    const ana = await person('Ana', { reportingTo: [bea] });
    const { id } = await submit(ana, { type: 'talent.gone' });
    unregisterApprovalType('talent.gone');
    await expect(decide(bea, id, 'approve', 0)).rejects.toThrow(ApprovalTypeNotRegisteredError);
    expect((await stored(id)).status).toBe('pending');
  });
});

// The Home "Approvals waiting" tile (docs/modules/core.md#home, docs/TESTING.md#directory-org-chart-and-command-bar-tests).
describe('oldestApprovalWaitingSubmittedAt', () => {
  it('returns the oldest submit date among the requests waiting for the user, and none when nothing waits', async () => {
    const bea = await person('Bea');
    const ana = await person('Ana', { reportingTo: [bea] });
    const cara = await person('Cara', { reportingTo: [bea] });
    expect(await oldestApprovalWaitingSubmittedAt(bea.id)).toBeNull();

    const first = await submit(ana);
    await tick();
    const second = await submit(cara);
    const firstAt = (await stored(first.id)).submittedAt;
    const secondAt = (await stored(second.id)).submittedAt;
    expect(firstAt.getTime()).toBeLessThan(secondAt.getTime());
    expect(await oldestApprovalWaitingSubmittedAt(bea.id)).toEqual(firstAt);

    // Someone else's waiting requests don't count, nor the requester's own.
    expect(await oldestApprovalWaitingSubmittedAt(ana.id)).toBeNull();
    expect(await oldestApprovalWaitingSubmittedAt('not-an-id')).toBeNull();

    // Once the oldest is decided, the next one is the oldest.
    await decide(bea, first.id, 'approve', 0);
    expect(await oldestApprovalWaitingSubmittedAt(bea.id)).toEqual(secondAt);
    await decide(bea, second.id, 'approve', 0);
    expect(await oldestApprovalWaitingSubmittedAt(bea.id)).toBeNull();
  });
});
