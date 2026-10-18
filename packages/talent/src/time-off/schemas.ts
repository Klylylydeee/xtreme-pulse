import { z } from 'zod';
import { businessDateField, OBJECT_ID_PATTERN } from '@pulse/core';
import { clockTimeField } from '../timesheets/schemas';
import {
  LEAVE_ENTRY_REASON_MAX_LENGTH,
  TIME_OFF_CANCEL_REASON_MAX_LENGTH,
  TIME_OFF_PORTIONS,
  TIME_OFF_REASON_MAX_LENGTH,
} from './kinds';
import { minutesOfHoursText, parseDaysText } from './units';

// Spec: docs/modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28 ("Time off
// requests", "Opening balances"; decisions 307, 309 and 314 in docs/BUILD_PLAN.md) — the inputs of
// the request sheet, the cancel, and HR's opening entries and corrections, as the services take
// them. Pure code, safe in the browser: the forms parse with the same schemas, and the services
// parse again. No employee id is taken on a request: the service files the signed-in user's own.
// The attachment travels beside the input (form field `attachment`), not in it.

/** Opening leave runs from 0 to 365 days. */
export const LEAVE_OPENING_DAYS_MAX = 365;

const trimmed = (value: unknown) => (typeof value === 'string' ? value.trim() : value);
const emptyToNull = (value: unknown) => {
  const text = trimmed(value);
  return text === '' || text === undefined ? null : text;
};

const optionalText = (max: number) =>
  z.preprocess(emptyToNull, z.string().max(max, `Use at most ${max} characters.`).nullable());

const requiredText = (missing: string, max: number) =>
  z.preprocess(
    trimmed,
    z.string({ error: missing }).min(1, missing).max(max, `Use at most ${max} characters.`),
  );

const portionField = z.enum(TIME_OFF_PORTIONS, { error: 'Choose the part of the day.' });
const optionalTime = z.preprocess(emptyToNull, clockTimeField.nullable());

/** The fields both kinds share. */
const requestFields = {
  startDate: businessDateField('Enter the first day.'),
  endDate: businessDateField('Enter the last day.'),
  portion: portionField,
  reason: optionalText(TIME_OFF_REASON_MAX_LENGTH),
};

/** A leave request from the sheet ("Leave"). */
export const leaveRequestInputSchema = z
  .object({
    kind: z.literal('leave'),
    leaveTypeKey: z
      .string({ error: 'Choose the leave type.' })
      .trim()
      .min(1, 'Choose the leave type.'),
    ...requestFields,
  })
  .refine((value) => value.portion !== 'part', {
    message: 'Only offset time off can cover part of a day.',
    path: ['portion'],
  });

/** Offset time off from the sheet ("Offset"): whole days, or a part of one day. */
export const offsetTimeOffInputSchema = z
  .object({
    kind: z.literal('offset'),
    ...requestFields,
    fromTime: optionalTime,
    toTime: optionalTime,
  })
  .superRefine((value, ctx) => {
    if (value.portion === 'firstHalf' || value.portion === 'secondHalf') {
      ctx.addIssue({
        code: 'custom',
        path: ['portion'],
        message: 'Offset time off covers whole days or part of a day.',
      });
    }
    if (value.portion === 'part') {
      if (!value.fromTime) {
        ctx.addIssue({ code: 'custom', path: ['fromTime'], message: 'Enter the start time.' });
      }
      if (!value.toTime) {
        ctx.addIssue({ code: 'custom', path: ['toTime'], message: 'Enter the end time.' });
      }
    }
  })
  .transform((value) =>
    value.portion === 'part' ? value : { ...value, fromTime: null, toTime: null },
  );

/** Either kind, as the sheet sends it (the segmented control "Leave | Offset" sets `kind`). */
// Picked by `kind` (a plain union would report both schemas' errors).
export const timeOffRequestInputSchema = z.unknown().transform((value, ctx) => {
  const kind = (value as { kind?: unknown } | null)?.kind;
  if (kind !== 'leave' && kind !== 'offset') {
    ctx.addIssue({ code: 'custom', path: ['kind'], message: 'Choose leave or offset.' });
    return z.NEVER;
  }
  const parsed = (kind === 'offset' ? offsetTimeOffInputSchema : leaveRequestInputSchema).safeParse(
    value,
  );
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path });
    }
    return z.NEVER;
  }
  return parsed.data as LeaveRequestInput | OffsetTimeOffInput;
});
export type LeaveRequestInput = z.output<typeof leaveRequestInputSchema>;
export type OffsetTimeOffInput = z.output<typeof offsetTimeOffInputSchema>;
export type TimeOffRequestInput = LeaveRequestInput | OffsetTimeOffInput;

/** Cancelling a returned or approved request. */
export const cancelTimeOffInputSchema = z.object({
  requestId: z.string({ error: 'Choose a request.' }).regex(OBJECT_ID_PATTERN, 'Choose a request.'),
  reason: optionalText(TIME_OFF_CANCEL_REASON_MAX_LENGTH),
});
export type CancelTimeOffInput = z.output<typeof cancelTimeOffInputSchema>;

// ---------------------------------------------------------------------------------------------
// HR's opening entries and corrections

const employeeIdField = z
  .string({ error: 'Choose an employee.' })
  .regex(OBJECT_ID_PATTERN, 'Choose an employee.');

/** Days typed as text or a number, as whole half days. */
const halfDaysField = (what: string, { signed }: { signed: boolean }) =>
  z
    .preprocess(
      (value) => (typeof value === 'number' ? String(value) : trimmed(value)),
      z.string({ error: `Enter the ${what} in days.` }).min(1, `Enter the ${what} in days.`),
    )
    .transform((value, ctx) => {
      const negative = signed && value.startsWith('-');
      const halfDays = parseDaysText(negative ? value.slice(1) : value);
      if (halfDays === null) {
        ctx.addIssue({ code: 'custom', message: `Enter the ${what} in whole or half days.` });
        return z.NEVER;
      }
      return negative ? -halfDays : halfDays;
    });

/** Hours typed with up to two decimals, as whole minutes (rounded half up). */
const minutesField = (what: string, { signed }: { signed: boolean }) =>
  z
    .preprocess(
      (value) => (typeof value === 'number' ? String(value) : trimmed(value)),
      z.string({ error: `Enter the ${what} in hours.` }).min(1, `Enter the ${what} in hours.`),
    )
    .transform((value, ctx) => {
      const minutes = minutesOfHoursText(value);
      if (minutes === null || (!signed && value.startsWith('-'))) {
        ctx.addIssue({
          code: 'custom',
          message: `Enter the ${what} in hours, with up to two decimals.`,
        });
        return z.NEVER;
      }
      return minutes;
    });

/** One opening leave balance (VL or SL), 0 to 365 days in half days, dated the go-live date. */
export const leaveOpeningInputSchema = z.object({
  employeeId: employeeIdField,
  typeKey: z.string({ error: 'Choose the leave type.' }).trim().min(1, 'Choose the leave type.'),
  halfDays: halfDaysField('opening balance', { signed: false }).refine(
    (halfDays) => halfDays <= LEAVE_OPENING_DAYS_MAX * 2,
    { message: `The opening balance runs from 0 to ${LEAVE_OPENING_DAYS_MAX} days.` },
  ),
});
export type LeaveOpeningInput = z.input<typeof leaveOpeningInputSchema>;

/** The opening offset balance, typed in hours, stored in whole minutes, 0 or more. */
export const offsetOpeningInputSchema = z.object({
  employeeId: employeeIdField,
  minutes: minutesField('opening offset balance', { signed: false }),
});
export type OffsetOpeningInput = z.input<typeof offsetOpeningInputSchema>;

const adjustmentReason = requiredText(
  'Enter the reason for the correction.',
  LEAVE_ENTRY_REASON_MAX_LENGTH,
);

/** HR's leave correction: signed half days, not 0, with a reason. */
export const leaveAdjustmentInputSchema = z.object({
  employeeId: employeeIdField,
  typeKey: z.string({ error: 'Choose the leave type.' }).trim().min(1, 'Choose the leave type.'),
  halfDays: halfDaysField('correction', { signed: true }).refine((halfDays) => halfDays !== 0, {
    message: 'A correction can’t be 0 days.',
  }),
  reason: adjustmentReason,
});
export type LeaveAdjustmentInput = z.input<typeof leaveAdjustmentInputSchema>;

/** HR's offset correction: signed hours as whole minutes, not 0, with a reason. */
export const offsetAdjustmentInputSchema = z.object({
  employeeId: employeeIdField,
  minutes: minutesField('correction', { signed: true }).refine((minutes) => minutes !== 0, {
    message: 'A correction can’t be 0 hours.',
  }),
  reason: adjustmentReason,
});
export type OffsetAdjustmentInput = z.input<typeof offsetAdjustmentInputSchema>;
