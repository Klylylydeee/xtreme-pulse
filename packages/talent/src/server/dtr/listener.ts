import { type HolidaysChangedEvent, registerHolidaysChangedListener } from '@pulse/core/server';
import { type OffsetReconcileResult, reconcileOffsetCredits } from '../offset/service';

// Spec: docs/modules/core.md#holiday-calendar, docs/ARCHITECTURE.md#cross-module-integration and
// docs/modules/talent.md#timesheet-approval-the-dtr-and-the-offset-balance-build-step-27 ("The
// holidays-changed listener"; decision 292 in docs/BUILD_PLAN.md) — `talent.recomputeDtr`.
//
// The DTR is derived when read, so no stored DTR needs recomputing: every period not yet finalized
// is always current. What the listener recomputes is the one stored value derived from the DTR,
// the offset credits of approved timesheets whose period holds a changed date. The worker registers
// it at start-up (`registerTalentHolidaysChangedListener()`), and Core's `core.holidaysChanged`
// handler runs it outside any transaction, possibly more than once: it is idempotent. Step 2.9
// extends it to draft payroll runs.

/** The listener's name. */
export const RECOMPUTE_DTR_LISTENER = 'talent.recomputeDtr';

/** The listener: reconciles the offset credits of approved timesheets for the changed dates. */
export function recomputeDtrOnHolidaysChanged(
  event: HolidaysChangedEvent,
): Promise<OffsetReconcileResult> {
  return reconcileOffsetCredits(event.dates);
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
