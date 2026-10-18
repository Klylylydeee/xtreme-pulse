import { type ClientSession, Types } from 'mongoose';
import { ActionError } from '@pulse/core';
import { recordAudit, snapshotForAudit, snapshotsForAudit } from '@pulse/core/server';
import { RECORD_CHANGED_ELSEWHERE } from '../../validation';
import { EMPLOYEE_RECORD_TYPE } from '../../views';
import {
  EMPLOYEE_RECORD_SENSITIVE_SELECT,
  type EmployeeRecordDocument,
  EmployeeRecordModel,
} from './model';

// The one write path of an employee record (server-only), shared by the section saves, the own
// entries, "Mark verified", "No supervisor" and the change request approval hook: in the caller's
// transaction, it creates the record on the first save (`create` entry) or updates it with the
// `version` check (`update` entry, both sides snapshotted, so a sensitive value shows only as
// "Hidden (sensitive), changed").

/** The stored record with its sensitive paths, in the caller's transaction, or null. */
export async function loadRecordForWrite(
  employeeId: string | Types.ObjectId,
  session: ClientSession,
): Promise<EmployeeRecordDocument | null> {
  return (await EmployeeRecordModel.findOne({ employeeId: new Types.ObjectId(employeeId) })
    .select(EMPLOYEE_RECORD_SENSITIVE_SELECT)
    .session(session)
    .lean()) as EmployeeRecordDocument | null;
}

export interface RecordWrite {
  actor: { id: string; email: string };
  employeeId: string;
  /** The audit label: `<employee number> · <first name> <last name>`. */
  label: string;
  /** The record as loaded in this transaction ({@link loadRecordForWrite}), or null for none. */
  existing: EmployeeRecordDocument | null;
  /** The fields to set, as dotted paths; sensitive values already encrypted. */
  changes: Record<string, unknown>;
  /** The audit entry's reason. */
  reason?: string | null;
  session: ClientSession;
}

/** Writes `changes` and its audit entry. Returns the record's id and new version. */
export async function writeEmployeeRecord({
  actor,
  employeeId,
  label,
  existing,
  changes,
  reason = null,
  session,
}: RecordWrite): Promise<{ recordId: Types.ObjectId; version: number }> {
  if (!existing) {
    const record = new EmployeeRecordModel({
      employeeId: new Types.ObjectId(employeeId),
      version: 1,
      createdBy: actor.id,
      updatedBy: actor.id,
    });
    record.set(changes);
    await record.save({ session });
    await recordAudit(
      {
        actorId: actor.id,
        actorEmail: actor.email,
        module: 'talent',
        action: 'create',
        record: { type: EMPLOYEE_RECORD_TYPE, id: record._id, label },
        before: null,
        after: snapshotForAudit(EmployeeRecordModel, record),
        reason,
      },
      { session },
    );
    return { recordId: record._id, version: 1 };
  }

  const updated = (await EmployeeRecordModel.findOneAndUpdate(
    { _id: existing._id, version: existing.version },
    { $set: { ...changes, updatedBy: actor.id }, $inc: { version: 1 } },
    { session, returnDocument: 'after', runValidators: true },
  )
    .select(EMPLOYEE_RECORD_SENSITIVE_SELECT)
    .lean()) as EmployeeRecordDocument | null;
  if (!updated) throw new ActionError(RECORD_CHANGED_ELSEWHERE);
  const { before, after } = snapshotsForAudit(EmployeeRecordModel, existing, updated);
  await recordAudit(
    {
      actorId: actor.id,
      actorEmail: actor.email,
      module: 'talent',
      action: 'update',
      record: { type: EMPLOYEE_RECORD_TYPE, id: existing._id, label },
      before,
      after,
      reason,
    },
    { session },
  );
  return { recordId: existing._id, version: updated.version };
}
