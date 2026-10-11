import type { ClientSession } from 'mongoose';
import { z } from 'zod';
import { withTransaction } from '@pulse/db';
import { type BusinessDate, isBusinessDate, startOfBusinessDate } from '../../dates';
import { HOLIDAY_NAME_MAX_LENGTH, holidayYearOf, onlineSourceKey } from '../../holidays';
import { snapshotForAudit } from '../audit/snapshot';
import { toObjectId } from '../paging';
import { isDuplicateKeyError } from '../seed/duplicate-key';
import { HolidayModel } from './model';
import { holidayLabelOf, recordHolidayAudit } from './service';

// Spec: docs/modules/core.md#holiday-calendar, docs/DEPLOYMENT.md#environment-variables and
// docs/RUNBOOK.md#online-holiday-source-unreachable (decision 120 in docs/BUILD_PLAN.md) — the
// optional online source. Off unless `HOLIDAY_SOURCE_URL` is set. Each auto-draft run then fetches
// the year's holidays (`{year}` in the URL is replaced by the year) as a Nager.Date-style JSON
// list, each entry with `date` (`YYYY-MM-DD`) and `name`. Every date that has no holiday yet,
// deleted ones included, becomes a draft: special non-working day, nationwide, no legal basis,
// source `online`, source key `online:<YYYY-MM-DD>`, for HR to check. It matches by date only and
// never confirms anything. A failure (unreachable, an error answer, a payload that doesn't parse)
// is logged without the URL and reported in the result; the rule-based drafts stand.

/** The environment variable that turns the source on. */
export const HOLIDAY_SOURCE_URL_ENV = 'HOLIDAY_SOURCE_URL';
/** How long the fetch may take before it counts as a failure. */
export const HOLIDAY_SOURCE_TIMEOUT_MS = 10_000;
/** The most entries read from one answer; a real year has a few dozen. */
const MAX_ENTRIES = 500;

/** The configured feed URL for `year`, or null when the source is off. */
export function holidaySourceUrl(year: number): string | null {
  const template = process.env[HOLIDAY_SOURCE_URL_ENV]?.trim();
  if (!template) return null;
  return template.replaceAll('{year}', String(year));
}

const feedSchema = z
  .array(
    z.looseObject({
      date: z.string().refine(isBusinessDate),
      name: z.string().trim().min(1),
    }),
  )
  .max(MAX_ENTRIES);

/** The `fetch` the source uses; tests pass a stub (never the real internet). */
export type HolidayFetch = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

export type OnlineSourceResult =
  | { status: 'off'; added: 0; skipped: 0 }
  | { status: 'ok'; added: number; skipped: number }
  | { status: 'failed'; added: number; skipped: number; reason: string };

/** Why a fetch failed, in words safe to log and show (never the URL or the answer's body). */
class SourceFailure extends Error {}

async function fetchFeed(
  url: string,
  fetchImpl: HolidayFetch,
): Promise<{ date: BusinessDate; name: string }[]> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new SourceFailure('HOLIDAY_SOURCE_URL isn’t a valid URL');
  }
  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    throw new SourceFailure('HOLIDAY_SOURCE_URL must be an http or https URL');
  }
  let response: Response;
  try {
    response = await fetchImpl(parsedUrl.toString(), {
      signal: AbortSignal.timeout(HOLIDAY_SOURCE_TIMEOUT_MS),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : 'Error';
    throw new SourceFailure(
      name === 'TimeoutError'
        ? 'the source didn’t answer in time'
        : `the source is unreachable (${name})`,
    );
  }
  if (!response.ok) throw new SourceFailure(`the source answered HTTP ${response.status}`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new SourceFailure('the source’s answer isn’t JSON');
  }
  const parsed = feedSchema.safeParse(body);
  if (!parsed.success) throw new SourceFailure('the source’s answer isn’t a list of holidays');
  return parsed.data.map((entry) => ({
    date: entry.date,
    name: entry.name.slice(0, HOLIDAY_NAME_MAX_LENGTH).trim(),
  }));
}

/** Adds one online draft unless the date already has a holiday (deleted ones included). */
async function addOnlineDraft(
  entry: { date: BusinessDate; name: string },
  year: number,
  actor: { id: string; email: string } | null,
  session: ClientSession,
): Promise<boolean> {
  const date = startOfBusinessDate(entry.date);
  const sourceKey = onlineSourceKey(entry.date);
  const taken = await HolidayModel.exists({ $or: [{ date }, { year, sourceKey }] })
    .setOptions({ withDeleted: true })
    .session(session);
  if (taken) return false;
  const [created] = await HolidayModel.create(
    [
      {
        name: entry.name,
        date,
        year,
        type: 'specialNonWorking',
        scope: 'nationwide',
        location: null,
        legalBasis: null,
        status: 'draft',
        source: 'online',
        sourceKey,
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

/**
 * Runs the online source for `year`, as part of an auto-draft run (./auto-draft.ts, which checks
 * the actor). Never throws for a source failure: it is logged and returned as `failed`.
 */
export async function runOnlineHolidaySource({
  year,
  actor,
  fetchImpl = fetch,
}: {
  year: number;
  actor: { id: string; email: string } | null;
  fetchImpl?: HolidayFetch;
}): Promise<OnlineSourceResult> {
  const url = holidaySourceUrl(year);
  if (!url) return { status: 'off', added: 0, skipped: 0 };

  let entries: { date: BusinessDate; name: string }[];
  try {
    entries = await fetchFeed(url, fetchImpl);
  } catch (error) {
    const reason = error instanceof SourceFailure ? error.message : 'the source couldn’t be read';
    // The URL is left out: it is configuration, and may carry a key.
    console.error(`Online holiday source for ${year} failed: ${reason}. Rule-based drafts stand.`);
    return { status: 'failed', added: 0, skipped: 0, reason };
  }

  // One draft per date (the first entry for a date wins); dates outside the year are ignored.
  const byDate = new Map<BusinessDate, { date: BusinessDate; name: string }>();
  for (const entry of entries) {
    if (entry.name && holidayYearOf(entry.date) === year && !byDate.has(entry.date)) {
      byDate.set(entry.date, entry);
    }
  }

  let added = 0;
  for (const entry of [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    try {
      const made = await withTransaction((session) => addOnlineDraft(entry, year, actor, session));
      if (made) added += 1;
    } catch (error) {
      // An overlapping run made it first.
      if (!isDuplicateKeyError(error, 'sourceKey')) throw error;
    }
  }
  return { status: 'ok', added, skipped: byDate.size - added };
}
