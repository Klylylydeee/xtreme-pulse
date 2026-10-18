import { type HolidaysChangedEvent, registerHolidaysChangedListener } from '@pulse/core/server';
import { type OffsetReconcileResult, reconcileOffsetCredits } from '../offset/service';
import { reconcileTimeOffRequests, type TimeOffReconcileResult } from '../time-off/reconcile';

// Spec: docs/modules/core.md#holiday-calendar, docs/ARCHITECTURE.md#cross-module-integration and
// docs/modules/talent.md#timesheet-approval-the-dtr-and-the-offset-balance-build-step-27 ("The
// holidays-changed listener"; decision 292 in docs/BUILD_PLAN.md) — `talent.recomputeDtr`.
//
// The DTR is derived when read, so no stored DTR needs recomputing: every period not yet finalized
// is always current. What the listener recomputes is the stored values derived from the calendar:
// the offset credits of approved timesheets whose period holds a changed date, and from step 2.8
// (decision 316) the charge of every approved leave and offset time off request covering one
// (server/time-off/reconcile.ts: `talent.leaveAdjusted`, `talent.offsetAdjusted`). The worker
// registers it at start-up (`registerTalentHolidaysChangedListener()`), and Core's
// `core.holidaysChanged` handler runs it outside any transaction, possibly more than once: it is
// idempotent. Step 2.9 extends it to draft payroll runs.

/** The listener's name. */
export const RECOMPUTE_DTR_LISTENER = 'talent.recomputeDtr';

/** What one run of the listener changed. */
export interface RecomputeDtrResult extends OffsetReconcileResult {
  /** Step 2.8: the approved time off requests covering a changed date. */
  timeOff: TimeOffReconcileResult;
}

/**
 * The listener: reconciles the offset credits of approved timesheets, then the approved time off
 * requests, for the changed dates.
 */
export async function recomputeDtrOnHolidaysChanged(
  event: HolidaysChangedEvent,
): Promise<RecomputeDtrResult> {
  const offset = await reconcileOffsetCredits(event.dates);
  const timeOff = await reconcileTimeOffRequests(event.dates);
  return { ...offset, timeOff };
}

let registered = false;

/** Registers `talent.recomputeDtr` with Core. Safe to call more than once: it registers once. */
export function registerTalentHolidaysChangedListener(): void {
  if (registered) return;
  registerHolidaysChangedListener(RECOMPUTE_DTR_LISTENER, async (event) => {
    await recomputeDtrOnHolidaysChanged(event);
  });
  registered = true;
}
