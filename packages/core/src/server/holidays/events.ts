import { z } from 'zod';
import { type BusinessDate, isBusinessDate } from '../../dates';
import { describeJobError } from '../jobs/connection';
import { defineJob } from '../jobs/define';
import { enqueueJob } from '../jobs/queue';

// Spec: docs/modules/core.md#holiday-calendar and docs/ARCHITECTURE.md#cross-module-integration
// (decisions 117 and 132 in docs/BUILD_PLAN.md) — holidays changed.
//
// After a change that touches confirmed holidays commits (confirm, Confirm all, declare, or
// editing or deleting a confirmed holiday), the holiday service enqueues the BullMQ job
// `core.holidaysChanged` with `{ dates }`, the affected Manila days. A move sends both the old
// and the new date; Confirm all sends one job with every date it confirmed. Changes to drafts
// don't enqueue it. The worker runs every listener registered with
// `registerHolidaysChangedListener`; there are none until Phase 2 (Pulse Talent recomputes the DTR
// for payroll periods not yet finalized), so in step 1.10 the job does nothing.
//
// The enqueue happens after the commit, so a crash in between loses it. This is accepted (Phase 2
// reconciles at payroll finalize), and for the same reason an enqueue that fails (Redis down or
// not configured) is logged and never fails the change that already committed.
//
// The enqueue goes through a replaceable enqueuer (`setHolidaysChangedEnqueuer`), so tests can
// capture it without Redis. In the app and the worker the default, `enqueueJob`, is used.

/** The most dates one job carries (a year's holidays fit many times over). */
const MAX_DATES = 1000;

const businessDate = z.string().refine(isBusinessDate, 'Expected a date as YYYY-MM-DD.');

/** The job: the affected dates, `YYYY-MM-DD`, each once. Not scheduled. */
export const HOLIDAYS_CHANGED_JOB = defineJob('core.holidaysChanged', {
  schema: z.object({ dates: z.array(businessDate).min(1).max(MAX_DATES) }),
});

/** What a listener is given. */
export interface HolidaysChangedEvent {
  /** The affected Manila days, sorted, each once. */
  dates: BusinessDate[];
}

/**
 * A listener. It runs in the worker, outside any transaction, and may run more than once for the
 * same dates (a retry, or two changes to the same day), so it must be idempotent. Throw to fail
 * the job, which is then retried with every listener run again.
 */
export type HolidaysChangedListener = (event: HolidaysChangedEvent) => Promise<void> | void;

const listeners = new Map<string, HolidaysChangedListener>();
const LISTENER_NAME = /^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*$/;

/**
 * Registers a listener under a name (`<module>.<name>`, for example `talent.recomputeDtr`), an
 * explicit call like the other registrations. Registering the same name again replaces it outside
 * production (a hot reload); in production it throws.
 */
export function registerHolidaysChangedListener(
  name: string,
  listener: HolidaysChangedListener,
): void {
  if (!LISTENER_NAME.test(name)) {
    throw new Error(`"${name}" is not a listener name. Use "<module>.<name>" in camelCase.`);
  }
  if (listeners.has(name) && process.env.NODE_ENV === 'production') {
    throw new Error(`The holidays-changed listener "${name}" is already registered.`);
  }
  listeners.set(name, listener);
}

/** Removes a listener. For tests only. */
export function unregisterHolidaysChangedListener(name: string): void {
  listeners.delete(name);
}

/** The registered listeners' names, in registration order. */
export function holidaysChangedListenerNames(): string[] {
  return [...listeners.keys()];
}

/** The dates sorted, each once. */
function normalizeDates(dates: Iterable<BusinessDate>): BusinessDate[] {
  return [...new Set(dates)].filter(isBusinessDate).sort();
}

export interface HolidaysChangedResult {
  /** How many listeners ran (0 in step 1.10). */
  listeners: number;
}

/**
 * The `core.holidaysChanged` job handler: runs every registered listener, one after another, with
 * the dates. With none registered it does nothing. A listener that throws fails the job.
 */
export async function runHolidaysChangedListeners({
  dates,
}: {
  dates: readonly BusinessDate[];
}): Promise<HolidaysChangedResult> {
  const event: HolidaysChangedEvent = { dates: normalizeDates(dates) };
  if (event.dates.length === 0) return { listeners: 0 };
  const registered = [...listeners.values()];
  for (const listener of registered) await listener({ dates: [...event.dates] });
  return { listeners: registered.length };
}

/** Adds the `core.holidaysChanged` job for `dates`. */
export type HolidaysChangedEnqueuer = (dates: BusinessDate[]) => Promise<void>;

const defaultEnqueuer: HolidaysChangedEnqueuer = async (dates) => {
  await enqueueJob(HOLIDAYS_CHANGED_JOB, { dates });
};

let enqueuer: HolidaysChangedEnqueuer = defaultEnqueuer;

/**
 * Replaces how the job is enqueued (tests capture the dates with it). Pass null to go back to the
 * default, `enqueueJob`.
 */
export function setHolidaysChangedEnqueuer(replacement: HolidaysChangedEnqueuer | null): void {
  enqueuer = replacement ?? defaultEnqueuer;
}

/**
 * Enqueues `core.holidaysChanged` for `dates`, once, after the change committed. Never throws: a
 * failure is logged (the job name and the error only, never record details) and the change stands.
 * Does nothing for no dates.
 */
export async function enqueueHolidaysChanged(dates: Iterable<BusinessDate>): Promise<void> {
  const normalized = normalizeDates(dates);
  if (normalized.length === 0) return;
  for (let start = 0; start < normalized.length; start += MAX_DATES) {
    try {
      await enqueuer(normalized.slice(start, start + MAX_DATES));
    } catch (error) {
      console.error(
        `${HOLIDAYS_CHANGED_JOB.name} wasn't enqueued (accepted; Phase 2 reconciles at payroll finalize): ${describeJobError(error)}`,
      );
    }
  }
}
