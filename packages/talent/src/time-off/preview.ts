import { type LeaveSplit, splitLeaveDays } from './balance';
import {
  chargeableMinutesOf,
  type TimeOffDayContext,
  type TimeOffRequestDay,
  type TimeOffSpan,
  timeOffRequestDays,
} from './days';
import type { LeaveType } from './settings';

// Spec: docs/modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28 ("Units
// and counting", "Insufficient balance", "Filing offset time off") — a request's days with their
// charge, as the sheet previews it, the service stores it, approval fixes it and the DTR reads it.

/** A leave request's days, each marked paid or unpaid, and its split. */
export function previewLeaveRequest(input: {
  type: Pick<LeaveType, 'balance' | 'paid' | 'countDays'>;
  span: TimeOffSpan;
  context: TimeOffDayContext;
  /** `credited` types: the available balance (`availableLeaveHalfDays`); ignored otherwise. */
  availableHalfDays: number;
}): { days: TimeOffRequestDay[]; split: LeaveSplit } {
  const days = timeOffRequestDays(input.span, input.type.countDays, input.context);
  return splitLeaveDays(days, input.type, input.availableHalfDays);
}

/** Offset time off's days and the scheduled minutes they cover (work days only). */
export function previewOffsetTimeOff(input: { span: TimeOffSpan; context: TimeOffDayContext }): {
  days: TimeOffRequestDay[];
  minutes: number;
} {
  const days = timeOffRequestDays(input.span, 'workDays', input.context);
  return { days, minutes: chargeableMinutesOf(days) };
}
