import type { ClientSession, Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { EMPLOYMENT_STATUS, type EmploymentStatus } from '../../account';
import { AccessDeniedError } from '../../actions';
import { type BusinessDate, toBusinessDate } from '../../dates';
import type { ModuleAccessHolder } from '../auth/module-access';
import { hasModuleAccess } from '../auth/module-access';
import { resolveAccountStatus } from '../auth/account-status';
import type { SensitiveSubject } from '../sensitive/registry';
import { DepartmentModel } from '../departments/model';
import { PositionModel } from '../positions/model';
import { toObjectId } from '../paging';
import { UserModel } from '../users/model';
import type { TimesheetType } from '../../timesheet-types';
import { employeeName } from './active-employees';
import { type EmployeeRecord, EmployeeModel } from './model';
import { employeePhotoUrl } from './photo';

// Spec: docs/modules/core.md#people-data-ownership (decision 156 in docs/BUILD_PLAN.md) — the
// identity service other modules read Core's employee identity through, never the models. Pulse
// Talent's employee record is its first caller (build step 2.1).
//
// - `listEmployeeIdentities` and `getEmployeeIdentity` need Talent Read, or the actor's own
//   employee. Without Talent Read the list holds the actor's own identity at most.
// - Separated employees come back only when asked (`separated`) and only with Talent Read.
// - The bootstrap system account has no employee and never appears.
// - Every result is built field by field, from explicit projections. These reads write no audit
//   entry and never feed the directory, whose allowlist is unchanged.

/** Who reads identities: the effective module access and the own employee (a `CurrentUser` fits). */
export interface IdentityActor extends ModuleAccessHolder {
  /** Null for the bootstrap system account. */
  employee: { id: string } | null;
}

/** One employee's Core identity, as other modules see it. Plain values only. */
export interface EmployeeIdentity {
  employeeId: string;
  /** The account's user id; null when the employee has no account. */
  userId: string | null;
  employeeNumber: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  /** The login email; null when the employee has no account. */
  email: string | null;
  /** Null only when the department record is missing. A retired department still shows. */
  department: { id: string; name: string; code: string } | null;
  /** Null only when the position record is missing. A retired position still shows. */
  position: { id: string; name: string; timesheetType: TimesheetType } | null;
  /** The supervisors, in the stored order. A supervisor whose record is missing is left out. */
  reportingTo: { id: string; name: string }[];
  employmentStatus: EmploymentStatus;
  dateHired: BusinessDate;
  separationDate: BusinessDate | null;
  /** True when the employment status is Resigned, Terminated or Retired. */
  separated: boolean;
  /** Whether the account resolves to active (no account counts as inactive). */
  active: boolean;
  /** The current profile photo (`/files/<id>?inline=1`), or null (build step 2.2). */
  photoUrl: string | null;
}

export interface ListEmployeeIdentitiesOptions {
  /** Each word must match the first, middle or last name, or the employee number. */
  q?: string | null;
  departmentId?: string | null;
  status?: EmploymentStatus | null;
  /** Include separated employees. Ignored without Talent Read. */
  separated?: boolean;
  /** Read inside this transaction. */
  session?: ClientSession | null;
}

export interface GetEmployeeIdentityOptions {
  /** Return a separated employee too. Ignored without Talent Read. */
  separated?: boolean;
  /** Read inside this transaction. */
  session?: ClientSession | null;
}

const DENIED = 'You don’t have access to Pulse Talent. Ask HR or the System Administrator.';
const SEARCH_MAX_LENGTH = 100;

const IDENTITY_FIELDS = {
  employeeNumber: 1,
  firstName: 1,
  middleName: 1,
  lastName: 1,
  departmentId: 1,
  positionId: 1,
  reportingTo: 1,
  employmentStatus: 1,
  dateHired: 1,
  separationDate: 1,
  photoFileId: 1,
} as const;

type IdentityRecord = Pick<EmployeeRecord, '_id' | keyof typeof IDENTITY_FIELDS>;

const SORT = { lastName: 1, firstName: 1, _id: 1 } as const;

function isSeparatedStatus(status: string): boolean {
  return EMPLOYMENT_STATUS[status as EmploymentStatus] === 'deactivated';
}

function canReadTalent(actor: IdentityActor): boolean {
  return hasModuleAccess(actor, 'talent', 'read');
}

function wordsOf(q: string | null | undefined): string[] {
  return (q ?? '').trim().slice(0, SEARCH_MAX_LENGTH).toLowerCase().split(/\s+/).filter(Boolean);
}

function matchesWords(employee: IdentityRecord, words: string[]): boolean {
  if (words.length === 0) return true;
  const haystack = [
    employee.firstName,
    employee.middleName ?? '',
    employee.lastName,
    employee.employeeNumber,
  ].map((value) => value.toLowerCase());
  return words.every((word) => haystack.some((value) => value.includes(word)));
}

/** Builds each identity field by field, with its account, department, position and supervisors. */
async function toIdentities(
  employees: IdentityRecord[],
  session: ClientSession | null,
): Promise<EmployeeIdentity[]> {
  if (employees.length === 0) return [];
  const ids = employees.map((employee) => employee._id);
  const supervisorIds = employees.flatMap((employee) => employee.reportingTo);
  const [users, departments, positions, supervisors] = await Promise.all([
    UserModel.find(
      { employeeId: { $in: ids } },
      { employeeId: 1, email: 1, isSystemAccount: 1, systemAccountDisabled: 1 },
    )
      .session(session)
      .lean(),
    DepartmentModel.find(
      { _id: { $in: employees.map((employee) => employee.departmentId) } },
      { name: 1, code: 1 },
      { withDeleted: true },
    )
      .session(session)
      .lean(),
    PositionModel.find(
      { _id: { $in: employees.map((employee) => employee.positionId) } },
      { name: 1, timesheetType: 1 },
      { withDeleted: true },
    )
      .session(session)
      .lean(),
    supervisorIds.length === 0
      ? Promise.resolve([])
      : EmployeeModel.find({ _id: { $in: supervisorIds } }, { firstName: 1, lastName: 1 })
          .session(session)
          .lean(),
  ]);
  const userByEmployee = new Map(
    users.flatMap((user) => (user.employeeId ? [[user.employeeId.toHexString(), user]] : [])),
  );
  const departmentById = new Map(departments.map((d) => [d._id.toHexString(), d]));
  const positionById = new Map(positions.map((p) => [p._id.toHexString(), p]));
  const supervisorById = new Map(supervisors.map((s) => [s._id.toHexString(), s]));

  return employees.flatMap((employee): EmployeeIdentity[] => {
    const hex = employee._id.toHexString();
    const user = userByEmployee.get(hex);
    // An employee linked to the bootstrap system account (which the user model forbids) never shows.
    if (user?.isSystemAccount) return [];
    const department = departmentById.get(employee.departmentId.toHexString());
    const position = positionById.get(employee.positionId.toHexString());
    return [
      {
        employeeId: hex,
        userId: user ? user._id.toHexString() : null,
        employeeNumber: employee.employeeNumber,
        firstName: employee.firstName,
        middleName: employee.middleName ?? null,
        lastName: employee.lastName,
        email: user?.email ?? null,
        department: department
          ? { id: department._id.toHexString(), name: department.name, code: department.code }
          : null,
        position: position
          ? {
              id: position._id.toHexString(),
              name: position.name,
              timesheetType: position.timesheetType,
            }
          : null,
        reportingTo: employee.reportingTo.flatMap((supervisorId) => {
          const supervisor = supervisorById.get(supervisorId.toHexString());
          return supervisor
            ? [{ id: supervisor._id.toHexString(), name: employeeName(supervisor) }]
            : [];
        }),
        employmentStatus: employee.employmentStatus,
        dateHired: toBusinessDate(employee.dateHired),
        separationDate: employee.separationDate ? toBusinessDate(employee.separationDate) : null,
        separated: isSeparatedStatus(employee.employmentStatus),
        active: user !== undefined && resolveAccountStatus(user, employee) === 'active',
        photoUrl: employeePhotoUrl(employee.photoFileId),
      },
    ];
  });
}

/**
 * Employees' identities by last name, then first name, with no paging. With Talent Read: every
 * employee matching the filters, separated ones only with `separated`. Without it: the actor's
 * own identity at most (when it matches the filters). Throws {@link AccessDeniedError} for an
 * actor with neither Talent Read nor an employee.
 */
export async function listEmployeeIdentities(
  actor: IdentityActor,
  {
    q,
    departmentId,
    status,
    separated = false,
    session = null,
  }: ListEmployeeIdentitiesOptions = {},
): Promise<EmployeeIdentity[]> {
  const talentRead = canReadTalent(actor);
  if (!talentRead && !actor.employee) throw new AccessDeniedError(DENIED);

  const filter: Record<string, unknown> = {};
  if (!talentRead) {
    const own = toObjectId(actor.employee?.id);
    if (!own) return [];
    filter._id = own;
  }
  if (departmentId) {
    const id = toObjectId(departmentId);
    if (!id) return [];
    filter.departmentId = id;
  }
  if (status) {
    if (!Object.hasOwn(EMPLOYMENT_STATUS, status)) return [];
    filter.employmentStatus = status;
  }

  await connectDb();
  const employees = await EmployeeModel.find(filter, IDENTITY_FIELDS)
    .sort(SORT)
    .session(session)
    .lean();
  const showSeparated = separated && talentRead;
  const words = wordsOf(q);
  const matching = employees.filter(
    (employee) =>
      (showSeparated || !isSeparatedStatus(employee.employmentStatus)) &&
      matchesWords(employee, words),
  );
  return toIdentities(matching, session);
}

/**
 * One employee's identity, or null when there is none, or they are separated and the actor didn't
 * ask (`separated`) or has no Talent Read. Needs Talent Read, or `employeeId` must be the actor's
 * own employee (whom the actor always gets); anyone else gets {@link AccessDeniedError}.
 */
export async function getEmployeeIdentity(
  actor: IdentityActor,
  employeeId: string,
  { separated = false, session = null }: GetEmployeeIdentityOptions = {},
): Promise<EmployeeIdentity | null> {
  const talentRead = canReadTalent(actor);
  const own = actor.employee !== null && actor.employee.id === employeeId;
  if (!talentRead && !own) throw new AccessDeniedError(DENIED);
  const id = toObjectId(employeeId);
  if (!id) return null;
  await connectDb();
  const employee = await EmployeeModel.findById(id, IDENTITY_FIELDS).session(session).lean();
  if (!employee) return null;
  if (!own && isSeparatedStatus(employee.employmentStatus) && !(separated && talentRead)) {
    return null;
  }
  const [identity] = await toIdentities([employee], session);
  return identity ?? null;
}

/**
 * The employee a sensitive value belongs to, for the reveal rules (SECURITY.md#sensitive-data):
 * the employee id and their current department code, or null when there is no such employee. It
 * takes no actor: `revealSensitiveField` has already checked the user, and the result names no one.
 */
export async function getSensitiveSubject(
  employeeId: string | Types.ObjectId,
  { session = null }: { session?: ClientSession | null } = {},
): Promise<SensitiveSubject | null> {
  const id = toObjectId(employeeId);
  if (!id) return null;
  await connectDb();
  const employee = await EmployeeModel.findById(id, { departmentId: 1 }).session(session).lean();
  if (!employee) return null;
  // A retired department keeps its code, and its members keep its role until they move.
  const department = await DepartmentModel.findById(
    employee.departmentId,
    { code: 1 },
    { withDeleted: true },
  )
    .session(session)
    .lean();
  return { employeeId: employee._id.toHexString(), departmentCode: department?.code ?? null };
}

/**
 * What a module's audit entry label shows for an employee: the employee number and `First Last`,
 * or null when there is no such employee. For audit labels only (a reveal's entry, where there is
 * no actor to check); it returns nothing else.
 */
export async function employeeAuditLabel(
  employeeId: string | Types.ObjectId,
  { session = null }: { session?: ClientSession | null } = {},
): Promise<{ employeeNumber: string; name: string } | null> {
  const id = toObjectId(employeeId);
  if (!id) return null;
  await connectDb();
  const employee = await EmployeeModel.findById(id, {
    employeeNumber: 1,
    firstName: 1,
    lastName: 1,
  })
    .session(session)
    .lean();
  return employee
    ? { employeeNumber: employee.employeeNumber, name: employeeName(employee) }
    : null;
}
