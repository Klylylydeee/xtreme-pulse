import { Schema, type Types } from 'mongoose';
import { baseSchemaPlugin, defineModel } from '@pulse/db';
import { AUDIT_MODULES, type AuditModule, RECORD_TYPE_PATTERN } from '../../audit';
import {
  isInternalHref,
  NOTIFICATION_BODY_MAX_LENGTH,
  NOTIFICATION_EVENT_PATTERN,
  NOTIFICATION_TITLE_MAX_LENGTH,
} from '../../notifications';
import { guardWrites, hasOnlyKeys } from '../write-guards';

// Spec: docs/modules/core.md#notifications — one in-app notification per recipient. Everything but
// `readAt` is fixed once written, and the only allowed update sets `readAt` (marking read). Kept
// forever: no TTL index (docs/DATA_MODEL.md#retention).
//
// Private to the notification service: modules send with `notify()` and never use this model.

export interface NotificationRecordRef {
  type: string;
  id: Types.ObjectId | null;
}

export interface NotificationRecord {
  _id: Types.ObjectId;
  recipientUserId: Types.ObjectId;
  module: AuditModule;
  /** `<module>.<name>`, for example `core.holidayDeclared`. */
  event: string;
  title: string;
  body: string | null;
  /** A path inside the app (`isInternalHref`). */
  href: string;
  record: NotificationRecordRef | null;
  /** Null while unread. */
  readAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
}

const recordRefSchema = new Schema<NotificationRecordRef>(
  {
    type: {
      type: String,
      required: true,
      immutable: true,
      maxlength: 100,
      match: RECORD_TYPE_PATTERN,
    },
    id: { type: Schema.Types.ObjectId, default: null, immutable: true },
  },
  { _id: false },
);

const notificationSchema = new Schema<NotificationRecord>({
  recipientUserId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  module: { type: String, required: true, immutable: true, enum: AUDIT_MODULES },
  event: {
    type: String,
    required: true,
    immutable: true,
    maxlength: 100,
    match: NOTIFICATION_EVENT_PATTERN,
  },
  title: {
    type: String,
    required: true,
    immutable: true,
    maxlength: NOTIFICATION_TITLE_MAX_LENGTH,
  },
  body: { type: String, default: null, immutable: true, maxlength: NOTIFICATION_BODY_MAX_LENGTH },
  href: {
    type: String,
    required: true,
    immutable: true,
    validate: {
      validator: isInternalHref,
      message: 'A notification links to a page inside the app (a path starting with /).',
    },
  },
  record: { type: recordRefSchema, default: null, immutable: true },
  readAt: { type: Date, default: null },
});

// The unread badge, then the list (newest first, keyset paging).
notificationSchema.index({ recipientUserId: 1, readAt: 1, createdAt: -1 });
notificationSchema.index({ recipientUserId: 1, createdAt: -1, _id: -1 });

notificationSchema.plugin(baseSchemaPlugin, { softDelete: false });

// What marking read may change. Mongoose's timestamps add `updatedAt` to `$set` and `createdAt` to
// `$setOnInsert` (which never applies: upserts are refused).
const UPDATE_OPERATORS = new Set(['$set', '$setOnInsert']);
const READ_FIELDS = new Set(['readAt', 'updatedAt', 'updatedBy']);
const INSERT_ONLY_FIELDS = new Set(['createdAt']);

function isMarkRead(update: unknown, options: { upsert?: unknown }): boolean {
  if (options.upsert) return false;
  if (!hasOnlyKeys(update, UPDATE_OPERATORS)) return false;
  const { $set, $setOnInsert } = update as { $set?: unknown; $setOnInsert?: unknown };
  if ($setOnInsert !== undefined && !hasOnlyKeys($setOnInsert, INSERT_ONLY_FIELDS)) return false;
  if (!hasOnlyKeys($set, READ_FIELDS)) return false;
  return (($set as { readAt?: unknown }).readAt ?? null) instanceof Date;
}

guardWrites(notificationSchema, {
  message: 'Notifications are never edited or deleted; only marking them read is allowed.',
  allowUpdate: (update, query) => isMarkRead(update, query.getOptions()),
  allowManyUpdates: true,
});

export const NotificationModel = defineModel('Notification', notificationSchema, 'notifications');
