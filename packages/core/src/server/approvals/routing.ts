import type { ClientSession, Types } from 'mongoose';
import { ActionError } from '../../actions';
import type { ApprovalStepKind, ApprovalStepRule, ApprovalWhenEmpty } from '../../approvals';
import { resolveAccountStatus } from '../auth/account-status';
import { ROLE_DEPARTMENT_CODES } from '../auth/roles';
import { DepartmentModel } from '../departments/model';
import { ACTIVE_EMPLOYEES, employeeName } from '../employees/active-employees';
import { EmployeeModel } from '../employees/model';
import { toObjectId } from '../paging';
import { UserModel } from '../users/model';
import type { ApprovalApproverRecord } from './model';
import type { ApprovalStepSpec } from './registry';

// Spec: docs/modules/core.md#approvals and #reporting-lines (decisions 101 and 102 in
// docs/BUILD_PLAN.md) — each step's approvers are worked out once, at submit, and then fixed:
//
// - Only active users count: an inactive or separated person (or one with no account) is left out,
//   as sign-in decides it (SECURITY.md#account-status). The system account counts while enabled.
// - The requester is removed from every set; they never decide their own request.
// - A step whose only approvers were the requester goes to every active System Administrator as
//   an any-one step, marked as routed. In an all-of step that still has others, any one System
//   Administrator fills the requester's place. With no other System Administrator active, the
//   submit is refused.
// - A step left empty for another reason (no one listed, or no one listed active) follows the
//   `whenEmpty` rule: skip it, send it to HR (any one active HR user), or send it to the System
//   Administrator. Without a rule the submit is refused.

/** Someone who can be asked to approve. */
export interface ApproverCandidate {
  userId: Types.ObjectId;
  /** `First Last`, or "System account" for the bootstrap system account. */
  name: string;
  email: string;
}

/** The requester, as routing needs them. */
export interface ApprovalRequester extends ApproverCandidate {
  employeeId: Types.ObjectId | null;
  /** The requester's supervisors (employee ids); empty for the system account. */
  reportingTo: Types.ObjectId[];
}

/** One step with its approvers fixed. */
export interface RoutedStep {
  kind: ApprovalStepKind;
  label: string;
  rule: ApprovalStepRule;
  approvers: ApprovalApproverRecord[];
  routedToSystemAdministrator: boolean;
  /** `skipped` for an empty step skipped by `whenEmpty`; every other step starts `waiting`. */
  status: 'waiting' | 'skipped';
}

/** The name shown for the bootstrap system account, which has no employee. */
export const SYSTEM_ACCOUNT_NAME = 'System account';

export const NO_OTHER_SYSTEM_ADMINISTRATOR =
  'No System Administrator other than you is active to approve this, so it wasn’t submitted. Ask for another active System Administrator first.';
const REQUESTER_INACTIVE = 'Your account is no longer active, so this request wasn’t submitted.';
const NO_ACTIVE_HR =
  'No one in HR is active to approve this, so it wasn’t submitted. Ask the System Administrator.';

function emptyStepMessage(spec: ApprovalStepSpec): string {
  return spec.kind === 'reportingTo'
    ? 'You have no active supervisor to approve this, so it wasn’t submitted. Ask HR to update your reporting line.'
    : `No one active can approve the “${spec.label}” step, so this wasn’t submitted. Ask HR or the System Administrator.`;
}

const ACCOUNT_FIELDS = {
  email: 1,
  employeeId: 1,
  isSystemAccount: 1,
  systemAccountDisabled: 1,
} as const;

/**
 * The active users among those `filter` matches, with their names, in no particular order. One
 * read of the users and one of their employees.
 */
async function activeUsersMatching(
  filter: Record<string, unknown>,
  session: ClientSession | null,
): Promise<ApproverCandidate[]> {
  const users = await UserModel.find(filter, ACCOUNT_FIELDS).session(session).lean();
  const employeeIds = users.flatMap((user) => (user.employeeId ? [user.employeeId] : []));
  const employees = employeeIds.length
    ? await EmployeeModel.find(
        { _id: { $in: employeeIds } },
        { employmentStatus: 1, firstName: 1, lastName: 1 },
      )
        .session(session)
        .lean()
    : [];
  const byId = new Map(employees.map((employee) => [employee._id.toHexString(), employee]));
  const active: ApproverCandidate[] = [];
  for (const user of users) {
    const employee = user.employeeId ? (byId.get(user.employeeId.toHexString()) ?? null) : null;
    if (resolveAccountStatus(user, employee) !== 'active') continue;
    active.push({
      userId: user._id,
      name: employee ? employeeName(employee) : SYSTEM_ACCOUNT_NAME,
      email: user.email,
    });
  }
  return active;
}

const byName = (a: ApproverCandidate, b: ApproverCandidate) =>
  a.name.localeCompare(b.name, 'en') ||
  a.userId.toHexString().localeCompare(b.userId.toHexString());

/** Active users in a department role (`HR`, `BOD`), a retired department included, by name. */
async function activeDepartmentMembers(
  code: string,
  session: ClientSession | null,
): Promise<ApproverCandidate[]> {
  const departments = await DepartmentModel.find({ code }, { _id: 1 }, { withDeleted: true })
    .session(session)
    .lean();
  if (departments.length === 0) return [];
  const employees = await EmployeeModel.find(
    { departmentId: { $in: departments.map((department) => department._id) }, ...ACTIVE_EMPLOYEES },
    { _id: 1 },
  )
    .session(session)
    .lean();
  if (employees.length === 0) return [];
  const members = await activeUsersMatching(
    { employeeId: { $in: employees.map((employee) => employee._id) } },
    session,
  );
  return members.sort(byName);
}

/** Every active Board of Directors member, by name. */
export function activeBoardApprovers(session?: ClientSession | null) {
  return activeDepartmentMembers(ROLE_DEPARTMENT_CODES.board, session ?? null);
}

/** Every active HR user, by name. */
export function activeHrApprovers(session?: ClientSession | null) {
  return activeDepartmentMembers(ROLE_DEPARTMENT_CODES.hr, session ?? null);
}

/** Every active System Administrator, the system account included while enabled, by name. */
export async function activeSystemAdministrators(
  session?: ClientSession | null,
): Promise<ApproverCandidate[]> {
  const administrators = await activeUsersMatching(
    { isSystemAdministrator: true },
    session ?? null,
  );
  return administrators.sort(byName);
}

/** The active users among `ids`, in the order given, each once. */
async function activeUsersIn(
  ids: readonly Types.ObjectId[],
  session: ClientSession | null,
): Promise<ApproverCandidate[]> {
  if (ids.length === 0) return [];
  const found = await activeUsersMatching({ _id: { $in: ids } }, session);
  const byId = new Map(found.map((user) => [user.userId.toHexString(), user]));
  const seen = new Set<string>();
  const ordered: ApproverCandidate[] = [];
  for (const id of ids) {
    const key = id.toHexString();
    const user = byId.get(key);
    if (user && !seen.has(key)) {
      seen.add(key);
      ordered.push(user);
    }
  }
  return ordered;
}

/** The user when their account is active, or null. */
export async function findActiveUser(
  userId: Types.ObjectId | string,
  session: ClientSession | null,
): Promise<ApproverCandidate | null> {
  const id = toObjectId(userId);
  if (!id) return null;
  const [user] = await activeUsersMatching({ _id: id }, session);
  return user ?? null;
}

/** Names for display, by user id (hex): `First Last`, or "System account". Inactive included. */
export async function userNames(
  ids: readonly Types.ObjectId[],
  session: ClientSession | null = null,
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const users = await UserModel.find({ _id: { $in: ids } }, { employeeId: 1, isSystemAccount: 1 })
    .session(session)
    .lean();
  const employeeIds = users.flatMap((user) => (user.employeeId ? [user.employeeId] : []));
  const employees = employeeIds.length
    ? await EmployeeModel.find({ _id: { $in: employeeIds } }, { firstName: 1, lastName: 1 })
        .session(session)
        .lean()
    : [];
  const nameByEmployee = new Map(employees.map((e) => [e._id.toHexString(), employeeName(e)]));
  return new Map(
    users.map((user) => [
      user._id.toHexString(),
      user.isSystemAccount
        ? SYSTEM_ACCOUNT_NAME
        : (nameByEmployee.get(user.employeeId?.toHexString() ?? '') ?? 'Unknown user'),
    ]),
  );
}

/**
 * Loads the requester in the transaction, with their supervisors. Refuses an account that is gone
 * or no longer active.
 */
export async function loadRequester(
  userId: Types.ObjectId | string,
  session: ClientSession | null,
): Promise<ApprovalRequester> {
  const id = toObjectId(userId);
  const user = id ? await UserModel.findById(id, ACCOUNT_FIELDS).session(session).lean() : null;
  const employee = user?.employeeId
    ? await EmployeeModel.findById(user.employeeId, {
        employmentStatus: 1,
        firstName: 1,
        lastName: 1,
        reportingTo: 1,
      })
        .session(session)
        .lean()
    : null;
  if (!user || resolveAccountStatus(user, employee) !== 'active') {
    throw new ActionError(REQUESTER_INACTIVE);
  }
  return {
    userId: user._id,
    name: employee ? employeeName(employee) : SYSTEM_ACCOUNT_NAME,
    email: user.email,
    employeeId: employee?._id ?? null,
    reportingTo: employee?.reportingTo ?? [],
  };
}

/** The active users a step lists, before the requester is taken out. */
async function listedApprovers(
  spec: ApprovalStepSpec,
  requester: ApprovalRequester,
  session: ClientSession | null,
): Promise<ApproverCandidate[]> {
  if (spec.kind === 'reportingTo') {
    if (requester.reportingTo.length === 0) return [];
    // Each supervisor's account, in the order of the reporting line.
    const accounts = await UserModel.find(
      { employeeId: { $in: requester.reportingTo } },
      { employeeId: 1 },
    )
      .session(session)
      .lean();
    const userByEmployee = new Map(
      accounts.map((account) => [account.employeeId?.toHexString(), account._id]),
    );
    const ids = requester.reportingTo.flatMap((employeeId) => {
      const userId = userByEmployee.get(employeeId.toHexString());
      return userId ? [userId] : [];
    });
    return activeUsersIn(ids, session);
  }
  const set = spec.approvers;
  if ('set' in set) {
    return set.set === 'board' ? activeBoardApprovers(session) : activeHrApprovers(session);
  }
  const ids = set.userIds.map((value) => toObjectId(value));
  if (ids.some((value) => value === null)) {
    throw new Error(`The “${spec.label}” step lists an approver that isn’t a user id.`);
  }
  return activeUsersIn(ids as Types.ObjectId[], session);
}

const approver = (candidate: ApproverCandidate, asSystemAdministrator = false) => ({
  userId: candidate.userId,
  nameSnapshot: candidate.name,
  asSystemAdministrator,
});

/** Every active System Administrator but the requester (and `exclude`), or a refusal. */
async function otherSystemAdministrators(
  requester: ApprovalRequester,
  exclude: ReadonlySet<string>,
  session: ClientSession | null,
): Promise<ApproverCandidate[]> {
  const others = (await activeSystemAdministrators(session)).filter(
    (candidate) =>
      !candidate.userId.equals(requester.userId) && !exclude.has(candidate.userId.toHexString()),
  );
  if (others.length === 0) throw new ActionError(NO_OTHER_SYSTEM_ADMINISTRATOR);
  return others;
}

/** The step sent to every active System Administrator but the requester, as an any-one step. */
async function toSystemAdministrators(
  spec: ApprovalStepSpec,
  requester: ApprovalRequester,
  session: ClientSession | null,
): Promise<RoutedStep> {
  const administrators = await otherSystemAdministrators(requester, new Set(), session);
  return {
    kind: spec.kind,
    label: spec.label,
    rule: 'any',
    approvers: administrators.map((candidate) => approver(candidate, true)),
    routedToSystemAdministrator: true,
    status: 'waiting',
  };
}

async function routeStep(
  spec: ApprovalStepSpec,
  typeWhenEmpty: ApprovalWhenEmpty | undefined,
  requester: ApprovalRequester,
  session: ClientSession | null,
): Promise<RoutedStep> {
  const listed = await listedApprovers(spec, requester, session);
  const requesterListed = listed.some((candidate) => candidate.userId.equals(requester.userId));
  const others = listed.filter((candidate) => !candidate.userId.equals(requester.userId));

  if (others.length > 0) {
    if (spec.kind === 'allOf' && requesterListed) {
      // Any one System Administrator, not already one of the set, fills the requester's place.
      const taken = new Set(others.map((candidate) => candidate.userId.toHexString()));
      const fillers = await otherSystemAdministrators(requester, taken, session);
      return {
        kind: spec.kind,
        label: spec.label,
        rule: 'all',
        approvers: [
          ...others.map((candidate) => approver(candidate)),
          ...fillers.map((candidate) => approver(candidate, true)),
        ],
        routedToSystemAdministrator: true,
        status: 'waiting',
      };
    }
    return {
      kind: spec.kind,
      label: spec.label,
      rule: spec.kind === 'allOf' ? 'all' : 'any',
      approvers: others.map((candidate) => approver(candidate)),
      routedToSystemAdministrator: false,
      status: 'waiting',
    };
  }

  // The requester was the step's only (active) approver: never to the requester.
  if (requesterListed) return toSystemAdministrators(spec, requester, session);

  switch (spec.whenEmpty ?? typeWhenEmpty) {
    case 'skip':
      return {
        kind: spec.kind,
        label: spec.label,
        rule: spec.kind === 'allOf' ? 'all' : 'any',
        approvers: [],
        routedToSystemAdministrator: false,
        status: 'skipped',
      };
    case 'hr': {
      const hr = await activeHrApprovers(session);
      const otherHr = hr.filter((candidate) => !candidate.userId.equals(requester.userId));
      if (otherHr.length > 0) {
        return {
          kind: spec.kind,
          label: spec.label,
          rule: 'any',
          approvers: otherHr.map((candidate) => approver(candidate)),
          routedToSystemAdministrator: false,
          status: 'waiting',
        };
      }
      // HR's own request with no one else in HR: to the System Administrator.
      if (hr.length > 0) return toSystemAdministrators(spec, requester, session);
      throw new ActionError(NO_ACTIVE_HR);
    }
    case 'systemAdministrator':
      return toSystemAdministrators(spec, requester, session);
    default:
      throw new ActionError(emptyStepMessage(spec));
  }
}

/**
 * Works out every step's approvers for `requester`, in the caller's transaction. Throws
 * {@link ActionError} with a message for the requester when a step can't be routed.
 */
export async function routeApprovalSteps(
  steps: readonly ApprovalStepSpec[],
  typeWhenEmpty: ApprovalWhenEmpty | undefined,
  requester: ApprovalRequester,
  session: ClientSession | null,
): Promise<RoutedStep[]> {
  const routed: RoutedStep[] = [];
  for (const spec of steps) routed.push(await routeStep(spec, typeWhenEmpty, requester, session));
  return routed;
}
