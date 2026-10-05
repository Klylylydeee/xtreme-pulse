import type { ClientSession, Types } from 'mongoose';
import { type DepartmentRecord, DepartmentModel } from './departments/model';
import { type PositionRecord, PositionModel } from './positions/model';

// Spec: docs/modules/core.md#managing-departments-and-positions and #managing-user-accounts
// (decision 45 in docs/BUILD_PLAN.md) — adding or restoring a position, creating a user, changing
// an employee's department or position, and moving a separated employee back to an active status
// write the department (and position) record in their transaction, so an overlapping retire
// conflicts and is retried.
//
// Why a write and not a read: `retireDepartment` counts live positions and active employees and
// then writes the department, and `retirePosition` counts active holders and then writes the
// position. A transaction that only read the record could commit a live position or an active
// employee next to the retirement (write skew under snapshot isolation). With both writing the
// same record, one fails with a write conflict and `withTransaction` retries it, and the retry
// sees the other's result.
//
// Each write only bumps the version key, with timestamps off, so `updatedAt` and `updatedBy` keep
// saying who last edited the record, and no audit entry is due (`__v` isn't snapshotted).

/**
 * Writes to the department in the transaction and returns its code, or null when it is retired
 * or unknown.
 */
export async function claimLiveDepartment(
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

/**
 * Writes to the position in the transaction and returns its department and name, or null when it
 * is retired or unknown. The caller checks the position belongs to the department it claimed.
 */
export async function claimLivePosition(
  positionId: Types.ObjectId,
  session: ClientSession,
): Promise<Pick<PositionRecord, 'departmentId' | 'name'> | null> {
  const result = await PositionModel.updateOne(
    { _id: positionId, deletedAt: null },
    { $inc: { __v: 1 } },
    { session, timestamps: false },
  );
  if (result.matchedCount !== 1) return null;
  return PositionModel.findById(positionId, { departmentId: 1, name: 1 })
    .session(session)
    .lean()
    .orFail();
}
