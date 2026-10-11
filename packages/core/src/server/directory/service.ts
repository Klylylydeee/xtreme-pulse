import { connectDb } from '@pulse/db';
import { AccessDeniedError } from '../../actions';
import type {
  DirectoryCard,
  DirectoryDepartmentOption,
  DirectoryPerson,
  DirectoryPersonLink,
  OwnTeam,
  SupervisorCandidate,
} from '../../directory';
import { canEditReportingLines, canSeeSeparatedPeople, type RoleHolder } from '../auth/roles';
import { DepartmentModel } from '../departments/model';
import { employeeName, searchActiveEmployees } from '../employees/active-employees';
import { EmployeeModel } from '../employees/model';
import { toObjectId } from '../paging';
import {
  activeDirectReports,
  activeSupervisors,
  isActive,
  loadPeople,
  type People,
  type PersonRecord,
  toLink,
} from './people';

// Spec: docs/modules/core.md#company-directory and #home (decisions 134–136, 142, 148, 149 and 152
// in docs/BUILD_PLAN.md) — the directory is open to every signed-in user, with no module access.
//
// - Directory fields only, built field by field (people.ts).
// - Listed: employees whose account resolves to active. HR and System Administrators may ask for
//   separated people too (`separated`), shown with the "Inactive" flag; the flag is ignored for
//   anyone else, Board members included, and a separated person's card then answers like a
//   missing one. The bootstrap system account has no employee record, so it never appears.
// - A card's "Reports to" shows a line to an inactive supervisor, flagged, only to the reporting
//   line editors (HR, Board members, System Administrators), so they can remove it.
// - Nothing here is audit-logged, written to the logs or cached.

/** Who is reading the directory: a role holder with an ID and employee (a `CurrentUser` fits). */
export interface DirectoryViewer extends RoleHolder {
  /** The user ID. */
  id: string;
  /** Null for the bootstrap system account. */
  employee: { id: string } | null;
}

export interface ListDirectoryOptions {
  /** Matches the name, employee number or email; every word must match. */
  search?: string | null;
  departmentId?: string | null;
  /** Include separated people. Ignored unless the viewer is HR or a System Administrator. */
  separated?: boolean;
}

const SEARCH_MAX_LENGTH = 100;

function wordsOf(search: string | null | undefined): string[] {
  return (search ?? '')
    .trim()
    .slice(0, SEARCH_MAX_LENGTH)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function matches(person: PersonRecord, email: string | undefined, words: string[]): boolean {
  if (words.length === 0) return true;
  const haystack = [person.firstName, person.lastName, person.employeeNumber, email ?? ''].map(
    (value) => value.toLowerCase(),
  );
  return words.every((word) => haystack.some((value) => value.includes(word)));
}

/** A person as a directory row, built field by field. */
function toPerson(
  people: People,
  person: PersonRecord,
  reportingTo: DirectoryPersonLink[],
  directReports: DirectoryPersonLink[],
): DirectoryPerson {
  const hex = person._id.toHexString();
  const department = people.departments.get(person.departmentId.toHexString());
  return {
    id: hex,
    name: employeeName(person),
    initials: toLink(people, person).initials,
    employeeNumber: person.employeeNumber,
    departmentId: person.departmentId.toHexString(),
    departmentName: department?.name ?? null,
    departmentCode: department?.code ?? null,
    positionName: people.positions.get(person.positionId.toHexString()) ?? null,
    email: people.emails.get(hex) ?? null,
    reportingTo,
    directReports,
    inactive: !isActive(people, person._id),
  };
}

/**
 * The directory: active people by last name, then first name, with no paging. HR and System
 * Administrators also get separated people with `separated`. Each row's "Reports to" and "Direct
 * reports" name active people only.
 */
export async function listDirectory(
  viewer: DirectoryViewer,
  { search, departmentId, separated = false }: ListDirectoryOptions = {},
): Promise<DirectoryPerson[]> {
  const showSeparated = separated && canSeeSeparatedPeople(viewer);
  let department = null;
  if (departmentId) {
    department = toObjectId(departmentId);
    if (!department) return [];
  }
  const people = await loadPeople({});
  const words = wordsOf(search);

  // Who reports to whom, among active people, in directory order.
  const reportsOf = new Map<string, PersonRecord[]>();
  for (const person of people.list) {
    if (!isActive(people, person._id)) continue;
    for (const supervisorId of person.reportingTo) {
      const key = supervisorId.toHexString();
      const reports = reportsOf.get(key) ?? [];
      if (!reports.includes(person)) reports.push(person);
      reportsOf.set(key, reports);
    }
  }

  return people.list
    .filter((person) => showSeparated || isActive(people, person._id))
    .filter((person) => !department || person.departmentId.equals(department))
    .filter((person) => matches(person, people.emails.get(person._id.toHexString()), words))
    .map((person) =>
      toPerson(
        people,
        person,
        activeSupervisors(people, person).map((supervisor) => toLink(people, supervisor)),
        (reportsOf.get(person._id.toHexString()) ?? []).map((report) => toLink(people, report)),
      ),
    );
}

/** Loads `employeeId`, their supervisors and their direct reports. */
async function loadAround(
  employeeId: string,
): Promise<{ people: People; person: PersonRecord } | null> {
  const id = toObjectId(employeeId);
  if (!id) return null;
  await connectDb();
  const subject = await EmployeeModel.findById(id, { reportingTo: 1 }).lean();
  if (!subject) return null;
  const people = await loadPeople({
    $or: [{ _id: { $in: [id, ...subject.reportingTo] } }, { reportingTo: id }],
  });
  const person = people.byId.get(id.toHexString());
  return person ? { people, person } : null;
}

/**
 * One person's card, or null when there is no such person, or they are separated and the viewer
 * isn't HR or a System Administrator (the same answer, so separated people can't be probed).
 * Editors also see stored lines to inactive supervisors, flagged.
 */
export async function getDirectoryPerson(
  viewer: DirectoryViewer,
  employeeId: string,
): Promise<DirectoryCard | null> {
  const found = await loadAround(employeeId);
  if (!found) return null;
  const { people, person } = found;
  const active = isActive(people, person._id);
  if (!active && !canSeeSeparatedPeople(viewer)) return null;

  const editor = canEditReportingLines(viewer);
  const reportingTo = person.reportingTo.flatMap((supervisorId) => {
    const supervisor = people.byId.get(supervisorId.toHexString());
    if (!supervisor) return [];
    const supervisorActive = isActive(people, supervisor._id);
    if (!supervisorActive && !editor) return [];
    return [toLink(people, supervisor, { inactive: !supervisorActive })];
  });
  const directReports = activeDirectReports(people, person).map((report) => toLink(people, report));
  return {
    ...toPerson(people, person, reportingTo, directReports),
    canEditReportingLines: editor && active && viewer.employee?.id !== person._id.toHexString(),
  };
}

/**
 * The Home "Your team" tile: the viewer's active supervisors (in the stored order) and active
 * direct reports (by last name). Empty for the bootstrap system account, which has no employee.
 */
export async function getOwnTeam(viewer: DirectoryViewer): Promise<OwnTeam> {
  const empty: OwnTeam = { supervisors: [], directReports: [] };
  if (!viewer.employee) return empty;
  const found = await loadAround(viewer.employee.id);
  if (!found) return empty;
  const { people, person } = found;
  return {
    supervisors: activeSupervisors(people, person).map((supervisor) => toLink(people, supervisor)),
    directReports: activeDirectReports(people, person).map((report) => toLink(people, report)),
  };
}

/** The live departments, by name, for the directory and org chart filter. */
export async function listDirectoryDepartments(): Promise<DirectoryDepartmentOption[]> {
  await connectDb();
  const departments = await DepartmentModel.find({}, { name: 1 }).sort({ name: 1, _id: 1 }).lean();
  return departments.map((department) => ({
    id: department._id.toHexString(),
    name: department.name,
  }));
}

/**
 * The inspector's supervisor search (decision 142): active employees matched on name or employee
 * number, by last name, at most 20, without the person being edited. HR, Board members and System
 * Administrators only.
 */
export async function searchSupervisorCandidates(
  actor: RoleHolder,
  { search = '', excludeEmployeeId = null }: { search?: string; excludeEmployeeId?: string | null },
): Promise<SupervisorCandidate[]> {
  if (!canEditReportingLines(actor)) throw new AccessDeniedError();
  await connectDb();
  const eligible = (await searchActiveEmployees(search)).filter(
    (employee) => employee._id.toHexString() !== excludeEmployeeId,
  );
  if (eligible.length === 0) return [];
  const departments = await DepartmentModel.find(
    { _id: { $in: eligible.map((employee) => employee.departmentId) } },
    { name: 1 },
    { withDeleted: true },
  ).lean();
  const departmentNames = new Map(departments.map((d) => [d._id.toHexString(), d.name]));
  return eligible.map((employee) => ({
    id: employee._id.toHexString(),
    name: employeeName(employee),
    employeeNumber: employee.employeeNumber,
    departmentName: departmentNames.get(employee.departmentId.toHexString()) ?? null,
  }));
}
