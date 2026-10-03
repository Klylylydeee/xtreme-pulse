import type { ClientSession, Types } from 'mongoose';
import { z } from 'zod';
import { connectDb } from '@pulse/db';
import {
  AUDIT_ACTIONS,
  AUDIT_LABEL_MAX_LENGTH,
  AUDIT_MODULES,
  AUDIT_PAGE_MAX,
  AUDIT_REASON_MAX_LENGTH,
  type AuditAction,
  type AuditFilters,
  type AuditModule,
  RECORD_TYPE_MAX_LENGTH,
  RECORD_TYPE_PATTERN,
} from '../../audit';
import { addDays, startOfBusinessDate } from '../../dates';
import { afterPosition, decodeCursor, encodeCursor, pageSize, toObjectId } from '../paging';
import { type AuditLogRecord, AuditLogModel } from './model';
import { type AuditSnapshot, redactForAudit } from './snapshot';

// Spec: docs/modules/core.md#audit-log, SECURITY.md#audit-logging and
// docs/ARCHITECTURE.md#architecture-rules.
//
// How a module records a change: inside its own `withTransaction`, make the change, then call
// `recordAudit(…, { session })` with the actor and redacted snapshots: `snapshotsForAudit` for an
// update (it also marks sensitive fields that changed), `snapshotForAudit` for a create or delete.
// The entry and the change commit or abort together; if the entry can't be written, the change
// fails with it.
//
// ```ts
// await withTransaction(async (session) => {
//   const original = client.toObject();
//   client.set(changes);
//   await client.save({ session });
//   const { before, after } = snapshotsForAudit(ClientModel, original, client);
//   await recordAudit(
//     {
//       actorId: actor.id,
//       actorEmail: actor.email,
//       module: 'core',
//       action: 'update',
//       record: { type: 'core.client', id: client._id, label: client.name },
//       before,
//       after,
//     },
//     { session },
//   );
// });
// ```

const objectIdInput = z.custom<Types.ObjectId | string>(
  (value) => toObjectId(value) !== null,
  'Expected an ObjectId.',
);

const recordAuditSchema = z.object({
  actorId: objectIdInput.nullable(),
  actorEmail: z.string().max(320).nullable(),
  module: z.enum(AUDIT_MODULES),
  action: z.enum(AUDIT_ACTIONS),
  record: z.object({
    type: z.string().max(RECORD_TYPE_MAX_LENGTH).regex(RECORD_TYPE_PATTERN),
    id: objectIdInput.nullable(),
    label: z.string().max(AUDIT_LABEL_MAX_LENGTH).nullable().optional(),
  }),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  fields: z.array(z.string().min(1).max(200)).max(200).optional(),
  reason: z.string().trim().max(AUDIT_REASON_MAX_LENGTH).nullable().optional(),
});

export interface RecordAuditInput {
  /** The user who did it; null for a system action (a scheduled job). */
  actorId: Types.ObjectId | string | null;
  /** The actor's email, kept as it is now. */
  actorEmail: string | null;
  module: AuditModule;
  action: AuditAction;
  record: {
    /** `<module>.<name>`, for example `core.user`. */
    type: string;
    id: Types.ObjectId | string | null;
    /** Something to show for the record, such as an email or document number. */
    label?: string | null;
  };
  /** The record before the change (`snapshotsForAudit` or `snapshotForAudit`); null on create. */
  before?: unknown;
  /** The record after the change (`snapshotsForAudit` or `snapshotForAudit`); null on delete. */
  after?: unknown;
  /** The fields revealed or exported (names only, never values). */
  fields?: string[];
  reason?: string | null;
}

/** Thrown when an entry's input is invalid. Names the fields, never their values. */
export class AuditEntryInvalidError extends Error {
  constructor(paths: string[]) {
    super(`The audit log entry is invalid (${paths.join(', ') || 'input'}). Nothing was written.`);
    this.name = 'AuditEntryInvalidError';
  }
}

/**
 * Writes one audit log entry. Pass the session of the transaction that makes the change, so both
 * commit or abort together. `before` and `after` are redacted again here (the backstop in
 * snapshot.ts), whatever the caller passed. Every error propagates: a change whose entry can't be
 * written must fail.
 */
export async function recordAudit(
  input: RecordAuditInput,
  { session }: { session?: ClientSession } = {},
): Promise<{ id: string }> {
  const parsed = recordAuditSchema.safeParse(input);
  if (!parsed.success) {
    throw new AuditEntryInvalidError(
      parsed.error.issues.map((issue) => issue.path.map(String).join('.')),
    );
  }
  const entry = parsed.data;
  const actorId = entry.actorId === null ? null : toObjectId(entry.actorId);
  await connectDb();
  const [created] = await AuditLogModel.create(
    [
      {
        actorId,
        actorEmail: entry.actorEmail,
        module: entry.module,
        action: entry.action,
        record: {
          type: entry.record.type,
          id: entry.record.id === null ? null : toObjectId(entry.record.id),
          label: entry.record.label ?? null,
        },
        before: redactForAudit(entry.before),
        after: redactForAudit(entry.after),
        fields: entry.fields ?? [],
        reason: entry.reason || null,
        createdBy: actorId,
      },
    ],
    { session },
  );
  if (!created) throw new Error('The audit log entry was not written.');
  return { id: created._id.toHexString() };
}

/** One audit entry, as the audit log page shows it. Plain values only. */
export interface AuditEntryView {
  id: string;
  actorId: string | null;
  actorEmail: string | null;
  module: AuditModule;
  action: AuditAction;
  record: { type: string; id: string | null; label: string | null };
  before: AuditSnapshot | null;
  after: AuditSnapshot | null;
  fields: string[];
  reason: string | null;
  createdAt: Date;
}

export interface AuditPage {
  entries: AuditEntryView[];
  /** Pass back as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
}

export interface ListAuditOptions {
  /** From the previous page's `nextCursor`. */
  cursor?: string | null;
  /** Entries per page: 50 by default, at most AUDIT_PAGE_MAX. */
  limit?: number;
}

function toView(record: AuditLogRecord): AuditEntryView {
  return {
    id: record._id.toHexString(),
    actorId: record.actorId ? record.actorId.toHexString() : null,
    actorEmail: record.actorEmail ?? null,
    module: record.module,
    action: record.action,
    record: {
      type: record.record.type,
      id: record.record.id ? record.record.id.toHexString() : null,
      label: record.record.label ?? null,
    },
    before: record.before ?? null,
    after: record.after ?? null,
    fields: record.fields ?? [],
    reason: record.reason ?? null,
    createdAt: record.createdAt,
  };
}

/**
 * One page of the audit log, newest first, with the filters applied (parse them with
 * `auditFiltersSchema`). Dates are Manila calendar days, both included. A read only: it writes no
 * entry. The caller checks that the viewer may see the audit log (the System Administrator).
 */
export async function listAuditEntries(
  filters: AuditFilters = {},
  { cursor, limit }: ListAuditOptions = {},
): Promise<AuditPage> {
  const size = pageSize(limit, 50, AUDIT_PAGE_MAX);
  const conditions: Record<string, unknown>[] = [];

  const createdAt: Record<string, Date> = {};
  if (filters.from) createdAt.$gte = startOfBusinessDate(filters.from);
  if (filters.to) createdAt.$lt = startOfBusinessDate(addDays(filters.to, 1));
  if (Object.keys(createdAt).length) conditions.push({ createdAt });
  if (filters.actorId) conditions.push({ actorId: toObjectId(filters.actorId) });
  if (filters.module) conditions.push({ module: filters.module });
  if (filters.action) conditions.push({ action: filters.action });
  if (filters.recordType) conditions.push({ 'record.type': filters.recordType });
  if (filters.recordId) conditions.push({ 'record.id': toObjectId(filters.recordId) });
  if (cursor) conditions.push(afterPosition(decodeCursor(cursor)));

  await connectDb();
  const rows = await AuditLogModel.find(conditions.length ? { $and: conditions } : {})
    .sort({ createdAt: -1, _id: -1 })
    .limit(size + 1)
    .lean<AuditLogRecord[]>();

  const page = rows.slice(0, size);
  const last = page.at(-1);
  return {
    entries: page.map(toView),
    nextCursor: rows.length > size && last ? encodeCursor(last) : null,
  };
}
