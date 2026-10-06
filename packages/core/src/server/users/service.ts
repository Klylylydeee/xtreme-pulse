import type { ClientSession, Types } from 'mongoose';
import { connectDb, withTransaction } from '@pulse/db';
import { type AccountStatus, EMPLOYMENT_STATUS, type EmploymentStatus } from '../../account';
import { AccessDeniedError, ActionError } from '../../actions';
import {
  type BusinessDate,
  businessToday,
  businessYear,
  compareBusinessDates,
  now,
  startOfBusinessDate,
  toBusinessDate,
} from '../../dates';
import { parseEmployeeNumber } from '../../employee-number';
import {
  type EmploymentStatusChangeInput,
  employmentStatusChangeSchema,
  isSeparatedStatus,
  SEPARATION_BEFORE_HIRE,
  SEPARATION_IN_FUTURE,
  TERMINATED_UNAVAILABLE,
  type UserCreateInput,
  userCreateSchema,
  type UserUpdateInput,
  userUpdateSchema,
} from '../../user-accounts';
import { checkEmailDomain, claimEmailDomain } from '../allowed-email-domains/service';
import { recordAudit } from '../audit/service';
import { snapshotForAudit, snapshotsForAudit } from '../audit/snapshot';
import { resolveAccountStatus } from '../auth/account-status';
import { activeHrAndSystemAdministrators } from '../auth/admin-recipients';
import { assertAnotherAdministratorStays, reloadActor } from '../auth/administrators';
import { hashPassword } from '../auth/password';
import {
  type AccountTarget,
  canChangeProtectedFieldsOf,
  canEditAccountOf,
  canManageUsers,
  canResetPasswordOf,
} from '../auth/roles';
import { generateTemporaryPasswordFor } from '../auth/temporary-password';
import { DepartmentModel } from '../departments/model';
import { employeeName, inputError, type OrgStructureActor } from '../departments/service';
import {
  claimManualEmployeeNumber,
  EMPLOYEE_NUMBER_FIELD,
  EMPLOYEE_NUMBER_IN_USE_MESSAGE,
  issueEmployeeNumber,
} from '../employee-numbers/service';
import { type EmployeeRecord, EmployeeModel } from '../employees/model';
import { notify } from '../notifications/service';
import { validateAndClaimReportingTo } from '../employees/reporting-lines';
import { claimLiveDepartment, claimLivePosition } from '../org-claims';
import { toObjectId } from '../paging';
import { PositionModel } from '../positions/model';
import { isDuplicateKeyError } from '../seed/duplicate-key';
import { type UserRecord, UserModel } from './model';

// Spec: docs/modules/core.md#managing-user-accounts, SECURITY.md#account--access and decisions
// 31–49 in docs/BUILD_PLAN.md — HR and the System Administrator create and edit user accounts on
// `/admin/users`. Every function checks the actor itself (the page guard isn't enough), and every
// change writes its audit entries in the same transaction: `core.employee` (label
// `<employee number> · <first last>`) and `core.user` (label: the email).
//
// - A new user is never a System Administrator, starts with a temporary password and is active
//   from creation. The temporary password is returned to the actor once and never stored in plain
//   text, logged or put in an entry: only its argon2id hash is kept, and the users schema leaves
//   the hash out of every snapshot (`select: false`).
// - Nobody edits their own row; the system account is read-only. Only another System
//   Administrator changes a System Administrator's email or employment status, or resets their
//   password (auth/roles.ts).
// - Creating a user, changing a department or position, and moving a separated employee back to
//   an active status claim the department and position (org-claims.ts), so an overlapping retire
//   conflicts and is retried.
// - A status change takes effect at once: `loadSessionUser` resolves the new account status on the
//   user's next request. A reset ends all the user's sessions through `sessionsValidFrom`.
// - From step 1.7, creating a user and changing a position notify the other active HR users and
//   System Administrators in the same transaction (decisions 69 and 70), and a System
//   Administrator can disable or enable the system account (decision 75).

const EMPLOYEE_RECORD_TYPE = 'core.employee';
const USER_RECORD_TYPE = 'core.user';

/** A user was created (docs/modules/core.md#user-access-page). */
export const USER_CREATED_EVENT = 'core.userCreated';
/** A user's position changed (docs/modules/core.md#user-access-page). */
export const POSITION_CHANGED_EVENT = 'core.positionChanged';

const USER_GONE = 'This user no longer exists. Reload the page.';
const OWN_ROW = 'You can’t change your own account here. Change your password on Change password.';
const SYSTEM_ACCOUNT_READ_ONLY = 'The system account can’t be edited here.';
const NO_EMPLOYEE =
  'This account has no employee record, so it can’t be edited. Ask the System Administrator.';
const ADMIN_STATUS_ONLY =
  'Only another System Administrator can change a System Administrator’s employment status.';
const OWN_RESET = 'You can’t reset your own password here. Change it on Change password.';
const ADMIN_RESET_ONLY =
  'Only another System Administrator can reset a System Administrator’s password.';
const EMAIL_TAKEN = 'Another user already has this email. Enter a different one.';
const DEPARTMENT_NOT_LIVE = 'Choose a department that isn’t retired.';
const POSITION_NOT_LIVE = 'Choose a position that isn’t retired.';
const POSITION_NOT_IN_DEPARTMENT = 'Choose a position in the chosen department.';
const NUMBER_FIXED = 'An employee number can’t be changed.';

/** `<domain> isn't allowed` on the email field. */
function domainRefused(domain: string | null): ActionError {
  return new ActionError(
    domain
      ? `${domain} isn’t an allowed email domain. Use another email, or ask the System Administrator to allow it.`
      : 'Enter a valid email address.',
    { field: 'email' },
  );
}

/** `<employee number> · <first last>`, for example `2027-01 · Ana Cruz`. */
function employeeLabel(
  employee: Pick<EmployeeRecord, 'employeeNumber' | 'firstName' | 'lastName'>,
) {
  return `${employee.employeeNumber} · ${employeeName(employee)}`;
}

/** Refuses anyone but HR and the System Administrator. */
function assertCanManageUsers(actor: OrgStructureActor): void {
  if (!canManageUsers(actor)) throw new AccessDeniedError();
}

function targetOf(user: Pick<UserRecord, '_id' | 'isSystemAdministrator' | 'isSystemAccount'>) {
  return {
    id: user._id.toHexString(),
    isSystemAdministrator: user.isSystemAdministrator,
    isSystemAccount: user.isSystemAccount,
  } satisfies AccountTarget;
}

/**
 * Refuses an email on a domain that isn't (or is no longer) allowed. Without a session it only
 * reads, for a quick field error before the transaction; with one it claims the domain
 * (`claimEmailDomain`), so a removal of the domain at the same time can't let the email through.
 */
async function assertEmailDomainAllowed(email: string, session?: ClientSession): Promise<void> {
  const check = session ? await claimEmailDomain(email, session) : await checkEmailDomain(email);
  if (!check.allowed) throw domainRefused(check.domain);
}

/** Refuses an email another user already has. The unique index is the final guard. */
async function assertEmailFree(
  email: string,
  exceptId: Types.ObjectId | null,
  session: ClientSession,
): Promise<void> {
  const filter: Record<string, unknown> = { email };
  if (exceptId) filter._id = { $ne: exceptId };
  if (await UserModel.exists(filter).session(session)) {
    throw new ActionError(EMAIL_TAKEN, { field: 'email' });
  }
}

/**
 * Turns a duplicate key on the users' email or the employees' number into its field error, once
 * `withTransaction` has stopped retrying: two creates with the same email or entered number can
 * both pass the up-front checks, and the second insert fails on the unique index.
 */
function rethrowDuplicate(error: unknown): never {
  if (isDuplicateKeyError(error, 'email')) throw new ActionError(EMAIL_TAKEN, { field: 'email' });
  if (isDuplicateKeyError(error, 'employeeNumber')) {
    throw new ActionError(EMPLOYEE_NUMBER_IN_USE_MESSAGE, { field: EMPLOYEE_NUMBER_FIELD });
  }
  throw error;
}

/**
 * Claims a live department and a live position in it, inside the transaction. Each failure is an
 * error on the department or position field, or with `onForm` on the whole form (a status change
 * has no such fields, so its messages say what to change first).
 */
async function claimAssignment(
  departmentId: Types.ObjectId,
  positionId: Types.ObjectId,
  session: ClientSession,
  { onForm = false }: { onForm?: boolean } = {},
): Promise<void> {
  const fail = (message: string, field: string): never => {
    throw new ActionError(message, onForm ? {} : { field });
  };
  // Department first, like positions do: a department retire then conflicts here.
  if (!(await claimLiveDepartment(departmentId, session))) {
    fail(
      onForm
        ? 'This employee’s department is retired. Change their department first, or restore it.'
        : DEPARTMENT_NOT_LIVE,
      'departmentId',
    );
  }
  const position = await claimLivePosition(positionId, session);
  if (!position) {
    fail(
      onForm
        ? 'This employee’s position is retired. Change their position first, or restore it.'
        : POSITION_NOT_LIVE,
      'positionId',
    );
  }
  if (!position?.departmentId.equals(departmentId)) {
    fail(
      onForm
        ? 'This employee’s position isn’t in their department. Change their position first.'
        : POSITION_NOT_IN_DEPARTMENT,
      'positionId',
    );
  }
}

/**
 * Refuses the system account: read-only for a System Administrator, and as if it didn't exist for
 * HR, who never sees it.
 */
function assertNotSystemAccount(
  actor: OrgStructureActor,
  user: Pick<UserRecord, 'isSystemAccount'>,
): void {
  if (!user.isSystemAccount) return;
  if (!actor.isSystemAdministrator) throw new ActionError(USER_GONE);
  throw new AccessDeniedError(SYSTEM_ACCOUNT_READ_ONLY);
}

/** Loads the target user and their employee in the transaction, or refuses. */
async function loadAccount(id: string, session: ClientSession | null) {
  const userId = toObjectId(id);
  if (!userId) throw new ActionError(USER_GONE);
  const user = await UserModel.findById(userId).session(session).lean();
  if (!user) throw new ActionError(USER_GONE);
  const employee = user.employeeId
    ? await EmployeeModel.findById(user.employeeId).session(session).lean()
    : null;
  return { user, employee };
}

/** The user's access sheet on the User access page. */
function accessSheetHref(userId: Types.ObjectId): string {
  return `/admin/access?user=${userId.toHexString()}`;
}

/**
 * Notifies every other active HR user and System Administrator about `userId`, in the caller's
 * transaction, so a failed save sends nothing (docs/modules/core.md#user-access-page, decision
 * 69). The actor goes to the sheet, or sees a "Review access" link, instead; the user themselves
 * (an HR user, or one just added to HR) is never told about their own access.
 */
async function notifyAccessReviewers(
  actor: OrgStructureActor,
  userId: Types.ObjectId,
  { event, title }: { event: string; title: string },
  session: ClientSession,
): Promise<void> {
  const recipients = (await activeHrAndSystemAdministrators(session)).filter(
    (recipient) => recipient.id.toHexString() !== actor.id && !recipient.id.equals(userId),
  );
  if (recipients.length === 0) return;
  await notify(
    {
      recipients: recipients.map((recipient) => recipient.id),
      module: 'core',
      event,
      title,
      href: accessSheetHref(userId),
      record: { type: USER_RECORD_TYPE, id: userId },
    },
    { session },
  );
}

/** True when the two lists hold the same IDs in the same order. */
function sameIds(a: readonly Types.ObjectId[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id.toHexString() === b[index]);
}

// --- Reading ---------------------------------------------------------------------------------

/** Which actions the actor may take on a row (the page shows only these; services check again). */
export interface UserRowActions {
  /** Edit the identity: name, department, position, reporting lines, date hired. */
  edit: boolean;
  /** Change the email (read-only for HR on a System Administrator). */
  changeEmail: boolean;
  /** Change the employment status and separation date (as `changeEmail`). */
  changeEmploymentStatus: boolean;
  resetPassword: boolean;
}

/** One row of the users table. */
export interface UserListRow {
  /** The user ID (the one every function here takes). */
  id: string;
  /** Null for the system account. */
  employeeId: string | null;
  employeeNumber: string | null;
  /** `First Last`; null for the system account, which shows its email instead. */
  name: string | null;
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  email: string;
  departmentId: string | null;
  departmentName: string | null;
  departmentCode: string | null;
  positionId: string | null;
  positionName: string | null;
  /** Null for the system account. */
  employmentStatus: EmploymentStatus | null;
  accountStatus: AccountStatus;
  /** Shows the "Temporary password" badge. */
  mustChangePassword: boolean;
  isSystemAdministrator: boolean;
  isSystemAccount: boolean;
  /** The actor's own row, which is read-only. */
  isSelf: boolean;
  actions: UserRowActions;
}

export interface ListUsersOptions {
  /** Matches the name, employee number or email; every word must match. */
  search?: string | null;
  departmentId?: string | null;
  /** Include separated users (Resigned, Terminated, Retired). Off by default. */
  separated?: boolean;
}

function actionsFor(actor: OrgStructureActor, target: AccountTarget): UserRowActions {
  return {
    edit: canEditAccountOf(actor, target),
    changeEmail: canChangeProtectedFieldsOf(actor, target),
    changeEmploymentStatus: canChangeProtectedFieldsOf(actor, target) && !target.isSystemAccount,
    resetPassword: canResetPasswordOf(actor, target),
  };
}

type UserRow = Pick<
  UserRecord,
  | '_id'
  | 'email'
  | 'mustChangePassword'
  | 'isSystemAdministrator'
  | 'isSystemAccount'
  | 'systemAccountDisabled'
  | 'employeeId'
>;
type EmployeeRow = Pick<
  EmployeeRecord,
  | '_id'
  | 'employeeNumber'
  | 'firstName'
  | 'middleName'
  | 'lastName'
  | 'departmentId'
  | 'positionId'
  | 'employmentStatus'
>;

const USER_ROW_FIELDS = {
  email: 1,
  mustChangePassword: 1,
  isSystemAdministrator: 1,
  isSystemAccount: 1,
  systemAccountDisabled: 1,
  employeeId: 1,
} as const;

/** Builds the rows for `users`, with their employees, departments and positions. */
async function rowsFor(
  actor: OrgStructureActor,
  users: UserRow[],
  session: ClientSession | null = null,
): Promise<{ row: UserListRow; employee: EmployeeRow | null }[]> {
  const employeeIds = users.flatMap((user) => (user.employeeId ? [user.employeeId] : []));
  const employees = await EmployeeModel.find(
    { _id: { $in: employeeIds } },
    {
      employeeNumber: 1,
      firstName: 1,
      middleName: 1,
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
    return {
      employee,
      row: {
        id: target.id,
        employeeId: employee?._id.toHexString() ?? null,
        employeeNumber: employee?.employeeNumber ?? null,
        name: employee ? employeeName(employee) : null,
        firstName: employee?.firstName ?? null,
        middleName: employee?.middleName ?? null,
        lastName: employee?.lastName ?? null,
        email: user.email,
        departmentId: employee?.departmentId.toHexString() ?? null,
        departmentName: department?.name ?? null,
        departmentCode: department?.code ?? null,
        positionId: employee?.positionId.toHexString() ?? null,
        positionName: position?.name ?? null,
        employmentStatus: employee?.employmentStatus ?? null,
        accountStatus: resolveAccountStatus(user, employee),
        mustChangePassword: user.mustChangePassword,
        isSystemAdministrator: user.isSystemAdministrator,
        isSystemAccount: user.isSystemAccount,
        isSelf: target.id === actor.id,
        // An account whose employee record is missing can't be edited, only reset.
        actions: {
          ...actionsFor(actor, target),
          ...(employee || user.isSystemAccount
            ? {}
            : { edit: false, changeEmail: false, changeEmploymentStatus: false }),
        },
      },
    };
  });
}

/**
 * The users table: everyone with an account, by last name, the system account first. HR and the
 * System Administrator only; the system account only for a System Administrator. Separated users
 * (and a disabled system account) only with `separated`. With `departmentId`, only that
 * department's employees. No paging.
 */
export async function listUsers(
  actor: OrgStructureActor,
  { search, departmentId, separated = false }: ListUsersOptions = {},
): Promise<UserListRow[]> {
  assertCanManageUsers(actor);
  await connectDb();

  const filter: Record<string, unknown> = {};
  if (!actor.isSystemAdministrator) filter.isSystemAccount = false;
  const users = await UserModel.find(filter, USER_ROW_FIELDS).lean();
  const rows = (await rowsFor(actor, users)).map(({ row }) => row);

  const words = (search ?? '').trim().slice(0, 100).toLowerCase().split(/\s+/).filter(Boolean);
  return rows
    .filter((row) => separated || row.accountStatus === 'active')
    .filter((row) => !departmentId || row.departmentId === departmentId)
    .filter((row) => {
      if (words.length === 0) return true;
      const haystack = [row.firstName, row.middleName, row.lastName, row.employeeNumber, row.email]
        .filter((value): value is string => Boolean(value))
        .map((value) => value.toLowerCase());
      return words.every((word) => haystack.some((value) => value.includes(word)));
    })
    .sort(
      (a, b) =>
        Number(b.isSystemAccount) - Number(a.isSystemAccount) ||
        (a.lastName ?? '').localeCompare(b.lastName ?? '') ||
        (a.firstName ?? '').localeCompare(b.firstName ?? '') ||
        a.email.localeCompare(b.email),
    );
}

/** A supervisor on the edit sheet. */
export interface SupervisorView {
  /** The employee ID. */
  id: string;
  name: string;
  employeeNumber: string;
  /** Lines to someone who later separated stay; the sheet can mark them. */
  active: boolean;
}

/** One user, for the edit sheet. */
export interface UserDetail extends UserListRow {
  /** Null for the system account. */
  dateHired: BusinessDate | null;
  separationDate: BusinessDate | null;
  /** In the stored order. A supervisor whose record is missing is left out. */
  reportingTo: SupervisorView[];
}

/**
 * One user for the edit sheet, or null when there is no such user (or it is the system account
 * and the actor isn't a System Administrator). HR and the System Administrator only. The actor's
 * own row comes back with every action off.
 */
export async function getUser(actor: OrgStructureActor, id: string): Promise<UserDetail | null> {
  assertCanManageUsers(actor);
  const userId = toObjectId(id);
  if (!userId) return null;
  await connectDb();

  const user = await UserModel.findById(userId, USER_ROW_FIELDS).lean();
  if (!user || (user.isSystemAccount && !actor.isSystemAdministrator)) return null;
  const [entry] = await rowsFor(actor, [user]);
  if (!entry) return null;
  const { row } = entry;
  const employee = user.employeeId
    ? await EmployeeModel.findById(user.employeeId, {
        dateHired: 1,
        separationDate: 1,
        reportingTo: 1,
      }).lean()
    : null;

  let reportingTo: SupervisorView[] = [];
  if (employee && employee.reportingTo.length > 0) {
    const [supervisors, supervisorUsers] = await Promise.all([
      EmployeeModel.find(
        { _id: { $in: employee.reportingTo } },
        { firstName: 1, lastName: 1, employeeNumber: 1, employmentStatus: 1 },
      ).lean(),
      UserModel.find(
        { employeeId: { $in: employee.reportingTo } },
        { employeeId: 1, isSystemAccount: 1, systemAccountDisabled: 1 },
      ).lean(),
    ]);
    const byId = new Map(supervisors.map((s) => [s._id.toHexString(), s]));
    const userByEmployee = new Map(supervisorUsers.map((u) => [u.employeeId?.toHexString(), u]));
    reportingTo = employee.reportingTo.flatMap((supervisorId) => {
      const hex = supervisorId.toHexString();
      const supervisor = byId.get(hex);
      if (!supervisor) return [];
      // Judged like reporting-lines.ts: an employee with no account by employment status alone.
      const account = userByEmployee.get(hex) ?? {
        isSystemAccount: false,
        systemAccountDisabled: false,
      };
      return [
        {
          id: hex,
          name: employeeName(supervisor),
          employeeNumber: supervisor.employeeNumber,
          active: resolveAccountStatus(account, supervisor) === 'active',
        },
      ];
    });
  }

  return {
    ...row,
    dateHired: employee ? toBusinessDate(employee.dateHired) : null,
    separationDate: employee?.separationDate ? toBusinessDate(employee.separationDate) : null,
    reportingTo,
  };
}

// --- Creating --------------------------------------------------------------------------------

/** What a create returns. Show `temporaryPassword` once, in the dialog; it can't be read again. */
export interface CreatedUser {
  /** The user ID. */
  id: string;
  employeeId: string;
  employeeNumber: string;
  temporaryPassword: string;
}

/**
 * Creates a user and their employee in one transaction, with a `create` entry for each. The email
 * must be on an allowed domain and unused; the department and position live, the position in the
 * department; the employee number generated for the Manila year of the date hired, or entered
 * (YYYY-NN, that year, unused). The account starts active, with a temporary password it must
 * change at first sign-in, and is never a System Administrator.
 */
export async function createUser(
  actor: OrgStructureActor,
  input: UserCreateInput,
): Promise<CreatedUser> {
  assertCanManageUsers(actor);
  const parsed = userCreateSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const values = parsed.data;
  const departmentId = toObjectId(values.departmentId);
  if (!departmentId) throw new ActionError(DEPARTMENT_NOT_LIVE, { field: 'departmentId' });
  const positionId = toObjectId(values.positionId);
  if (!positionId) throw new ActionError(POSITION_NOT_LIVE, { field: 'positionId' });
  const actorId = toObjectId(actor.id);
  const dateHired = startOfBusinessDate(values.dateHired);
  const hireYear = businessYear(dateHired);

  await assertEmailDomainAllowed(values.email);
  // Hashed once, before the transaction, so a retried transaction reuses it.
  const temporaryPassword = generateTemporaryPasswordFor(values.email);
  const passwordHash = await hashPassword(temporaryPassword);

  try {
    return await withTransaction(async (session) => {
      await claimAssignment(departmentId, positionId, session);
      await assertEmailDomainAllowed(values.email, session);
      await assertEmailFree(values.email, null, session);
      const { number } =
        values.employeeNumberMode === 'existing' && values.employeeNumber
          ? await claimManualEmployeeNumber(values.employeeNumber, hireYear, session)
          : await issueEmployeeNumber(hireYear, session);
      const reportingTo = await validateAndClaimReportingTo(null, values.reportingTo, session);

      const [employee] = await EmployeeModel.create(
        [
          {
            employeeNumber: number,
            firstName: values.firstName,
            middleName: values.middleName,
            lastName: values.lastName,
            departmentId,
            positionId,
            reportingTo,
            employmentStatus: values.employmentStatus,
            dateHired,
            separationDate: null,
            createdBy: actorId,
            updatedBy: actorId,
          },
        ],
        { session },
      );
      if (!employee) throw new Error('The employee wasn’t created.');
      const [user] = await UserModel.create(
        [
          {
            email: values.email,
            passwordHash,
            mustChangePassword: true,
            isSystemAdministrator: false,
            employeeId: employee._id,
            createdBy: actorId,
            updatedBy: actorId,
          },
        ],
        { session },
      );
      if (!user) throw new Error('The user wasn’t created.');

      await recordAudit(
        {
          actorId: actor.id,
          actorEmail: actor.email,
          module: 'core',
          action: 'create',
          record: { type: EMPLOYEE_RECORD_TYPE, id: employee._id, label: employeeLabel(employee) },
          before: null,
          after: snapshotForAudit(EmployeeModel, employee),
        },
        { session },
      );
      // The hash has `select: false`, so the snapshot leaves it out.
      await recordAudit(
        {
          actorId: actor.id,
          actorEmail: actor.email,
          module: 'core',
          action: 'create',
          record: { type: USER_RECORD_TYPE, id: user._id, label: user.email },
          before: null,
          after: snapshotForAudit(UserModel, user),
        },
        { session },
      );
      // New users start with no access (decision 68): tell the others who set it.
      await notifyAccessReviewers(
        actor,
        user._id,
        {
          event: USER_CREATED_EVENT,
          title: `New user: ${employeeName(employee)} needs access`,
        },
        session,
      );
      return {
        id: user._id.toHexString(),
        employeeId: employee._id.toHexString(),
        employeeNumber: number,
        temporaryPassword,
      };
    });
  } catch (error) {
    rethrowDuplicate(error);
  }
}

// --- Editing ---------------------------------------------------------------------------------

/**
 * Edits a user's name, email, date hired, department, position and reporting lines. The employee
 * number is fixed, and the date hired stays within its year. A new email is checked like on
 * create and doesn't end the user's sessions. A department or position change claims both. New
 * reporting lines are checked in full; removing or reordering supervisors only is accepted as it
 * is, so a line to someone who later separated can stay. Writes an `update` entry for each record
 * that changed; an edit that changes nothing writes nothing.
 */
export async function updateUser(
  actor: OrgStructureActor,
  id: string,
  input: UserUpdateInput,
): Promise<void> {
  assertCanManageUsers(actor);
  const sentNumber = (input as { employeeNumber?: unknown }).employeeNumber;
  const parsed = userUpdateSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const values = parsed.data;
  const departmentId = toObjectId(values.departmentId);
  if (!departmentId) throw new ActionError(DEPARTMENT_NOT_LIVE, { field: 'departmentId' });
  const positionId = toObjectId(values.positionId);
  if (!positionId) throw new ActionError(POSITION_NOT_LIVE, { field: 'positionId' });
  const actorId = toObjectId(actor.id);
  const dateHired = startOfBusinessDate(values.dateHired);

  try {
    await withTransaction(async (session) => {
      const { user, employee } = await loadAccount(id, session);
      const target = targetOf(user);
      if (target.id === actor.id) throw new AccessDeniedError(OWN_ROW);
      assertNotSystemAccount(actor, user);
      if (!canEditAccountOf(actor, target)) throw new AccessDeniedError();
      if (!employee) throw new ActionError(NO_EMPLOYEE);

      if (sentNumber !== undefined && String(sentNumber).trim() !== employee.employeeNumber) {
        throw new ActionError(NUMBER_FIXED, { field: EMPLOYEE_NUMBER_FIELD });
      }

      // HR can't change a System Administrator's email: the field is read-only on the form, so
      // the posted value is ignored, and a stale one (another System Administrator changed the
      // email since the form opened) doesn't refuse an edit to the other fields.
      const email = canChangeProtectedFieldsOf(actor, target) ? values.email : user.email;
      const emailChanged = email !== user.email;
      if (emailChanged) {
        await assertEmailDomainAllowed(email, session);
        await assertEmailFree(email, user._id, session);
      }

      if (dateHired.getTime() !== employee.dateHired.getTime()) {
        const numberYear = parseEmployeeNumber(employee.employeeNumber)?.year;
        if (numberYear !== businessYear(dateHired)) {
          throw new ActionError(
            `The date hired must stay in ${numberYear}, the year of employee number ${employee.employeeNumber}.`,
            { field: 'dateHired' },
          );
        }
        // The employee schema's own check doesn't run on an update.
        if (employee.separationDate && employee.separationDate.getTime() < dateHired.getTime()) {
          throw new ActionError(SEPARATION_BEFORE_HIRE, { field: 'dateHired' });
        }
      }

      if (!departmentId.equals(employee.departmentId) || !positionId.equals(employee.positionId)) {
        await claimAssignment(departmentId, positionId, session);
      }

      let reportingTo = employee.reportingTo;
      if (!sameIds(employee.reportingTo, values.reportingTo)) {
        const kept = new Set(employee.reportingTo.map((supervisor) => supervisor.toHexString()));
        const unique = new Set(values.reportingTo);
        const onlyRemoved =
          unique.size === values.reportingTo.length &&
          values.reportingTo.every((supervisorId) => kept.has(supervisorId));
        // Fewer or reordered supervisors can't form a loop or add anyone inactive.
        reportingTo = onlyRemoved
          ? values.reportingTo.flatMap((supervisorId) => toObjectId(supervisorId) ?? [])
          : await validateAndClaimReportingTo(employee._id, values.reportingTo, session);
      }

      const employeeChanges = {
        firstName: values.firstName,
        middleName: values.middleName,
        lastName: values.lastName,
        dateHired,
        departmentId,
        positionId,
        reportingTo,
      };
      const employeeChanged =
        employee.firstName !== values.firstName ||
        (employee.middleName ?? null) !== values.middleName ||
        employee.lastName !== values.lastName ||
        employee.dateHired.getTime() !== dateHired.getTime() ||
        !employee.departmentId.equals(departmentId) ||
        !employee.positionId.equals(positionId) ||
        !sameIds(
          employee.reportingTo,
          reportingTo.map((supervisor) => supervisor.toHexString()),
        );

      if (employeeChanged) {
        await EmployeeModel.updateOne(
          { _id: employee._id },
          { $set: { ...employeeChanges, updatedBy: actorId } },
          { session, runValidators: true },
        );
        const after = await EmployeeModel.findById(employee._id).session(session).lean().orFail();
        // A move into or out of HR, Accounting or the Board changes the role from the next
        // request (SECURITY.md#roles); the entry shows the department change.
        await recordAudit(
          {
            actorId: actor.id,
            actorEmail: actor.email,
            module: 'core',
            action: 'update',
            record: { type: EMPLOYEE_RECORD_TYPE, id: employee._id, label: employeeLabel(after) },
            ...snapshotsForAudit(EmployeeModel, employee, after),
          },
          { session },
        );
        // Access never follows the position (SECURITY.md#rules): the others are asked to review
        // it (decision 70). Other edits send nothing.
        if (!employee.positionId.equals(positionId)) {
          const position = await PositionModel.findById(positionId, { name: 1 })
            .session(session)
            .lean()
            .orFail();
          await notifyAccessReviewers(
            actor,
            user._id,
            {
              event: POSITION_CHANGED_EVENT,
              title: `Review ${employeeName(after)}’s access: position changed to ${position.name}`,
            },
            session,
          );
        }
      }

      if (emailChanged) {
        // Sessions stay: only a reset sets `sessionsValidFrom`.
        await UserModel.updateOne(
          { _id: user._id },
          { $set: { email, updatedBy: actorId } },
          { session, runValidators: true },
        );
        const after = await UserModel.findById(user._id).session(session).lean().orFail();
        await recordAudit(
          {
            actorId: actor.id,
            actorEmail: actor.email,
            module: 'core',
            action: 'update',
            record: { type: USER_RECORD_TYPE, id: user._id, label: after.email },
            ...snapshotsForAudit(UserModel, user, after),
          },
          { session },
        );
      }
    });
  } catch (error) {
    rethrowDuplicate(error);
  }
}

/**
 * Changes a user's employment status, with the separation date for Resigned and Retired (today or
 * earlier in Manila, not before the date hired). Terminated is refused until termination due
 * process is built. A move back to an active status clears the date and claims the department and
 * position like a new active employee. A change that would leave no active System Administrator
 * is refused. It takes effect at once: the user's next request resolves the new account status.
 */
export async function changeEmploymentStatus(
  actor: OrgStructureActor,
  id: string,
  input: EmploymentStatusChangeInput,
): Promise<void> {
  assertCanManageUsers(actor);
  const parsed = employmentStatusChangeSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const { employmentStatus, separationDate: separationDay } = parsed.data;
  // The schema refuses both already; the service holds the rules itself too.
  if (employmentStatus === 'Terminated') {
    throw new ActionError(TERMINATED_UNAVAILABLE, { field: 'employmentStatus' });
  }
  if (separationDay && compareBusinessDates(separationDay, businessToday()) > 0) {
    throw new ActionError(SEPARATION_IN_FUTURE, { field: 'separationDate' });
  }
  const separationDate = separationDay ? startOfBusinessDate(separationDay) : null;
  const actorId = toObjectId(actor.id);

  await withTransaction(async (session) => {
    const { user, employee } = await loadAccount(id, session);
    const target = targetOf(user);
    if (target.id === actor.id) throw new AccessDeniedError(OWN_ROW);
    assertNotSystemAccount(actor, user);
    if (!canChangeProtectedFieldsOf(actor, target)) throw new AccessDeniedError(ADMIN_STATUS_ONLY);
    if (!employee) throw new ActionError(NO_EMPLOYEE);

    if (
      employee.employmentStatus === employmentStatus &&
      (employee.separationDate?.getTime() ?? null) === (separationDate?.getTime() ?? null)
    ) {
      return;
    }
    if (separationDate && separationDate.getTime() < employee.dateHired.getTime()) {
      throw new ActionError(SEPARATION_BEFORE_HIRE, { field: 'separationDate' });
    }

    const wasActive = EMPLOYMENT_STATUS[employee.employmentStatus] === 'active';
    const willBeActive = !isSeparatedStatus(employmentStatus);
    if (!wasActive && willBeActive) {
      await claimAssignment(employee.departmentId, employee.positionId, session, { onForm: true });
    }
    if (wasActive && !willBeActive && user.isSystemAdministrator) {
      await assertAnotherAdministratorStays(actor, user._id, session);
    }

    await EmployeeModel.updateOne(
      { _id: employee._id },
      { $set: { employmentStatus, separationDate, updatedBy: actorId } },
      { session, runValidators: true },
    );
    const after = await EmployeeModel.findById(employee._id).session(session).lean().orFail();
    await recordAudit(
      {
        actorId: actor.id,
        actorEmail: actor.email,
        module: 'core',
        action: 'update',
        record: { type: EMPLOYEE_RECORD_TYPE, id: employee._id, label: employeeLabel(after) },
        ...snapshotsForAudit(EmployeeModel, employee, after),
      },
      { session },
    );
  });
}

// --- Resetting a password --------------------------------------------------------------------

/**
 * Gives a user a new temporary password, sets `mustChangePassword`, and ends every session they
 * have (`sessionsValidFrom`). Never one's own; a System Administrator's (and the system
 * account's) only by a different System Administrator. Writes one `passwordReset` entry on the
 * `core.user` record, with no password or hash. Show `temporaryPassword` once; it can't be read
 * again.
 */
export async function resetPassword(
  actor: OrgStructureActor,
  id: string,
): Promise<{ temporaryPassword: string }> {
  assertCanManageUsers(actor);
  await connectDb();
  const assertMayReset = (
    user: Pick<UserRecord, '_id' | 'isSystemAdministrator' | 'isSystemAccount'>,
  ) => {
    const target = targetOf(user);
    if (target.id === actor.id) throw new AccessDeniedError(OWN_RESET);
    // HR never sees the system account.
    if (user.isSystemAccount && !actor.isSystemAdministrator) throw new ActionError(USER_GONE);
    if (!canResetPasswordOf(actor, target)) throw new AccessDeniedError(ADMIN_RESET_ONLY);
  };

  // Checked first, so nothing is hashed for a refusal, and again in the transaction.
  const { user: found } = await loadAccount(id, null);
  assertMayReset(found);
  const temporaryPassword = generateTemporaryPasswordFor(found.email);
  const passwordHash = await hashPassword(temporaryPassword);
  const actorId = toObjectId(actor.id);

  await withTransaction(async (session) => {
    const { user: before } = await loadAccount(id, session);
    assertMayReset(before);
    // The temporary password went with the old email; a changed email needs a fresh one.
    if (before.email !== found.email) {
      throw new ActionError('This user’s email just changed. Reload the page and reset again.');
    }
    const changes = {
      mustChangePassword: true,
      sessionsValidFrom: now(),
      updatedBy: actorId,
      updatedAt: now(),
    };
    await UserModel.updateOne(
      { _id: before._id },
      { $set: { ...changes, passwordHash } },
      { session, timestamps: false },
    );
    // Both sides from the records without the hash, which has `select: false` anyway.
    await recordAudit(
      {
        actorId: actor.id,
        actorEmail: actor.email,
        module: 'core',
        action: 'passwordReset',
        record: { type: USER_RECORD_TYPE, id: before._id, label: before.email },
        ...snapshotsForAudit(UserModel, before, { ...before, ...changes }),
      },
      { session },
    );
  });
  return { temporaryPassword };
}

// --- Disabling the system account ------------------------------------------------------------

const ADMIN_ONLY_DISABLE = 'Only a System Administrator can disable or enable the system account.';
const SYSTEM_ACCOUNT_SELF = 'The system account can’t disable or enable itself.';
const NO_SYSTEM_ACCOUNT = 'There is no system account.';

/**
 * Disables or enables the bootstrap system account (`users.systemAccountDisabled`, decision 75).
 * Only a System Administrator, never the system account itself. Disabling goes through the
 * never-zero guard, which also re-checks that the actor is still active (SECURITY.md#account-status).
 * Writes one `update` entry on the `core.user` record; a change to the state it already has writes
 * nothing. A disabled system account is signed out on its next request.
 */
export async function setSystemAccountDisabled(
  actor: OrgStructureActor,
  disabled: boolean,
): Promise<void> {
  if (!actor.isSystemAdministrator) throw new AccessDeniedError(ADMIN_ONLY_DISABLE);
  if (typeof disabled !== 'boolean') throw new ActionError('Choose Disable or Enable.');
  const actorId = toObjectId(actor.id);
  await connectDb();

  await withTransaction(async (session) => {
    const before = await UserModel.findOne({ isSystemAccount: true }).session(session).lean();
    if (!before) throw new ActionError(NO_SYSTEM_ACCOUNT);
    if (before._id.toHexString() === actor.id) throw new AccessDeniedError(SYSTEM_ACCOUNT_SELF);
    if (before.systemAccountDisabled === disabled) return;
    // The actor as they are now: still active and still a System Administrator.
    const current = await reloadActor(actor, session);
    if (!current.isSystemAdministrator) throw new AccessDeniedError(ADMIN_ONLY_DISABLE);
    if (disabled) await assertAnotherAdministratorStays(current, before._id, session);

    const changes = { systemAccountDisabled: disabled, updatedBy: actorId, updatedAt: now() };
    await UserModel.updateOne(
      { _id: before._id },
      { $set: changes },
      { session, timestamps: false },
    );
    await recordAudit(
      {
        actorId: actor.id,
        actorEmail: actor.email,
        module: 'core',
        action: 'update',
        record: { type: USER_RECORD_TYPE, id: before._id, label: before.email },
        ...snapshotsForAudit(UserModel, before, { ...before, ...changes }),
      },
      { session },
    );
  });
}
