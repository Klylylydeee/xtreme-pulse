import { Schema, type Types } from 'mongoose';
import { baseSchemaPlugin, defineModel } from '@pulse/db';
import {
  AUDIT_ACTIONS,
  AUDIT_LABEL_MAX_LENGTH,
  AUDIT_MODULES,
  AUDIT_REASON_MAX_LENGTH,
  type AuditAction,
  type AuditModule,
  RECORD_TYPE_MAX_LENGTH,
  RECORD_TYPE_PATTERN,
} from '../../audit';
import { guardWrites } from '../write-guards';

// Spec: docs/modules/core.md#audit-log and SECURITY.md#audit-logging — the append-only audit log.
//
// Every field is immutable, and guardWrites refuses every update, replace and delete, `save()` on a
// loaded entry, non-insert bulkWrite operations and `$out`/`$merge` in its aggregations. Entries
// are kept forever: no TTL index (docs/DATA_MODEL.md#retention).
//
// This model is private to the audit service: module code writes entries with `recordAudit` and
// reads them with `listAuditEntries`, never through the model. Like every guard here, the raw
// driver collection, `middleware: false`, `connection.bulkWrite` and another model's `$merge` or
// `$out` bypass it (accepted, SECURITY.md#audit-logging); ESLint bans the option keys and
// `connection.bulkWrite`.

export interface AuditRecordRef {
  /** `<module>.<name>`, for example `core.user`. */
  type: string;
  id: Types.ObjectId | null;
  /** Something to show for the record, such as an email or a document number. */
  label: string | null;
}

export interface AuditLogRecord {
  _id: Types.ObjectId;
  /** Null for a system action. */
  actorId: Types.ObjectId | null;
  /** The actor's email when the entry was written. */
  actorEmail: string | null;
  module: AuditModule;
  action: AuditAction;
  record: AuditRecordRef;
  /** Redacted snapshot before the change; null on create, reveal and export. */
  before: Record<string, unknown> | null;
  /** Redacted snapshot after the change; null on delete, reveal and export. */
  after: Record<string, unknown> | null;
  /** The fields revealed or exported (names only). */
  fields: string[];
  reason: string | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
}

const recordRefSchema = new Schema<AuditRecordRef>(
  {
    type: {
      type: String,
      required: true,
      immutable: true,
      maxlength: RECORD_TYPE_MAX_LENGTH,
      match: RECORD_TYPE_PATTERN,
    },
    id: { type: Schema.Types.ObjectId, default: null, immutable: true },
    label: { type: String, default: null, immutable: true, maxlength: AUDIT_LABEL_MAX_LENGTH },
  },
  { _id: false },
);

const auditLogSchema = new Schema<AuditLogRecord>(
  {
    actorId: { type: Schema.Types.ObjectId, default: null, immutable: true },
    actorEmail: { type: String, default: null, immutable: true, maxlength: 320 },
    module: { type: String, required: true, immutable: true, enum: AUDIT_MODULES },
    action: { type: String, required: true, immutable: true, enum: AUDIT_ACTIONS },
    record: { type: recordRefSchema, required: true, immutable: true },
    // Mixed: redacted JSON snapshots (snapshot.ts).
    before: { type: Schema.Types.Mixed, default: null, immutable: true },
    after: { type: Schema.Types.Mixed, default: null, immutable: true },
    fields: { type: [String], default: [], immutable: true },
    reason: {
      type: String,
      default: null,
      immutable: true,
      maxlength: AUDIT_REASON_MAX_LENGTH,
    },
  },
  // Keep empty objects in snapshots as they were.
  { minimize: false },
);

// Newest first, for the page; then by actor, module, action and record (the page's filters).
auditLogSchema.index({ createdAt: -1, _id: -1 });
auditLogSchema.index({ actorId: 1, createdAt: -1 });
auditLogSchema.index({ module: 1, createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });
auditLogSchema.index({ 'record.type': 1, 'record.id': 1, createdAt: -1 });

auditLogSchema.plugin(baseSchemaPlugin, { softDelete: false });
// The base fields are fixed too once written.
auditLogSchema.path('createdAt').immutable(true);
auditLogSchema.path('updatedAt').immutable(true);
auditLogSchema.path('updatedBy').immutable(true);

guardWrites(auditLogSchema, {
  message: 'Audit log entries are never changed or deleted. Write a new entry instead.',
});

export const AuditLogModel = defineModel('AuditLog', auditLogSchema, 'auditLogs');
