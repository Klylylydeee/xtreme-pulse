import { z } from 'zod';
import { businessDateField, OBJECT_ID_PATTERN } from '@pulse/core';
import { employeeIdField } from '../validation';
import {
  clockTimeField,
  EXTRA_HOURS_REASON_MAX_LENGTH,
  SCHEDULE_REASON_MAX_LENGTH,
  TIME_ENTRY_ACTIVITY_MAX_LENGTH,
  workScheduleSchema,
} from './schemas';

// Spec: docs/modules/talent.md#work-schedules-and-daily-time-entries-build-step-24 ("Work
// schedules", "Time entries"; decisions 215, 219 and 220 in docs/BUILD_PLAN.md) — the inputs of
// "Set schedule" and of the entry sheet, as the services take them. Pure code, safe in the browser:
// the forms parse with the same schemas, and the services parse again.
//
// The browser never sends a source: a time typed or changed in the sheet is `manual`, and only the
// Time in and Time out services store `clock`. No employee id is taken for a time entry: the
// services act on the signed-in user's own employee.

const trimmed = (value: unknown) => (typeof value === 'string' ? value.trim() : value);

const scheduleReasonField = z.preprocess(
  trimmed,
  z
    .string({ error: 'Enter the reason for this schedule.' })
    .min(1, 'Enter the reason for this schedule.')
    .max(SCHEDULE_REASON_MAX_LENGTH, `Use at most ${SCHEDULE_REASON_MAX_LENGTH} characters.`),
);

/** "Set schedule": an employee's own schedule (or null, "back to the company default") from a day. */
export const setWorkScheduleSchema = z.object({
  employeeId: employeeIdField,
  effectiveFrom: businessDateField('Enter the effective date.'),
  schedule: workScheduleSchema.nullable(),
  reason: scheduleReasonField,
});
export type SetWorkScheduleInput = z.input<typeof setWorkScheduleSchema>;

/** The activity: empty means none (only an open entry may have none). */
export const activityField = z.preprocess(
  (value) => {
    const text = trimmed(value);
    return text === '' || text === undefined ? null : text;
  },
  z
    .string({ error: 'Enter the activity performed.' })
    .max(
      TIME_ENTRY_ACTIVITY_MAX_LENGTH,
      `Use at most ${TIME_ENTRY_ACTIVITY_MAX_LENGTH} characters.`,
    )
    .nullable(),
);

/** The client: empty means none. */
export const entryClientField = z.preprocess(
  (value) => (value === '' || value === undefined ? null : value),
  z.string({ error: 'Choose a client.' }).regex(OBJECT_ID_PATTERN, 'Choose a client.').nullable(),
);

/** The extra-hours mark's reason: null (or empty) leaves the entry unmarked. */
export const extraHoursReasonField = z.preprocess(
  (value) => {
    const text = trimmed(value);
    return text === '' || text === undefined ? null : text;
  },
  z
    .string({ error: 'Enter the reason for the extra hours.' })
    .max(EXTRA_HOURS_REASON_MAX_LENGTH, `Use at most ${EXTRA_HOURS_REASON_MAX_LENGTH} characters.`)
    .nullable(),
);

const entryFields = {
  /** The Manila day of the time in. */
  date: businessDateField('Enter the date.'),
  /** `HH:MM` on `date`. */
  timeIn: clockTimeField,
  /** `HH:MM`, on `date` or (with `timeOutNextDay`) the day after; null leaves the entry open. */
  timeOut: z.preprocess((value) => (value === '' ? null : value), clockTimeField.nullable()),
  /** The "Next day" switch. */
  timeOutNextDay: z.boolean().default(false),
  activity: activityField,
  clientId: entryClientField,
  /** "Count extra hours as overtime (offset)": its reason, or null when the switch is off. */
  extraHoursReason: extraHoursReasonField,
};

/** "Add entry" on the day sheet: manual times. */
export const createTimeEntrySchema = z.object(entryFields);
export type CreateTimeEntryInput = z.input<typeof createTimeEntrySchema>;

const entryIdField = z
  .string({ error: 'This entry can’t be found. Reload to see it.' })
  .regex(OBJECT_ID_PATTERN, 'This entry can’t be found. Reload to see it.');
const versionField = z
  .number({ error: 'Reload the page and try again.' })
  .int('Reload the page and try again.')
  .min(1, 'Reload the page and try again.');

/**
 * The edit sheet: the whole entry, with the `version` it was loaded at. A time sent unchanged
 * (the same minute) keeps its stored instant and source; a changed one becomes `manual`.
 */
export const updateTimeEntrySchema = z.object({
  entryId: entryIdField,
  version: versionField,
  ...entryFields,
});
export type UpdateTimeEntryInput = z.input<typeof updateTimeEntrySchema>;

/** "Delete entry", after the confirmation. */
export const deleteTimeEntrySchema = z.object({ entryId: entryIdField, version: versionField });
export type DeleteTimeEntryInput = z.input<typeof deleteTimeEntrySchema>;

/**
 * Time out: the server's time. The sheet it opens when the entry has no activity sends the
 * activity (and may send the client and the extra-hours mark); a field left out is unchanged.
 */
export const timeOutSchema = z.object({
  activity: activityField.optional(),
  clientId: entryClientField.optional(),
  extraHoursReason: extraHoursReasonField.optional(),
});
export type TimeOutInput = z.input<typeof timeOutSchema>;
