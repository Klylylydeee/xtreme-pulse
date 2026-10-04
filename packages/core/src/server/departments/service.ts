import type { ClientSession, Types } from 'mongoose';
import { connectDb, withTransaction } from '@pulse/db';
import { EMPLOYMENT_STATUS, EMPLOYMENT_STATUSES } from '../../account';
import { AccessDeniedError, ActionError } from '../../actions';
import { now } from '../../dates';
import {
  type DepartmentInput,
  departmentInputSchema,
  type DepartmentUpdateInput,
  departmentUpdateSchema,
} from '../../org-structure';
import { recordAudit } from '../audit/service';
import { snapshotForAudit, snapshotsForAudit } from '../audit/snapshot';
import { resolveAccountStatus } from '../auth/account-status';
import { canManageOrgStructure, type RoleHolder } from '../auth/roles';
import { EmployeeModel } from '../employees/model';
import { toObjectId } from '../paging';
import { PositionModel } from '../positions/model';
import { isDuplicateKeyError } from '../seed/duplicate-key';
import { UserModel } from '../users/model';
import { type DepartmentRecord, DepartmentModel } from './model';

// Spec: docs/modules/core.md#managing-departments-and-positions — HR and the System Administrator
// add, edit, retire and restore departments. Every function checks the actor's role itself (the
// page guard isn't enough), and every change writes its audit entry (`core.department`) in the
// same transaction, so a change never lands without its entry.
//
// - The code is set once and never reused: the unique index includes retired departments.
// - Retiring is a soft delete (`deletedAt`), refused while the department has live positions or
//   active employees. `HR`, `ACCT` and `BOD` follow the same rules as any other department.
// - The head is optional: any employee whose account resolves to active, from any department.

const RECORD_TYPE = 'core.department';

/** Who is acting: the signed-in user (a `CurrentUser` fits). */
export interface OrgStructureActor extends RoleHolder {
  id: string;
  email: string;
}

/** The employment statuses whose account is active (SECURITY.md#account-status). */
export const ACTIVE_EMPLOYMENT_STATUSES = EMPLOYMENT_STATUSES.filter(
  (status) => EMPLOYMENT_STATUS[status] === 'active',
);

/** Refuses anyone but HR and the System Administrator. */
export function assertCanManageOrgStructure(actor: OrgStructureActor): void {
  if (!canManageOrgStructure(actor)) throw new AccessDeniedError();
}

/** The first Zod issue of a failed parse, as an {@link ActionError} on its field. */
export function inputError(issues: { path: PropertyKey[]; message: string }[]): ActionError {
  const issue = issues[0];
  const field = issue?.path.map(String).join('.') || undefined;
  return new ActionError(issue?.message ?? 'Check the form and try again.', { field });
}

/** `First Last`, as the directory shows it. */
export function employeeName(employee: { firstName: string; lastName: string }): string {
  return `${employee.firstName} ${employee.lastName}`;
}

const DEPARTMENT_GONE = 'This department no longer exists. Reload the page.';
const CODE_TAKEN =
  'Another department already uses this code (retired departments keep theirs). Choose another code.';
const HEAD_NOT_ELIGIBLE = 'Choose an employee whose account is active.';

function labelOf(department: Pick<DepartmentRecord, 'code' | 'name'>): string {
  return `${department.code} · ${department.name}`;
}

/** One count per group, from {@link countPipeline}. */
export interface GroupCount {
  _id: Types.ObjectId;
  n: number;
}

/** An aggregation counting the records that match `match`, per value of `field`. */
export function countPipeline(field: string, match: Record<string, unknown> = {}) {
  return [{ $match: match }, { $group: { _id: `$${field}`, n: { $sum: 1 } } }];
}

/** The counts as a map from id to count. */
export function countMap(rows: GroupCount[]): Map<string, number> {
  return new Map(rows.map((row) => [row._id.toHexString(), row.n]));
}

/** Matches employees whose employment status is active. */
export const ACTIVE_EMPLOYEES = { employmentStatus: { $in: ACTIVE_EMPLOYMENT_STATUSES } };

/** True when the employee exists and their account resolves to active. */
async function isEligibleHead(
  employeeId: Types.ObjectId,
  session: ClientSession | null,
): Promise<boolean> {
  const employee = await EmployeeModel.findById(employeeId, { employmentStatus: 1 })
    .session(session)
    .lean();
  if (!employee) return false;
  const user = await UserModel.findOne(
    { employeeId },
    { isSystemAccount: 1, systemAccountDisabled: 1 },
  )
    .session(session)
    .lean();
  return user !== null && resolveAccountStatus(user, employee) === 'active';
}

async function headIdFrom(
  value: string | null,
  session: ClientSession,
): Promise<Types.ObjectId | null> {
  if (value === null) return null;
  const id = toObjectId(value);
  if (!id || !(await isEligibleHead(id, session))) {
    throw new ActionError(HEAD_NOT_ELIGIBLE, { field: 'headEmployeeId' });
  }
  return id;
}

function rethrowDuplicateCode(error: unknown): never {
  if (isDuplicateKeyError(error, 'code')) throw new ActionError(CODE_TAKEN, { field: 'code' });
  throw error;
}

// --- Reading ---------------------------------------------------------------------------------

/** One row of the departments table. */
export interface DepartmentView {
  id: string;
  name: string;
  code: string;
  headEmployeeId: string | null;
  /** The head's name, or null when none is set (or the record is missing). */
  headName: string | null;
  /** Live (not retired) positions in the department. */
  positionCount: number;
  /** Employees in the department whose employment status is active. */
  activeEmployeeCount: number;
  /** When it was retired; null while it is live. */
  retiredAt: Date | null;
  updatedAt: Date;
}

/** Every live department, by name, with retired ones too when `includeRetired`. */
export async function listDepartments(
  actor: OrgStructureActor,
  { includeRetired = false }: { includeRetired?: boolean } = {},
): Promise<DepartmentView[]> {
  assertCanManageOrgStructure(actor);
  await connectDb();

  const departments = await DepartmentModel.find({}, null, { withDeleted: includeRetired })
    .sort({ name: 1, _id: 1 })
    .lean();
  const headIds = departments.flatMap((department) =>
    department.headEmployeeId ? [department.headEmployeeId] : [],
  );
  const [positionCounts, employeeCounts, heads] = await Promise.all([
    PositionModel.aggregate<GroupCount>(countPipeline('departmentId')).then(countMap),
    EmployeeModel.aggregate<GroupCount>(countPipeline('departmentId', ACTIVE_EMPLOYEES)).then(
      countMap,
    ),
    EmployeeModel.find({ _id: { $in: headIds } }, { firstName: 1, lastName: 1 }).lean(),
  ]);
  const headNames = new Map(heads.map((head) => [head._id.toHexString(), employeeName(head)]));

  return departments.map((department) => {
    const id = department._id.toHexString();
    const headId = department.headEmployeeId?.toHexString() ?? null;
    return {
      id,
      name: department.name,
      code: department.code,
      headEmployeeId: headId,
      headName: headId ? (headNames.get(headId) ?? null) : null,
      positionCount: positionCounts.get(id) ?? 0,
      activeEmployeeCount: employeeCounts.get(id) ?? 0,
      retiredAt: department.deletedAt ?? null,
      updatedAt: department.updatedAt,
    };
  });
}

/** An employee who can be picked as a department head. */
export interface DepartmentHeadOption {
  id: string;
  name: string;
  employeeNumber: string;
  departmentName: string | null;
}

const HEAD_SEARCH_LIMIT = 20;
// Read more than the limit, since some candidates may have no active account.
const HEAD_CANDIDATE_LIMIT = 100;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Employees whose account resolves to active, from any department, for the department head
 * picker: matched on name or employee number, by last name, at most 20.
 */
export async function listEligibleDepartmentHeads(
  actor: OrgStructureActor,
  search = '',
): Promise<DepartmentHeadOption[]> {
  assertCanManageOrgStructure(actor);
  await connectDb();

  const filter: Record<string, unknown> = { ...ACTIVE_EMPLOYEES };
  const words = search.trim().slice(0, 100).split(/\s+/).filter(Boolean);
  if (words.length > 0) {
    filter.$and = words.map((word) => {
      const pattern = new RegExp(escapeRegExp(word), 'i');
      return {
        $or: [{ firstName: pattern }, { lastName: pattern }, { employeeNumber: pattern }],
      };
    });
  }
  const candidates = await EmployeeModel.find(filter, {
    firstName: 1,
    lastName: 1,
    employeeNumber: 1,
    employmentStatus: 1,
    departmentId: 1,
  })
    .sort({ lastName: 1, firstName: 1, _id: 1 })
    .limit(HEAD_CANDIDATE_LIMIT)
    .lean();
  if (candidates.length === 0) return [];

  const users = await UserModel.find(
    { employeeId: { $in: candidates.map((employee) => employee._id) } },
    { employeeId: 1, isSystemAccount: 1, systemAccountDisabled: 1 },
  ).lean();
  const userByEmployee = new Map(users.map((user) => [user.employeeId?.toHexString(), user]));
  const eligible = candidates
    .filter((employee) => {
      const user = userByEmployee.get(employee._id.toHexString());
      return user !== undefined && resolveAccountStatus(user, employee) === 'active';
    })
    .slice(0, HEAD_SEARCH_LIMIT);

  // A retired department still shows its name.
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

// --- Changing --------------------------------------------------------------------------------

/** Adds a department. Its code is fixed from then on and never reused. */
export async function createDepartment(
  actor: OrgStructureActor,
  input: DepartmentInput,
): Promise<{ id: string }> {
  assertCanManageOrgStructure(actor);
  const parsed = departmentInputSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const { name, code, headEmployeeId } = parsed.data;
  const actorId = toObjectId(actor.id);

  try {
    return await withTransaction(async (session) => {
      const taken = await DepartmentModel.exists({ code })
        .setOptions({ withDeleted: true })
        .session(session);
      if (taken) throw new ActionError(CODE_TAKEN, { field: 'code' });
      const headId = await headIdFrom(headEmployeeId, session);

      const [created] = await DepartmentModel.create(
        [{ name, code, headEmployeeId: headId, createdBy: actorId }],
        { session },
      );
      if (!created) throw new Error('The department wasn’t created.');
      await recordAudit(
        {
          actorId: actor.id,
          actorEmail: actor.email,
          module: 'core',
          action: 'create',
          record: { type: RECORD_TYPE, id: created._id, label: labelOf(created) },
          before: null,
          after: snapshotForAudit(DepartmentModel, created),
        },
        { session },
      );
      return { id: created._id.toHexString() };
    });
  } catch (error) {
    rethrowDuplicateCode(error);
  }
}

/** Loads a department in the transaction, retired ones included, or refuses. */
async function loadDepartment(id: string, session: ClientSession) {
  const departmentId = toObjectId(id);
  if (!departmentId) throw new ActionError(DEPARTMENT_GONE);
  const department = await DepartmentModel.findById(departmentId, null, { withDeleted: true })
    .session(session)
    .lean();
  if (!department) throw new ActionError(DEPARTMENT_GONE);
  return department;
}

/**
 * Changes a live department's name and head. The code can't be changed: an input carrying a
 * different code is refused. A new head must be an employee whose account resolves to active; an
 * unchanged head is kept as it is.
 */
export async function updateDepartment(
  actor: OrgStructureActor,
  id: string,
  input: DepartmentUpdateInput,
): Promise<void> {
  assertCanManageOrgStructure(actor);
  const sentCode = (input as { code?: unknown }).code;
  const parsed = departmentUpdateSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const { name, headEmployeeId } = parsed.data;

  await withTransaction(async (session) => {
    const before = await loadDepartment(id, session);
    if (sentCode !== undefined && String(sentCode).trim().toUpperCase() !== before.code) {
      throw new ActionError('A department’s code can’t be changed.', { field: 'code' });
    }
    if (before.deletedAt) {
      throw new ActionError('This department is retired. Restore it first to edit it.');
    }
    const unchangedHead = (before.headEmployeeId?.toHexString() ?? null) === headEmployeeId;
    const headId = unchangedHead
      ? before.headEmployeeId
      : await headIdFrom(headEmployeeId, session);

    await DepartmentModel.updateOne(
      { _id: before._id },
      { $set: { name, headEmployeeId: headId, updatedBy: toObjectId(actor.id) } },
      { session, runValidators: true },
    );
    const after = await DepartmentModel.findById(before._id).session(session).lean().orFail();
    await recordAudit(
      {
        actorId: actor.id,
        actorEmail: actor.email,
        module: 'core',
        action: 'update',
        record: { type: RECORD_TYPE, id: before._id, label: labelOf(after) },
        ...snapshotsForAudit(DepartmentModel, before, after),
      },
      { session },
    );
  });
}

/**
 * Retires (soft-deletes) a department. Refused while it has live positions or active employees,
 * whatever its code.
 */
export async function retireDepartment(actor: OrgStructureActor, id: string): Promise<void> {
  assertCanManageOrgStructure(actor);

  await withTransaction(async (session) => {
    const before = await loadDepartment(id, session);
    if (before.deletedAt) throw new ActionError('This department is already retired.');

    // One at a time: a transaction's operations can't run in parallel on its session.
    const positions = await PositionModel.countDocuments({ departmentId: before._id }).session(
      session,
    );
    const employees = await EmployeeModel.countDocuments({
      departmentId: before._id,
      ...ACTIVE_EMPLOYEES,
    }).session(session);
    if (positions > 0 || employees > 0) {
      const blockers = [
        positions > 0 ? `${positions} live ${positions === 1 ? 'position' : 'positions'}` : null,
        employees > 0 ? `${employees} active ${employees === 1 ? 'employee' : 'employees'}` : null,
      ].filter(Boolean);
      throw new ActionError(
        `This department still has ${blockers.join(' and ')}. Move the employees and retire the positions first.`,
      );
    }

    await DepartmentModel.updateOne(
      { _id: before._id },
      { $set: { deletedAt: now(), updatedBy: toObjectId(actor.id) } },
      { session },
    );
    await recordAudit(
      {
        actorId: actor.id,
        actorEmail: actor.email,
        module: 'core',
        action: 'delete',
        record: { type: RECORD_TYPE, id: before._id, label: labelOf(before) },
        before: snapshotForAudit(DepartmentModel, before),
        after: null,
      },
      { session },
    );
  });
}

/** Restores a retired department, unchanged. */
export async function restoreDepartment(actor: OrgStructureActor, id: string): Promise<void> {
  assertCanManageOrgStructure(actor);

  await withTransaction(async (session) => {
    const before = await loadDepartment(id, session);
    if (!before.deletedAt) throw new ActionError('This department isn’t retired.');

    await DepartmentModel.updateOne(
      { _id: before._id, deletedAt: { $ne: null } },
      { $set: { deletedAt: null, updatedBy: toObjectId(actor.id) } },
      { session },
    );
    const after = await DepartmentModel.findById(before._id).session(session).lean().orFail();
    await recordAudit(
      {
        actorId: actor.id,
        actorEmail: actor.email,
        module: 'core',
        action: 'restore',
        record: { type: RECORD_TYPE, id: before._id, label: labelOf(after) },
        ...snapshotsForAudit(DepartmentModel, before, after),
      },
      { session },
    );
  });
}
