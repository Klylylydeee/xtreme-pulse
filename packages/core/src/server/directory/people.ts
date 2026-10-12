import type { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { type DirectoryPersonLink, initialsOf } from '../../directory';
import { resolveAccountStatus } from '../auth/account-status';
import { DepartmentModel } from '../departments/model';
import { employeeName } from '../employees/active-employees';
import { type EmployeeRecord, EmployeeModel } from '../employees/model';
import { employeePhotoUrl } from '../employees/photo';
import { PositionModel } from '../positions/model';
import { UserModel } from '../users/model';

// Spec: SECURITY.md#sensitive-data ("Directory fields are an allowlist", decision 134 in
// docs/BUILD_PLAN.md) — the directory, the org chart, the command bar's people results and the
// Home team tile read people through here. Every query uses an explicit projection, and every
// result is built field by field (the photo only as its file route URL): the employment status is read only to resolve the account
// status (SECURITY.md#account-status) and never leaves this file; the date hired, separation date,
// module access and password hash are never read at all.

/** The employee fields the directory reads. */
export const PERSON_FIELDS = {
  employeeNumber: 1,
  firstName: 1,
  lastName: 1,
  departmentId: 1,
  positionId: 1,
  reportingTo: 1,
  employmentStatus: 1,
  photoFileId: 1,
} as const;

export type PersonRecord = Pick<
  EmployeeRecord,
  | '_id'
  | 'employeeNumber'
  | 'firstName'
  | 'lastName'
  | 'departmentId'
  | 'positionId'
  | 'reportingTo'
  | 'employmentStatus'
  | 'photoFileId'
>;

/** People loaded with what the directory shows about them. */
export interface People {
  /** In directory order: last name, then first name. The system account is never in it. */
  list: PersonRecord[];
  byId: Map<string, PersonRecord>;
  /** Whether each person's account resolves to active (no account counts as inactive). */
  active: Map<string, boolean>;
  /** Login emails, by employee ID. */
  emails: Map<string, string>;
  departments: Map<string, { name: string; code: string }>;
  positions: Map<string, string>;
}

/** The directory order, which the `{ lastName, firstName, _id }` index serves. */
export const DIRECTORY_SORT = { lastName: 1, firstName: 1, _id: 1 } as const;

/**
 * Loads the employees matching `filter` with their accounts, departments and positions. An
 * employee linked to the bootstrap system account (which the model's own rule forbids) is left
 * out. Retired departments and positions still show their names.
 */
export async function loadPeople(filter: Record<string, unknown>): Promise<People> {
  await connectDb();
  const employees = await EmployeeModel.find(filter, PERSON_FIELDS).sort(DIRECTORY_SORT).lean();
  if (employees.length === 0) {
    return {
      list: [],
      byId: new Map(),
      active: new Map(),
      emails: new Map(),
      departments: new Map(),
      positions: new Map(),
    };
  }
  const ids = employees.map((employee) => employee._id);
  const [users, departments, positions] = await Promise.all([
    UserModel.find(
      { employeeId: { $in: ids } },
      { employeeId: 1, email: 1, isSystemAccount: 1, systemAccountDisabled: 1 },
    ).lean(),
    DepartmentModel.find(
      { _id: { $in: employees.map((employee) => employee.departmentId) } },
      { name: 1, code: 1 },
      { withDeleted: true },
    ).lean(),
    PositionModel.find(
      { _id: { $in: employees.map((employee) => employee.positionId) } },
      { name: 1 },
      { withDeleted: true },
    ).lean(),
  ]);

  const userByEmployee = new Map(
    users.flatMap((user) => (user.employeeId ? [[user.employeeId.toHexString(), user]] : [])),
  );
  const list = employees.filter(
    (employee) => userByEmployee.get(employee._id.toHexString())?.isSystemAccount !== true,
  );
  const active = new Map<string, boolean>();
  const emails = new Map<string, string>();
  for (const employee of list) {
    const hex = employee._id.toHexString();
    const user = userByEmployee.get(hex);
    active.set(hex, user !== undefined && resolveAccountStatus(user, employee) === 'active');
    if (user) emails.set(hex, user.email);
  }
  return {
    list,
    byId: new Map(list.map((employee) => [employee._id.toHexString(), employee])),
    active,
    emails,
    departments: new Map(
      departments.map((d) => [d._id.toHexString(), { name: d.name, code: d.code }]),
    ),
    positions: new Map(positions.map((p) => [p._id.toHexString(), p.name])),
  };
}

/** True when the person is loaded and their account resolves to active. */
export function isActive(people: People, id: Types.ObjectId | string): boolean {
  return people.active.get(typeof id === 'string' ? id : id.toHexString()) === true;
}

/** A person as a link, built field by field. */
export function toLink(
  people: People,
  person: PersonRecord,
  { inactive = false }: { inactive?: boolean } = {},
): DirectoryPersonLink {
  return {
    id: person._id.toHexString(),
    name: employeeName(person),
    initials: initialsOf(person),
    photoUrl: employeePhotoUrl(person.photoFileId),
    employeeNumber: person.employeeNumber,
    departmentName: people.departments.get(person.departmentId.toHexString())?.name ?? null,
    positionName: people.positions.get(person.positionId.toHexString()) ?? null,
    inactive,
  };
}

/** The person's active supervisors that are loaded, in the stored order. */
export function activeSupervisors(people: People, person: PersonRecord): PersonRecord[] {
  return person.reportingTo.flatMap((supervisorId) => {
    const supervisor = people.byId.get(supervisorId.toHexString());
    return supervisor && isActive(people, supervisor._id) ? [supervisor] : [];
  });
}

/** The loaded active people who report to `person`, in directory order. */
export function activeDirectReports(people: People, person: PersonRecord): PersonRecord[] {
  return people.list.filter(
    (other) =>
      isActive(people, other._id) &&
      other.reportingTo.some((supervisorId) => supervisorId.equals(person._id)),
  );
}
