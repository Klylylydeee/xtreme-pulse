import { type ClientSession, Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { isDuplicateKey } from '../shared';
import { TimeOffFilingLockModel } from './model';

// Spec: docs/DATA_MODEL.md#collection-ownership (`timeOffRequests`: "Overlap is checked in a
// transaction serialized per employee") and decision 310 in docs/BUILD_PLAN.md. Every filing,
// resend and approval of an employee's time off raises the employee's lock document first in its
// transaction, so two of them always write the same document: MongoDB aborts one with a
// TransientTransactionError and `withTransaction` retries it with the other's request visible.

function idOf(employeeId: string | Types.ObjectId): Types.ObjectId {
  return typeof employeeId === 'string' ? new Types.ObjectId(employeeId) : employeeId;
}

/**
 * Creates the employee's lock document when there is none, outside any transaction (two first
 * filings creating it at once would otherwise collide on its unique index inside their
 * transactions). Idempotent.
 */
export async function ensureTimeOffLock(employeeId: string | Types.ObjectId): Promise<void> {
  await connectDb();
  try {
    await TimeOffFilingLockModel.updateOne(
      { employeeId: idOf(employeeId) },
      { $setOnInsert: { touches: 0 } },
      { upsert: true },
    );
  } catch (error) {
    // Another request created it at the same moment.
    if (!isDuplicateKey(error)) throw error;
  }
}

/** Raises the employee's lock in `session` (created when missing, as a fallback). */
export async function touchTimeOffLock(
  employeeId: string | Types.ObjectId,
  session: ClientSession,
): Promise<void> {
  await TimeOffFilingLockModel.updateOne(
    { employeeId: idOf(employeeId) },
    { $inc: { touches: 1 } },
    { session, upsert: true },
  );
}
