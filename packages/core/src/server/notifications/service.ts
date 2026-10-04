import type { ClientSession, Types } from 'mongoose';
import { z } from 'zod';
import { connectDb } from '@pulse/db';
import { AUDIT_MODULES, type AuditModule, RECORD_TYPE_PATTERN } from '../../audit';
import { now } from '../../dates';
import {
  isInternalHref,
  NOTIFICATION_BODY_MAX_LENGTH,
  NOTIFICATION_EVENT_PATTERN,
  NOTIFICATION_PAGE_MAX,
  NOTIFICATION_TITLE_MAX_LENGTH,
} from '../../notifications';
import { afterPosition, decodeCursor, encodeCursor, pageSize, toObjectId } from '../paging';
import { type NotificationRecord, NotificationModel } from './model';

// Spec: docs/modules/core.md#notifications — in-app notifications. Modules send them with
// `notify()`, inside their own transaction when the event comes from a change, and never touch the
// collection. Every read and update filters on the recipient, so a user only ever sees and marks
// their own. Opening the list and marking read are not audit-logged.
//
// No duplicate check yet: build step 1.7 adds one for the daily reminders.

/** The most recipients one `notify()` call takes. */
const MAX_RECIPIENTS = 5000;
/** The most ids one `markRead()` call takes. */
const MAX_MARK_IDS = 200;

// Control characters (but not tab or newline) are dropped from titles and bodies.
// eslint-disable-next-line no-control-regex -- control characters are what this strips
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Plain text cut to `max` characters, with an ellipsis when it was longer. */
function plainText(value: string, max: number): string {
  const text = value.replace(CONTROL_CHARACTERS, '').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

const objectIdInput = z.custom<Types.ObjectId | string>(
  (value) => toObjectId(value) !== null,
  'Expected an ObjectId.',
);

const notifySchema = z.object({
  recipients: z.array(objectIdInput).max(MAX_RECIPIENTS),
  module: z.enum(AUDIT_MODULES),
  event: z.string().max(100).regex(NOTIFICATION_EVENT_PATTERN),
  title: z.string().min(1),
  body: z.string().nullable().optional(),
  href: z.string().refine(isInternalHref, {
    message: 'A notification links to a page inside the app (a path starting with one /).',
  }),
  record: z
    .object({
      type: z.string().max(100).regex(RECORD_TYPE_PATTERN),
      id: objectIdInput.nullable(),
    })
    .nullable()
    .optional(),
});

export interface NotifyInput {
  /** The users to notify (user ids). Repeats are sent once. */
  recipients: readonly (Types.ObjectId | string)[];
  module: AuditModule;
  /** `<module>.<name>`, for example `core.holidayDeclared`. */
  event: string;
  /** Plain text; cut at 200 characters. */
  title: string;
  /** Plain text; cut at 1,000 characters. */
  body?: string | null;
  /** The page to open: a path inside the app, such as `/talent/leave/…`. */
  href: string;
  /** The record the notification is about. */
  record?: { type: string; id: Types.ObjectId | string | null } | null;
}

/** Thrown when a notification's input is invalid. Names the fields, never their values. */
export class NotificationInvalidError extends Error {
  constructor(paths: string[]) {
    super(`The notification is invalid (${paths.join(', ') || 'input'}). Nothing was sent.`);
    this.name = 'NotificationInvalidError';
  }
}

/**
 * Sends one in-app notification to each recipient. Pass the session of the transaction that makes
 * the change, so the notifications commit or abort with it. Returns how many were written.
 */
export async function notify(
  input: NotifyInput,
  { session }: { session?: ClientSession } = {},
): Promise<number> {
  const parsed = notifySchema.safeParse(input);
  if (!parsed.success) {
    throw new NotificationInvalidError(
      parsed.error.issues.map((issue) => issue.path.map(String).join('.')),
    );
  }
  const { recipients, module, event, title, body, href, record } = parsed.data;
  const unique = new Map<string, Types.ObjectId>();
  for (const recipient of recipients) {
    const id = toObjectId(recipient);
    if (id) unique.set(id.toHexString(), id);
  }
  if (unique.size === 0) return 0;

  const cleanTitle = plainText(title, NOTIFICATION_TITLE_MAX_LENGTH);
  if (!cleanTitle) throw new NotificationInvalidError(['title']);
  const cleanBody = body ? plainText(body, NOTIFICATION_BODY_MAX_LENGTH) || null : null;
  const ref = record ? { type: record.type, id: record.id ? toObjectId(record.id) : null } : null;

  await connectDb();
  const docs = [...unique.values()].map((recipientUserId) => ({
    recipientUserId,
    module,
    event,
    title: cleanTitle,
    body: cleanBody,
    href,
    record: ref,
    readAt: null,
  }));
  // `create` (not insertMany) so the session reaches the index check; ordered, as Mongoose
  // requires for several documents in a session.
  const created = await NotificationModel.create(docs, { session, ordered: true });
  return created.length;
}

/**
 * Of `recipients`, the user ids (hex strings) that already got a notification for `event` at or
 * after `since`. For a sender's own once-a-day check, such as the company details reminder
 * (docs/modules/core.md#company-settings-page); `notify()` itself has no duplicate check until
 * build step 1.7.
 */
export async function recipientsNotifiedSince(
  event: string,
  since: Date,
  recipients: readonly (Types.ObjectId | string)[],
): Promise<Set<string>> {
  const ids = recipients.map((id) => toObjectId(id)).filter((id) => id !== null);
  if (ids.length === 0 || !NOTIFICATION_EVENT_PATTERN.test(event)) return new Set();
  await connectDb();
  const found = await NotificationModel.distinct('recipientUserId', {
    recipientUserId: { $in: ids },
    event,
    createdAt: { $gte: since },
  });
  return new Set(found.map((id) => String(id)));
}

/** How many unread notifications the user has (the badge). */
export async function countUnread(userId: string): Promise<number> {
  const recipientUserId = toObjectId(userId);
  if (!recipientUserId) return 0;
  await connectDb();
  return NotificationModel.countDocuments({ recipientUserId, readAt: null });
}

/** One notification, as the list shows it. */
export interface NotificationView {
  id: string;
  module: AuditModule;
  event: string;
  title: string;
  body: string | null;
  href: string;
  record: { type: string; id: string | null } | null;
  readAt: Date | null;
  createdAt: Date;
}

export interface NotificationPage {
  notifications: NotificationView[];
  /** Pass back as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
}

export interface ListNotificationsOptions {
  cursor?: string | null;
  /** 20 by default, at most NOTIFICATION_PAGE_MAX. */
  limit?: number;
  /** Only unread ones. */
  unreadOnly?: boolean;
}

function toView(record: NotificationRecord): NotificationView {
  return {
    id: record._id.toHexString(),
    module: record.module,
    event: record.event,
    title: record.title,
    body: record.body ?? null,
    href: record.href,
    record: record.record
      ? { type: record.record.type, id: record.record.id?.toHexString() ?? null }
      : null,
    readAt: record.readAt ?? null,
    createdAt: record.createdAt,
  };
}

/** One page of the user's own notifications, newest first. */
export async function listNotifications(
  userId: string,
  { cursor, limit, unreadOnly = false }: ListNotificationsOptions = {},
): Promise<NotificationPage> {
  const recipientUserId = toObjectId(userId);
  if (!recipientUserId) return { notifications: [], nextCursor: null };
  const size = pageSize(limit, 20, NOTIFICATION_PAGE_MAX);
  const conditions: Record<string, unknown>[] = [{ recipientUserId }];
  if (unreadOnly) conditions.push({ readAt: null });
  if (cursor) conditions.push(afterPosition(decodeCursor(cursor)));

  await connectDb();
  const rows = await NotificationModel.find({ $and: conditions })
    .sort({ createdAt: -1, _id: -1 })
    .limit(size + 1)
    .lean<NotificationRecord[]>();
  const page = rows.slice(0, size);
  const last = page.at(-1);
  return {
    notifications: page.map(toView),
    nextCursor: rows.length > size && last ? encodeCursor(last) : null,
  };
}

/**
 * Marks the user's own notifications read. Ids that aren't the user's, are already read or aren't
 * ids at all are ignored. Returns how many changed.
 */
export async function markRead(userId: string, ids: readonly string[]): Promise<number> {
  const recipientUserId = toObjectId(userId);
  if (!recipientUserId) return 0;
  const objectIds = ids
    .slice(0, MAX_MARK_IDS)
    .map(toObjectId)
    .filter((id): id is Types.ObjectId => id !== null);
  if (objectIds.length === 0) return 0;
  await connectDb();
  const result = await NotificationModel.updateMany(
    { _id: { $in: objectIds }, recipientUserId, readAt: null },
    { $set: { readAt: now(), updatedBy: recipientUserId } },
  );
  return result.modifiedCount;
}

/** Marks all of the user's own notifications read. Returns how many changed. */
export async function markAllRead(userId: string): Promise<number> {
  const recipientUserId = toObjectId(userId);
  if (!recipientUserId) return 0;
  await connectDb();
  const result = await NotificationModel.updateMany(
    { recipientUserId, readAt: null },
    { $set: { readAt: now(), updatedBy: recipientUserId } },
  );
  return result.modifiedCount;
}
