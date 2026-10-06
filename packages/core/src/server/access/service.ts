import type { ClientSession } from 'mongoose';
import { connectDb, withTransaction } from '@pulse/db';
import type { AccountStatus } from '../../account';
import { AccessDeniedError, ActionError } from '../../actions';
import { now } from '../../dates';
import { type ModuleAccess, normalizeModuleAccess } from '../../module-access';
import { MODULES, type ModuleKey } from '../../modules';
import {
  ACCESS_CHANGED_ELSEWHERE,
  ACCESS_READ_ONLY_REASONS,
  type AccessReadOnlyReason,
  accessSummary,
  changedModules,
  needsAccess as storedNeedsAccess,
  type UserAccessUpdateInput,
  userAccessUpdateSchema,
} from '../../user-access';
import { recordAudit } from '../audit/service';
import { resolveAccountStatus } from '../auth/account-status';
import { assertAnotherAdministratorStays, reloadActor } from '../auth/administrators';
import { resolveModuleAccess } from '../auth/module-access';
import {
  type AccountTarget,
  canEditAccessOf,
  canManageAccess,
  canToggleSystemAdministrator,
  ROLE_DEPARTMENT_CODES,
  type RoleHolder,
} from '../auth/roles';
import { DepartmentModel } from '../departments/model';
import { employeeName, inputError, type OrgStructureActor } from '../departments/service';
import { EmployeeModel } from '../employees/model';
import { toObjectId } from '../paging';
import { PositionModel } from '../positions/model';
import { type UserRecord, UserModel } from '../users/model';

// Spec: docs/modules/core.md#user-access-page, SECURITY.md#module-access-rwo and
// SECURITY.md#system-administrator — the access rules service behind `/admin/access` (build step
// 1.7, decisions 65–80 in docs/BUILD_PLAN.md). It is the only writer of `users.moduleAccess`.
//
// - HR and the System Administrator, checked by role (decision 54); the role and the actor's
//   active account are checked again inside the save's transaction.
// - Active users only (decision 76). The bootstrap system account shows only to System
//   Administrators, read-only (decision 77); HR never sees it.
// - Read-only for everyone: one's own row, the switch included (decision 80), and the system
//   account. For HR: a System Administrator's row.
// - The System Administrator switch changes only `isSystemAdministrator`, never the stored levels
//   (decision 65). Turning it off goes through the never-zero guard.
// - One `accessChange` entry per changed module, and one for the switch, in the save's
//   transaction (decision 66). `moduleAccessChangedAt` / `moduleAccessChangedBy` are set on every
//   saved change and are the stale-form check (decision 67).
// - "Needs access" (decision 68): an active user who isn't a System Administrator and has None
//   stored on every module, never the system account.

const USER_RECORD_TYPE = 'core.user';

const USER_GONE = 'This user no longer exists. Reload the page.';
const USER_INACTIVE = 'This user is no longer active, so their access can’t be set.';
const SWITCH_ADMIN_ONLY = 'Only a System Administrator can change the System Administrator role.';

// --- Loading -----------------------------------------------------------------------------------

type AccessUser = Pick<
  UserRecord,
  | '_id'
  | 'email'
  | 'isSystemAdministrator'
  | 'isSystemAccount'
  | 'systemAccountDisabled'
  | 'employeeId'
  | 'moduleAccess'
  | 'moduleAccessChangedAt'
  | 'moduleAccessChangedBy'
  | 'createdAt'
>;

const ACCESS_USER_FIELDS = {
  email: 1,
  isSystemAdministrator: 1,
  isSystemAccount: 1,
  systemAccountDisabled: 1,
  employeeId: 1,
  moduleAccess: 1,
  moduleAccessChangedAt: 1,
  moduleAccessChangedBy: 1,
  createdAt: 1,
} as const;

/** One user's access, as the list and the sheet show it. */
export interface UserAccessRow {
  /** The user ID. */
  id: string;
  /** Null for the system account. */
  employeeNumber: string | null;
  /** `First Last`; null for the system account, which shows its email instead. */
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string;
  departmentId: string | null;
  departmentName: string | null;
  positionId: string | null;
  positionName: string | null;
  /** A Board of Directors member: the sheet shows the Insight Read hint (never granted). */
  isBoardMember: boolean;
  isSystemAdministrator: boolean;
  isSystemAccount: boolean;
  /** The actor's own row (read-only). */
  isSelf: boolean;
  /** The stored levels (kept while the switch is on; they apply again once it is off). */
  storedAccess: ModuleAccess;
  /** What the user gets: Owner everywhere (Read on Insight) while a System Administrator. */
  effectiveAccess: ModuleAccess;
  /** The row's chips, from the effective access (`Talent R`, `All modules O`); none for the system account. */
  summary: string[];
  /** In the pinned "Needs access" group. */
  needsAccess: boolean;
  /** When the account was created ("Added <date>"), ISO. */
  createdAt: string;
  /** Why the row is read-only for the actor, or null when they can edit it. */
  readOnlyReason: AccessReadOnlyReason | null;
  /** The sheet's text for {@link readOnlyReason}, or null. */
  readOnlyMessage: string | null;
  /** True when the actor may use the System Administrator switch on this row. */
  canToggleSystemAdministrator: boolean;
}

interface Loaded {
  user: AccessUser;
  row: UserAccessRow;
  accountStatus: AccountStatus;
}

function targetOf(user: Pick<UserRecord, '_id' | 'isSystemAdministrator' | 'isSystemAccount'>) {
  return {
    id: user._id.toHexString(),
    isSystemAdministrator: user.isSystemAdministrator,
    isSystemAccount: user.isSystemAccount,
  } satisfies AccountTarget;
}

/** Why `target` is read-only for `actor`, or null. */
function readOnlyReasonFor(
  actor: OrgStructureActor,
  target: AccountTarget,
): AccessReadOnlyReason | null {
  if (canEditAccessOf(actor, target)) return null;
  if (actor.id === target.id) return 'self';
  if (target.isSystemAccount) return 'systemAccount';
  return 'systemAdministrator';
}

/** True when the stored map is None everywhere and the user isn't a System Administrator. */
function userNeedsAccess(user: AccessUser, accountStatus: AccountStatus): boolean {
  return (
    accountStatus === 'active' &&
    !user.isSystemAccount &&
    !user.isSystemAdministrator &&
    storedNeedsAccess(normalizeModuleAccess(user.moduleAccess))
  );
}

/** Builds the rows for `users`, with their employees, departments and positions. */
async function load(
  actor: OrgStructureActor,
  users: AccessUser[],
  session: ClientSession | null = null,
): Promise<Loaded[]> {
  const employeeIds = users.flatMap((user) => (user.employeeId ? [user.employeeId] : []));
  const employees = await EmployeeModel.find(
    { _id: { $in: employeeIds } },
    {
      employeeNumber: 1,
      firstName: 1,
      lastName: 1,
      departmentId: 1,
      positionId: 1,
      employmentStatus: 1,
    },
  )
    .session(session)
    .lean();
  // Retired departments and positions still show their names.
  const departments = await DepartmentModel.find(
    { _id: { $in: employees.map((employee) => employee.departmentId) } },
    { name: 1, code: 1 },
    { withDeleted: true },
  )
    .session(session)
    .lean();
  const positions = await PositionModel.find(
    { _id: { $in: employees.map((employee) => employee.positionId) } },
    { name: 1 },
    { withDeleted: true },
  )
    .session(session)
    .lean();
  const employeeById = new Map(employees.map((e) => [e._id.toHexString(), e]));
  const departmentById = new Map(departments.map((d) => [d._id.toHexString(), d]));
  const positionById = new Map(positions.map((p) => [p._id.toHexString(), p]));

  return users.map((user) => {
    const employee = user.employeeId
      ? (employeeById.get(user.employeeId.toHexString()) ?? null)
      : null;
    const department = employee ? departmentById.get(employee.departmentId.toHexString()) : null;
    const position = employee ? positionById.get(employee.positionId.toHexString()) : null;
    const target = targetOf(user);
    const accountStatus = resolveAccountStatus(user, employee);
    const effectiveAccess = resolveModuleAccess(user);
    const readOnlyReason = readOnlyReasonFor(actor, target);
    return {
      user,
      accountStatus,
      row: {
        id: target.id,
        employeeNumber: employee?.employeeNumber ?? null,
        name: employee ? employeeName(employee) : null,
        firstName: employee?.firstName ?? null,
        lastName: employee?.lastName ?? null,
        email: user.email,
        departmentId: employee?.departmentId.toHexString() ?? null,
        departmentName: department?.name ?? null,
        positionId: employee?.positionId.toHexString() ?? null,
        positionName: position?.name ?? null,
        isBoardMember: !user.isSystemAccount && department?.code === ROLE_DEPARTMENT_CODES.board,
        isSystemAdministrator: user.isSystemAdministrator,
        isSystemAccount: user.isSystemAccount,
        isSelf: target.id === actor.id,
        storedAccess: normalizeModuleAccess(user.moduleAccess),
        effectiveAccess,
        summary: user.isSystemAccount ? [] : accessSummary(effectiveAccess),
        needsAccess: userNeedsAccess(user, accountStatus),
        createdAt: user.createdAt.toISOString(),
        readOnlyReason,
        readOnlyMessage: readOnlyReason ? ACCESS_READ_ONLY_REASONS[readOnlyReason] : null,
        canToggleSystemAdministrator: canToggleSystemAdministrator(actor, target),
      },
    };
  });
}

/** Every active user the actor may see on the page (the system account for a System Administrator only). */
async function loadActive(actor: OrgStructureActor): Promise<Loaded[]> {
  const filter: Record<string, unknown> = {};
  if (!actor.isSystemAdministrator) filter.isSystemAccount = false;
  const users = await UserModel.find(filter, ACCESS_USER_FIELDS).lean();
  return (await load(actor, users)).filter((entry) => entry.accountStatus === 'active');
}

/** Refuses anyone but HR and the System Administrator. */
function assertCanManageAccess(actor: RoleHolder): void {
  if (!canManageAccess(actor)) throw new AccessDeniedError();
}

// --- Reading -----------------------------------------------------------------------------------

export interface ListUserAccessOptions {
  /** Matches the name and the employee number; every word must match (decision 79). */
  search?: string | null;
  departmentId?: string | null;
  positionId?: string | null;
}

/** The stat tiles above the list: over every active user, not the filtered list. */
export interface UserAccessStats {
  /** Active users, the system account left out ("of 21"). */
  activeUsers: number;
  /** Of those, how many can open at least one module, System Administrators included ("18"). */
  withAccess: number;
  /** How many of those can at least read each module. */
  perModule: Record<ModuleKey, number>;
}

export interface UserAccessList {
  /** The pinned "Needs access" group, newest first (filters and search applied). */
  needsAccess: UserAccessRow[];
  /** Everyone else: the system account first, then by last name (filters and search applied). */
  others: UserAccessRow[];
  /** The unfiltered "Needs access" count, the same as the sidebar badge. */
  needsAccessCount: number;
  stats: UserAccessStats;
}

/**
 * The User access page's list: active users only, with search (name and employee number) and the
 * department and position filters. HR and the System Administrator only.
 */
export async function listUserAccess(
  actor: OrgStructureActor,
  { search, departmentId, positionId }: ListUserAccessOptions = {},
): Promise<UserAccessList> {
  assertCanManageAccess(actor);
  await connectDb();
  const rows = (await loadActive(actor)).map((entry) => entry.row);

  const people = rows.filter((row) => !row.isSystemAccount);
  const perModule = Object.fromEntries(MODULES.map((module) => [module, 0])) as Record<
    ModuleKey,
    number
  >;
  let withAccess = 0;
  for (const row of people) {
    const readable = MODULES.filter((module) => row.effectiveAccess[module] !== 'none');
    if (readable.length > 0) withAccess += 1;
    for (const module of readable) perModule[module] += 1;
  }
  const stats = { activeUsers: people.length, withAccess, perModule };
  const needsAccessCount = rows.filter((row) => row.needsAccess).length;

  const words = (search ?? '').trim().slice(0, 100).toLowerCase().split(/\s+/).filter(Boolean);
  const shown = rows
    .filter((row) => !departmentId || row.departmentId === departmentId)
    .filter((row) => !positionId || row.positionId === positionId)
    .filter((row) => {
      if (words.length === 0) return true;
      const haystack = [row.firstName, row.lastName, row.employeeNumber]
        .filter((value): value is string => Boolean(value))
        .map((value) => value.toLowerCase());
      return words.every((word) => haystack.some((value) => value.includes(word)));
    });

  return {
    needsAccess: shown
      .filter((row) => row.needsAccess)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)),
    others: shown
      .filter((row) => !row.needsAccess)
      .sort(
        (a, b) =>
          Number(b.isSystemAccount) - Number(a.isSystemAccount) ||
          (a.lastName ?? '').localeCompare(b.lastName ?? '') ||
          (a.firstName ?? '').localeCompare(b.firstName ?? '') ||
          a.email.localeCompare(b.email),
      ),
    needsAccessCount,
    stats,
  };
}

/** One user's access, for the sheet. */
export interface UserAccessDetail extends UserAccessRow {
  /**
   * `moduleAccessChangedAt` as ISO, or null when never changed. The sheet sends it back as
   * `expectedChangedAt` with the save (the stale-form check).
   */
  changedAt: string | null;
  /** Who made that change: their name, else their email; null when never changed or unknown. */
  changedByName: string | null;
}

/**
 * One active user's access for the sheet, or null when there is no such active user (or it is
 * the system account and the actor isn't a System Administrator). HR and the System
 * Administrator only.
 */
export async function getUserAccess(
  actor: OrgStructureActor,
  id: string,
): Promise<UserAccessDetail | null> {
  assertCanManageAccess(actor);
  const userId = toObjectId(id);
  if (!userId) return null;
  await connectDb();

  const user = await UserModel.findById(userId, ACCESS_USER_FIELDS).lean();
  if (!user || (user.isSystemAccount && !actor.isSystemAdministrator)) return null;
  const [entry] = await load(actor, [user]);
  if (!entry || entry.accountStatus !== 'active') return null;

  let changedByName: string | null = null;
  if (user.moduleAccessChangedBy) {
    const changer = await UserModel.findById(user.moduleAccessChangedBy, {
      email: 1,
      employeeId: 1,
    }).lean();
    if (changer) {
      const changerEmployee = changer.employeeId
        ? await EmployeeModel.findById(changer.employeeId, { firstName: 1, lastName: 1 }).lean()
        : null;
      changedByName = changerEmployee ? employeeName(changerEmployee) : changer.email;
    }
  }

  return {
    ...entry.row,
    changedAt: user.moduleAccessChangedAt ? user.moduleAccessChangedAt.toISOString() : null,
    changedByName,
  };
}

/**
 * How many users need access (decision 68), with no role check: for the daily reminder job.
 * Pages use {@link countUsersNeedingAccessFor}.
 */
export async function countUsersNeedingAccess(): Promise<number> {
  await connectDb();
  const users = await UserModel.find(
    { isSystemAccount: false, isSystemAdministrator: false },
    ACCESS_USER_FIELDS,
  ).lean();
  const candidates = users.filter((user) =>
    storedNeedsAccess(normalizeModuleAccess(user.moduleAccess)),
  );
  if (candidates.length === 0) return 0;
  const employees = await EmployeeModel.find(
    { _id: { $in: candidates.flatMap((user) => (user.employeeId ? [user.employeeId] : [])) } },
    { employmentStatus: 1 },
  ).lean();
  const byId = new Map(employees.map((e) => [e._id.toHexString(), e]));
  return candidates.filter(
    (user) =>
      resolveAccountStatus(
        user,
        user.employeeId ? (byId.get(user.employeeId.toHexString()) ?? null) : null,
      ) === 'active',
  ).length;
}

/**
 * The sidebar badge and `/admin` card count: the users who need access, for HR and the System
 * Administrator; null for anyone else (they get no count).
 */
export async function countUsersNeedingAccessFor(actor: RoleHolder): Promise<number | null> {
  if (!canManageAccess(actor)) return null;
  return countUsersNeedingAccess();
}

// --- Saving ------------------------------------------------------------------------------------

/** What a save did. */
export interface SaveUserAccessResult {
  /** The modules whose stored level changed, in {@link MODULES} order. */
  changedModules: ModuleKey[];
  /** True when the System Administrator switch changed. */
  systemAdministratorChanged: boolean;
  /** The new `moduleAccessChangedAt` (ISO), or the old one when nothing changed. */
  changedAt: string | null;
}

/** Same moment, null included. */
function sameTime(stored: Date | null | undefined, expected: string | null): boolean {
  if (!stored) return expected === null;
  return expected !== null && new Date(expected).getTime() === stored.getTime();
}

/**
 * Saves the sheet in one transaction: every changed module level, and (System Administrator only)
 * the switch. Refuses the actor's own row, the system account, an inactive user, HR on a System
 * Administrator, and a stale sheet (`expectedChangedAt` older than the stored change). While the
 * user is or becomes a System Administrator the rows are locked, so the sent levels are ignored
 * and the stored ones kept (decision 65). Writes one `accessChange` entry per changed module and
 * one for the switch; a save that changes nothing writes nothing.
 */
export async function saveUserAccess(
  actor: OrgStructureActor,
  input: UserAccessUpdateInput,
): Promise<SaveUserAccessResult> {
  assertCanManageAccess(actor);
  const parsed = userAccessUpdateSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const values = parsed.data;
  const userId = toObjectId(values.id);
  if (!userId) throw new ActionError(USER_GONE);
  const actorId = toObjectId(actor.id);
  await connectDb();

  return withTransaction(async (session) => {
    // The actor as they are now: still active, and still HR or a System Administrator.
    const current = await reloadActor(actor, session);
    assertCanManageAccess(current);

    const user = await UserModel.findById(userId, ACCESS_USER_FIELDS).session(session).lean();
    if (!user) throw new ActionError(USER_GONE);
    if (user.isSystemAccount && !current.isSystemAdministrator) throw new ActionError(USER_GONE);
    const target = targetOf(user);
    if (!canEditAccessOf(current, target)) {
      const reason = readOnlyReasonFor(current, target) ?? 'systemAdministrator';
      throw new AccessDeniedError(ACCESS_READ_ONLY_REASONS[reason]);
    }
    const employee = user.employeeId
      ? await EmployeeModel.findById(user.employeeId, { employmentStatus: 1 })
          .session(session)
          .lean()
      : null;
    if (resolveAccountStatus(user, employee) !== 'active') throw new ActionError(USER_INACTIVE);
    if (!sameTime(user.moduleAccessChangedAt, values.expectedChangedAt)) {
      throw new ActionError(ACCESS_CHANGED_ELSEWHERE);
    }

    // The switch.
    const wasAdministrator = user.isSystemAdministrator;
    const willBeAdministrator = values.isSystemAdministrator ?? wasAdministrator;
    const switchChanged = willBeAdministrator !== wasAdministrator;
    if (switchChanged) {
      if (!canToggleSystemAdministrator(current, target)) {
        throw new AccessDeniedError(SWITCH_ADMIN_ONLY);
      }
      if (!willBeAdministrator) await assertAnotherAdministratorStays(current, user._id, session);
    }

    // The levels, only while the rows aren't locked.
    const before = normalizeModuleAccess(user.moduleAccess);
    const locked = wasAdministrator || willBeAdministrator;
    const after = locked ? before : values.moduleAccess;
    const modules = changedModules(before, after);

    if (modules.length === 0 && !switchChanged) {
      return {
        changedModules: [],
        systemAdministratorChanged: false,
        changedAt: user.moduleAccessChangedAt?.toISOString() ?? null,
      };
    }

    const at = now();
    const set: Record<string, unknown> = {
      moduleAccessChangedAt: at,
      moduleAccessChangedBy: actorId,
      updatedBy: actorId,
      updatedAt: at,
    };
    for (const module of modules) set[`moduleAccess.${module}`] = after[module];
    if (switchChanged) set.isSystemAdministrator = willBeAdministrator;
    await UserModel.updateOne(
      { _id: user._id },
      { $set: set },
      { session, runValidators: true, timestamps: false },
    );

    const entry = {
      actorId: current.id,
      actorEmail: current.email,
      module: 'core',
      action: 'accessChange',
      record: { type: USER_RECORD_TYPE, id: user._id, label: user.email },
    } as const;
    if (switchChanged) {
      await recordAudit(
        {
          ...entry,
          before: { isSystemAdministrator: wasAdministrator },
          after: { isSystemAdministrator: willBeAdministrator },
        },
        { session },
      );
    }
    for (const module of modules) {
      await recordAudit(
        {
          ...entry,
          before: { moduleAccess: { [module]: before[module] } },
          after: { moduleAccess: { [module]: after[module] } },
        },
        { session },
      );
    }

    return {
      changedModules: modules,
      systemAdministratorChanged: switchChanged,
      changedAt: at.toISOString(),
    };
  });
}
