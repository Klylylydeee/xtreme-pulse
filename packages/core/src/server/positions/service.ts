import type { ClientSession, Types } from 'mongoose';
import { connectDb, withTransaction } from '@pulse/db';
import { ActionError } from '../../actions';
import { now } from '../../dates';
import {
  type PositionInput,
  positionInputSchema,
  type PositionUpdateInput,
  positionUpdateSchema,
} from '../../org-structure';
import type { TimesheetType } from '../../timesheet-types';
import { recordAudit } from '../audit/service';
import { snapshotForAudit, snapshotsForAudit } from '../audit/snapshot';
import { type DepartmentRecord, DepartmentModel } from '../departments/model';
import {
  ACTIVE_EMPLOYEES,
  assertCanManageOrgStructure,
  countMap,
  countPipeline,
  type GroupCount,
  inputError,
  type OrgStructureActor,
} from '../departments/service';
import { EmployeeModel } from '../employees/model';
import { toObjectId } from '../paging';
import { isDuplicateKeyError } from '../seed/duplicate-key';
import { POSITION_NAME_COLLATION, PositionModel } from './model';

// Spec: docs/modules/core.md#managing-departments-and-positions — HR and the System Administrator
// add, edit, retire and restore positions. Every function checks the actor's role itself, and
// every change writes its audit entry (`core.position`) in the same transaction.
//
// - A position is added only to a live department, and its department is fixed from then on.
// - Names are unique within a department ignoring case, retired positions included.
// - A timesheet type change saves at once; it applies from the next cut-off, because each
//   timesheet keeps the type that applied when its cut-off started (docs/modules/talent.md).
// - Retiring is a soft delete (`deletedAt`), refused while active employees hold the position.

const RECORD_TYPE = 'core.position';

const POSITION_GONE = 'This position no longer exists. Reload the page.';
const NAME_TAKEN =
  'This department already has a position with this name (retired positions keep theirs). Choose another name.';
const DEPARTMENT_NOT_LIVE = 'Choose a department that isn’t retired.';

function rethrowDuplicateName(error: unknown): never {
  if (isDuplicateKeyError(error, 'name')) throw new ActionError(NAME_TAKEN, { field: 'name' });
  throw error;
}

/** Refuses a name another position in the department already has (retired ones included). */
async function assertNameFree(
  departmentId: Types.ObjectId,
  name: string,
  exceptId: Types.ObjectId | null,
  session: ClientSession,
): Promise<void> {
  const filter: Record<string, unknown> = { departmentId, name };
  if (exceptId) filter._id = { $ne: exceptId };
  const taken = await PositionModel.findOne(filter, { _id: 1 })
    .setOptions({ withDeleted: true })
    .collation(POSITION_NAME_COLLATION)
    .session(session)
    .lean();
  if (taken) throw new ActionError(NAME_TAKEN, { field: 'name' });
}

/**
 * Writes to the department in the transaction and returns its code, or null when it is retired
 * or unknown. Adding or restoring a position must write the department, not only read it:
 * `retireDepartment` counts live positions and then writes the department, so a transaction that
 * only read it could commit a live position next to the retirement (write skew under snapshot
 * isolation). With both writing the department, one fails with a write conflict and
 * `withTransaction` retries it, and the retry sees the other's result.
 *
 * The write only bumps the version key, with timestamps off, so `updatedAt` and `updatedBy` keep
 * saying who last edited the department, and no audit entry is due (`__v` isn't snapshotted).
 * Assigning an employee to a department or position will need the same write once employee
 * records arrive, since retiring checks for active employees the same way.
 */
async function claimLiveDepartment(
  departmentId: Types.ObjectId,
  session: ClientSession,
): Promise<Pick<DepartmentRecord, 'code'> | null> {
  const result = await DepartmentModel.updateOne(
    { _id: departmentId, deletedAt: null },
    { $inc: { __v: 1 } },
    { session, timestamps: false },
  );
  if (result.matchedCount !== 1) return null;
  return DepartmentModel.findById(departmentId, { code: 1 }).session(session).lean().orFail();
}

/** The position's department, retired or not, for the audit label. */
async function departmentOf(
  departmentId: Types.ObjectId,
  session: ClientSession,
): Promise<Pick<DepartmentRecord, 'code'> | null> {
  return DepartmentModel.findById(departmentId, { code: 1 }, { withDeleted: true })
    .session(session)
    .lean();
}

/** `<DEPT CODE> · <name>`, like the department entries' labels. */
function labelOf(department: Pick<DepartmentRecord, 'code'> | null, position: { name: string }) {
  return department ? `${department.code} · ${position.name}` : position.name;
}

// --- Reading ---------------------------------------------------------------------------------

/** One row of the positions table. */
export interface PositionView {
  id: string;
  name: string;
  departmentId: string;
  departmentName: string | null;
  departmentCode: string | null;
  /** True when the department is retired (its positions are then retired too). */
  departmentRetired: boolean;
  timesheetType: TimesheetType;
  /** Employees holding the position whose employment status is active. */
  activeEmployeeCount: number;
  /** When it was retired; null while it is live. */
  retiredAt: Date | null;
  updatedAt: Date;
}

/**
 * Every live position, by department name and then position name, with retired ones too when
 * `includeRetired`. With `departmentId`, only that department's.
 */
export async function listPositions(
  actor: OrgStructureActor,
  {
    departmentId,
    includeRetired = false,
  }: { departmentId?: string | null; includeRetired?: boolean } = {},
): Promise<PositionView[]> {
  assertCanManageOrgStructure(actor);
  await connectDb();

  const filter: Record<string, unknown> = {};
  if (departmentId) {
    const id = toObjectId(departmentId);
    if (!id) return [];
    filter.departmentId = id;
  }
  const positions = await PositionModel.find(filter, null, { withDeleted: includeRetired }).lean();
  if (positions.length === 0) return [];

  const departmentIds = [...new Set(positions.map((p) => p.departmentId.toHexString()))];
  const [departments, employeeCounts] = await Promise.all([
    DepartmentModel.find(
      { _id: { $in: departmentIds.map((id) => toObjectId(id)) } },
      { name: 1, code: 1, deletedAt: 1 },
      { withDeleted: true },
    ).lean(),
    EmployeeModel.aggregate<GroupCount>(
      countPipeline('positionId', {
        ...ACTIVE_EMPLOYEES,
        positionId: { $in: positions.map((position) => position._id) },
      }),
    ).then(countMap),
  ]);
  const departmentById = new Map(departments.map((d) => [d._id.toHexString(), d]));

  return positions
    .map((position) => {
      const id = position._id.toHexString();
      const department = departmentById.get(position.departmentId.toHexString());
      return {
        id,
        name: position.name,
        departmentId: position.departmentId.toHexString(),
        departmentName: department?.name ?? null,
        departmentCode: department?.code ?? null,
        departmentRetired: Boolean(department?.deletedAt),
        timesheetType: position.timesheetType,
        activeEmployeeCount: employeeCounts.get(id) ?? 0,
        retiredAt: position.deletedAt ?? null,
        updatedAt: position.updatedAt,
      };
    })
    .sort(
      (a, b) =>
        (a.departmentName ?? '').localeCompare(b.departmentName ?? '') ||
        a.name.localeCompare(b.name),
    );
}

// --- Changing --------------------------------------------------------------------------------

/** Adds a position to a live department. Its department is fixed from then on. */
export async function createPosition(
  actor: OrgStructureActor,
  input: PositionInput,
): Promise<{ id: string }> {
  assertCanManageOrgStructure(actor);
  const parsed = positionInputSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const { name, timesheetType } = parsed.data;
  const departmentId = toObjectId(parsed.data.departmentId);
  if (!departmentId) throw new ActionError(DEPARTMENT_NOT_LIVE, { field: 'departmentId' });

  try {
    return await withTransaction(async (session) => {
      const department = await claimLiveDepartment(departmentId, session);
      if (!department) throw new ActionError(DEPARTMENT_NOT_LIVE, { field: 'departmentId' });
      await assertNameFree(departmentId, name, null, session);

      const [created] = await PositionModel.create(
        [{ name, departmentId, timesheetType, createdBy: toObjectId(actor.id) }],
        { session },
      );
      if (!created) throw new Error('The position wasn’t created.');
      await recordAudit(
        {
          actorId: actor.id,
          actorEmail: actor.email,
          module: 'core',
          action: 'create',
          record: { type: RECORD_TYPE, id: created._id, label: labelOf(department, created) },
          before: null,
          after: snapshotForAudit(PositionModel, created),
        },
        { session },
      );
      return { id: created._id.toHexString() };
    });
  } catch (error) {
    rethrowDuplicateName(error);
  }
}

/** Loads a position in the transaction, retired ones included, or refuses. */
async function loadPosition(id: string, session: ClientSession) {
  const positionId = toObjectId(id);
  if (!positionId) throw new ActionError(POSITION_GONE);
  const position = await PositionModel.findById(positionId, null, { withDeleted: true })
    .session(session)
    .lean();
  if (!position) throw new ActionError(POSITION_GONE);
  return position;
}

/**
 * Changes a live position's name and timesheet type. The department can't be changed: an input
 * carrying a different department is refused. A new timesheet type applies from the next cut-off.
 */
export async function updatePosition(
  actor: OrgStructureActor,
  id: string,
  input: PositionUpdateInput,
): Promise<void> {
  assertCanManageOrgStructure(actor);
  const sentDepartment = (input as { departmentId?: unknown }).departmentId;
  const parsed = positionUpdateSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const { name, timesheetType } = parsed.data;

  try {
    await withTransaction(async (session) => {
      const before = await loadPosition(id, session);
      if (
        sentDepartment !== undefined &&
        String(sentDepartment) !== before.departmentId.toHexString()
      ) {
        throw new ActionError(
          'A position’s department can’t be changed. Add a new position in the other department instead.',
          { field: 'departmentId' },
        );
      }
      if (before.deletedAt) {
        throw new ActionError('This position is retired. Restore it first to edit it.');
      }
      await assertNameFree(before.departmentId, name, before._id, session);

      await PositionModel.updateOne(
        { _id: before._id },
        { $set: { name, timesheetType, updatedBy: toObjectId(actor.id) } },
        { session, runValidators: true },
      );
      const after = await PositionModel.findById(before._id).session(session).lean().orFail();
      const department = await departmentOf(before.departmentId, session);
      await recordAudit(
        {
          actorId: actor.id,
          actorEmail: actor.email,
          module: 'core',
          action: 'update',
          record: { type: RECORD_TYPE, id: before._id, label: labelOf(department, after) },
          ...snapshotsForAudit(PositionModel, before, after),
        },
        { session },
      );
    });
  } catch (error) {
    rethrowDuplicateName(error);
  }
}

/** Retires (soft-deletes) a position. Refused while active employees hold it. */
export async function retirePosition(actor: OrgStructureActor, id: string): Promise<void> {
  assertCanManageOrgStructure(actor);

  await withTransaction(async (session) => {
    const before = await loadPosition(id, session);
    if (before.deletedAt) throw new ActionError('This position is already retired.');

    const holders = await EmployeeModel.countDocuments({
      positionId: before._id,
      ...ACTIVE_EMPLOYEES,
    }).session(session);
    if (holders > 0) {
      throw new ActionError(
        `${holders} active ${holders === 1 ? 'employee holds' : 'employees hold'} this position. Move them to another position first.`,
      );
    }

    await PositionModel.updateOne(
      { _id: before._id },
      { $set: { deletedAt: now(), updatedBy: toObjectId(actor.id) } },
      { session },
    );
    const department = await departmentOf(before.departmentId, session);
    await recordAudit(
      {
        actorId: actor.id,
        actorEmail: actor.email,
        module: 'core',
        action: 'delete',
        record: { type: RECORD_TYPE, id: before._id, label: labelOf(department, before) },
        before: snapshotForAudit(PositionModel, before),
        after: null,
      },
      { session },
    );
  });
}

/** Restores a retired position, unchanged. Its department must be live. */
export async function restorePosition(actor: OrgStructureActor, id: string): Promise<void> {
  assertCanManageOrgStructure(actor);

  await withTransaction(async (session) => {
    const before = await loadPosition(id, session);
    if (!before.deletedAt) throw new ActionError('This position isn’t retired.');
    const department = await claimLiveDepartment(before.departmentId, session);
    if (!department) {
      throw new ActionError('This position’s department is retired. Restore the department first.');
    }

    await PositionModel.updateOne(
      { _id: before._id, deletedAt: { $ne: null } },
      { $set: { deletedAt: null, updatedBy: toObjectId(actor.id) } },
      { session },
    );
    const after = await PositionModel.findById(before._id).session(session).lean().orFail();
    await recordAudit(
      {
        actorId: actor.id,
        actorEmail: actor.email,
        module: 'core',
        action: 'restore',
        record: { type: RECORD_TYPE, id: before._id, label: labelOf(department, after) },
        ...snapshotsForAudit(PositionModel, before, after),
      },
      { session },
    );
  });
}
