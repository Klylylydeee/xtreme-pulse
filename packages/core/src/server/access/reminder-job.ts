import { z } from 'zod';
import { now, toBusinessDate } from '../../dates';
import { activeHrAndSystemAdministrators } from '../auth/admin-recipients';
import { defineJob, defineSchedule } from '../jobs/define';
import { notify } from '../notifications/service';
import { countUsersNeedingAccess } from './service';

// Spec: docs/modules/core.md#user-access-page and docs/ARCHITECTURE.md#background-jobs — the
// users-needing-access reminder (decision 72). Daily at 08:00 Asia/Manila, weekends included,
// while any user needs access (decision 68), it notifies every active HR user and System
// Administrator (event `core.usersNeedAccess`, linking `/admin/access`). It has no actor, so
// nobody is left out. It is idempotent per Manila day through `notify()`'s duplicate check (key
// `core.accessReminder:<Manila date>`): a retry or a second run sends nothing twice.

/** The notification event. */
export const USERS_NEED_ACCESS_EVENT = 'core.usersNeedAccess';

/** The job: no data, everything is read when it runs. */
export const ACCESS_REMINDER_JOB = defineJob('core.accessReminder', { schema: z.object({}) });

/** Every day at 8:00 AM Manila. */
export const ACCESS_REMINDER_SCHEDULE = defineSchedule({
  id: 'core.accessReminder',
  job: ACCESS_REMINDER_JOB,
  data: {},
  pattern: '0 8 * * *',
});

const ACCESS_HREF = '/admin/access';

export interface AccessReminderResult {
  /** How many users need access (0 means nothing was sent). */
  needingAccess: number;
  /** Notifications written in this run. */
  notified: number;
  /** Recipients skipped because they already got the reminder that Manila day. */
  skipped: number;
}

/** The duplicate check's key for the Manila day of `at`. */
export function accessReminderKey(at: Date): string {
  return `core.accessReminder:${toBusinessDate(at)}`;
}

/**
 * Sends the users-needing-access reminder for the Manila day of `at`, if anyone needs access. Safe
 * to run again: recipients who already got it that day are skipped.
 */
export async function runAccessReminder(at: Date = now()): Promise<AccessReminderResult> {
  const needingAccess = await countUsersNeedingAccess();
  if (needingAccess === 0) return { needingAccess: 0, notified: 0, skipped: 0 };

  const recipients = await activeHrAndSystemAdministrators();
  const notified = await notify({
    recipients: recipients.map((recipient) => recipient.id),
    module: 'core',
    event: USERS_NEED_ACCESS_EVENT,
    title:
      needingAccess === 1
        ? '1 user still needs access'
        : `${needingAccess} users still need access`,
    body: 'Set their module access on the User access page.',
    href: ACCESS_HREF,
    dedupeKey: accessReminderKey(at),
  });
  return { needingAccess, notified, skipped: recipients.length - notified };
}
