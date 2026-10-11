import type { ClientSession } from 'mongoose';
import { z } from 'zod';
import { withTransaction } from '@pulse/db';
import { ActionError } from '../../actions';
import { type BusinessDate, businessYear, now, startOfBusinessDate } from '../../dates';
import { type ExpandedHolidayRule, expandHolidayRules, holidayYearSchema } from '../../holidays';
import { snapshotForAudit } from '../audit/snapshot';
import { findConfigVersion } from '../config';
import { defineJob, defineSchedule } from '../jobs/define';
import { toObjectId } from '../paging';
import { isDuplicateKeyError } from '../seed/duplicate-key';
import { HolidayModel } from './model';
import {
  type HolidayFetch,
  type OnlineSourceResult,
  runOnlineHolidaySource,
} from './online-source';
import { HOLIDAY_RULES_SETTING } from './rules';
import {
  assertCanManageHolidays,
  type HolidayActor,
  holidayLabelOf,
  recordHolidayAudit,
} from './service';

// Spec: docs/modules/core.md#holiday-calendar and docs/ARCHITECTURE.md#background-jobs
// (decisions 112, 118, 119, 126 and 129 in docs/BUILD_PLAN.md) — the yearly auto-draft.
//
// The job `core.holidayAutoDraft` drafts next year every October 1 at 08:00 Asia/Manila, with no
// actor. HR or a System Administrator can also run it from `/holidays` for the current or the
// next year, which calls `runHolidayAutoDraft` directly (not through the worker), with them as the
// actor.
//
// - It uses the `core.holidayRules` version in effect on the Manila day it runs.
// - Each rule's draft has source `rule`, source key `rule:<key>`, the rule's default type,
//   nationwide scope and no legal basis.
// - A draft is added only when no holiday of that year, deleted ones included, has that source
//   key, so it can run any number of times and a deleted or moved auto-draft is never drafted
//   again. The partial unique index on `{ year, sourceKey }` holds when two runs overlap.
// - A rule's date that already has a live holiday added by hand or from the online source (one HR
//   added before the run, say) is skipped too, so the run never adds a second holiday on a day HR
//   already covered. Another rule's draft on that date doesn't block it: two rules can fall on one
//   day (Black Saturday and Araw ng Kagitingan on April 9, 2039), and both apply.
// - Each draft is added in its own transaction with its `create` audit entry: a scheduled run
//   audits with no actor, a run by hand with that person.
// - Then the optional online source runs (./online-source.ts); its failure doesn't undo the rule
//   drafts. Nothing is confirmed and nobody is notified.

/** The job: no data; the year is worked out when it runs (next year, in Manila). */
export const HOLIDAY_AUTO_DRAFT_JOB = defineJob('core.holidayAutoDraft', {
  schema: z.object({}),
});

/** Every October 1 at 8:00 AM Manila. */
export const HOLIDAY_AUTO_DRAFT_SCHEDULE = defineSchedule({
  id: 'core.holidayAutoDraft',
  job: HOLIDAY_AUTO_DRAFT_JOB,
  data: {},
  pattern: '0 8 1 10 *',
});

export interface HolidayAutoDraftResult {
  year: number;
  /** The Manila day the rules version used took effect. */
  rulesEffectiveFrom: BusinessDate;
  /** Rule drafts added in this run. */
  added: number;
  /** Rules skipped: already drafted (deleted or moved ones included), or the date was taken. */
  skipped: number;
  /** The online source's part: `off`, `ok` or `failed` (the rule drafts stand either way). */
  online: OnlineSourceResult;
}

const NO_RULES =
  'No holiday rules are in effect today, so nothing was drafted. Run pnpm seed:admin, or add a version of core.holidayRules.';

/** Adds one rule draft unless its source key was used in the year or its date has a holiday. */
async function addRuleDraft(
  draft: ExpandedHolidayRule,
  year: number,
  actor: HolidayActor | null,
  session: ClientSession,
): Promise<boolean> {
  const keyUsed = await HolidayModel.exists({ year, sourceKey: draft.sourceKey })
    .setOptions({ withDeleted: true })
    .session(session);
  if (keyUsed) return false;
  const date = startOfBusinessDate(draft.date);
  // A date HR already covered (by hand, or from the online source) is skipped. Another rule's
  // draft doesn't count: two rules can fall on one day (Black Saturday and Araw ng Kagitingan on
  // April 9, 2039), and both holidays apply.
  const dateTaken = await HolidayModel.exists({ date, source: { $ne: 'rule' } }).session(session);
  if (dateTaken) return false;

  const [created] = await HolidayModel.create(
    [
      {
        name: draft.name,
        date,
        year,
        type: draft.type,
        scope: 'nationwide',
        location: null,
        legalBasis: null,
        status: 'draft',
        source: 'rule',
        sourceKey: draft.sourceKey,
        declared: false,
        createdBy: actor ? toObjectId(actor.id) : null,
      },
    ],
    { session },
  );
  if (!created) throw new Error('The holiday wasn’t created.');
  await recordHolidayAudit(
    actor,
    'create',
    created._id,
    holidayLabelOf(created),
    { before: null, after: snapshotForAudit(HolidayModel, created) },
    session,
  );
  return true;
}

export interface RunHolidayAutoDraftOptions {
  year: number;
  /** HR or a System Administrator running it by hand, or null for the scheduled run. */
  actor: HolidayActor | null;
  /** "Now", for the rules version and the allowed years (tests pass a fixed time). */
  at?: Date;
  /** The online source's `fetch` (tests pass a stub). */
  fetchImpl?: HolidayFetch;
}

/**
 * Drafts `year`'s holidays from the rules in effect today (Manila), then from the online source
 * when it is on. Idempotent. With an actor, only HR or a System Administrator, and only for the
 * current or next year; the scheduled run passes no actor.
 */
export async function runHolidayAutoDraft({
  year,
  actor,
  at = now(),
  fetchImpl,
}: RunHolidayAutoDraftOptions): Promise<HolidayAutoDraftResult> {
  if (actor) assertCanManageHolidays(actor);
  const parsedYear = holidayYearSchema.safeParse(year);
  if (!parsedYear.success) throw new ActionError('Choose a year.', { field: 'year' });
  const target = parsedYear.data;
  if (actor) {
    const current = businessYear(at);
    if (target !== current && target !== current + 1) {
      throw new ActionError(`Run the auto-draft for ${current} or ${current + 1} only.`, {
        field: 'year',
      });
    }
  }

  const version = await findConfigVersion(HOLIDAY_RULES_SETTING, at);
  if (!version) throw new ActionError(NO_RULES);

  let added = 0;
  const drafts = expandHolidayRules(version.value, target);
  for (const draft of drafts) {
    try {
      if (await withTransaction((session) => addRuleDraft(draft, target, actor, session))) {
        added += 1;
      }
    } catch (error) {
      // An overlapping run added it first: the partial unique index refused this one.
      if (!isDuplicateKeyError(error, 'sourceKey')) throw error;
    }
  }

  const online = await runOnlineHolidaySource({ year: target, actor, fetchImpl });
  return {
    year: target,
    rulesEffectiveFrom: version.effectiveFrom,
    added,
    skipped: drafts.length - added,
    online,
  };
}

/** The scheduled run (October 1): next year in Manila, with no actor. */
export function runScheduledHolidayAutoDraft(at: Date = now()): Promise<HolidayAutoDraftResult> {
  return runHolidayAutoDraft({ year: businessYear(at) + 1, actor: null, at });
}
