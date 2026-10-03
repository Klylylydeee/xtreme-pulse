'use server';

import { z } from 'zod';
import { defineAction, NOTIFICATION_PAGE_MAX, OBJECT_ID_PATTERN } from '@pulse/core';
import { countUnread, listNotifications, markAllRead, markRead } from '@pulse/core/server';
import { requireSignedIn, signedInUser } from '@/lib/auth';

// Spec: docs/modules/core.md#notifications — the signed-in user's own notifications. Pulse Core is
// open to every active user, so each action needs only a signed-in user; the services filter every
// query on that user, so no one can read or mark someone else's. None of these is audit-logged.

/** The unread count for the toolbar badge. */
export const countUnreadNotificationsAction = defineAction({
  access: requireSignedIn(),
  schema: z.object({}),
  handler: async () => countUnread((await signedInUser()).id),
});

/** One page of the user's notifications, newest first. */
export const listNotificationsAction = defineAction({
  access: requireSignedIn(),
  schema: z.object({
    cursor: z.string().max(200).nullish(),
    limit: z.coerce.number().int().min(1).max(NOTIFICATION_PAGE_MAX).optional(),
    unreadOnly: z
      .union([z.boolean(), z.enum(['true', 'false'])])
      .optional()
      .transform((value) => value === true || value === 'true'),
  }),
  handler: async (input) =>
    listNotifications((await signedInUser()).id, {
      cursor: input.cursor ?? null,
      limit: input.limit,
      unreadOnly: input.unreadOnly,
    }),
});

const notificationIds = z.preprocess(
  (value) => (Array.isArray(value) ? value : value === undefined ? [] : [value]),
  z.array(z.string().regex(OBJECT_ID_PATTERN)).min(1).max(200),
);

/** Marks some of the user's notifications read (for example the one just opened). */
export const markNotificationsReadAction = defineAction({
  access: requireSignedIn(),
  schema: z.object({ ids: notificationIds }),
  handler: async (input) => markRead((await signedInUser()).id, input.ids),
});

/** Marks all of the user's notifications read. */
export const markAllNotificationsReadAction = defineAction({
  access: requireSignedIn(),
  schema: z.object({}),
  handler: async () => markAllRead((await signedInUser()).id),
});
