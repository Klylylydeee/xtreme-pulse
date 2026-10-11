import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { AccessDeniedError, ActionError } from '../../actions';
import { toBusinessDate } from '../../dates';
import type { HolidayRules } from '../../holidays';
import { AuditLogModel } from '../audit/model';
import { addConfigVersion } from '../config';
import { NotificationModel } from '../notifications/model';
import { runHolidayAutoDraft, runScheduledHolidayAutoDraft } from './auto-draft';
import { setHolidaysChangedEnqueuer } from './events';
import { HolidayModel } from './model';
import { type HolidayFetch, HOLIDAY_SOURCE_URL_ENV } from './online-source';
import { HOLIDAY_RULES_SETTING, SEED_HOLIDAY_RULES } from './rules';
import {
  confirmHoliday,
  createHoliday,
  deleteHoliday,
  type HolidayActor,
  listHolidays,
  listHolidayYears,
  updateHoliday,
} from './service';

// The yearly auto-draft and the online source (docs/modules/core.md#holiday-calendar,
// docs/TESTING.md#holiday-calendar-tests). The feed is always a stub, never the real internet.
// Made-up people only.

function actor(roles: HolidayActor['roles'], admin = false): HolidayActor {
  return {
    id: new Types.ObjectId().toHexString(),
    email: `actor.${roles.join('') || (admin ? 'admin' : 'staff')}@xtreme-works.com`,
    isSystemAdministrator: admin,
    roles,
  };
}

const HR = actor(['hr']);
const ADMIN = actor([], true);
const STAFF = actor([]);

/** October 1, 2026 at 08:00 Manila: the scheduled run. */
const OCTOBER_1 = new Date('2026-10-01T00:00:00Z');

const enqueued: string[][] = [];

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Missing in the test data.');
  return value;
}

async function yearHolidays(year: number) {
  return HolidayModel.find({ year }, null, { withDeleted: true }).sort({ date: 1, name: 1 }).lean();
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeAll(async () => {
  await connectDb();
  await Promise.all([HolidayModel.init(), AuditLogModel.init(), NotificationModel.init()]);
  // The seeded rules, in effect from the start of 2026 (the seed loader's own date is tested in
  // holiday-rules.test.ts).
  await addConfigVersion(HOLIDAY_RULES_SETTING, {
    effectiveFrom: '2026-01-01',
    value: SEED_HOLIDAY_RULES,
    actorId: null,
  });
  setHolidaysChangedEnqueuer(async (dates) => {
    enqueued.push(dates);
  });
});

afterEach(() => {
  process.env[HOLIDAY_SOURCE_URL_ENV] = '';
  vi.restoreAllMocks();
});

describe('the scheduled auto-draft (Done when)', () => {
  it('drafts next year from the rules, with the right Holy Week dates', async () => {
    const result = await runScheduledHolidayAutoDraft(OCTOBER_1);
    expect(result).toEqual({
      year: 2027,
      rulesEffectiveFrom: '2026-01-01',
      added: 18,
      skipped: 0,
      online: { status: 'off', added: 0, skipped: 0 },
    });

    const drafts = await yearHolidays(2027);
    expect(drafts).toHaveLength(18);
    const byKey = new Map(drafts.map((d) => [d.sourceKey, d]));
    expect(toBusinessDate(must(byKey.get('rule:maundyThursday')).date)).toBe('2027-03-25');
    expect(toBusinessDate(must(byKey.get('rule:goodFriday')).date)).toBe('2027-03-26');
    expect(toBusinessDate(must(byKey.get('rule:blackSaturday')).date)).toBe('2027-03-27');
    expect(toBusinessDate(must(byKey.get('rule:nationalHeroesDay')).date)).toBe('2027-08-30');
    // Stored as 00:00 Manila in UTC.
    expect(must(byKey.get('rule:christmasDay')).date.toISOString()).toBe(
      '2027-12-24T16:00:00.000Z',
    );
    for (const draft of drafts) {
      expect(draft).toMatchObject({
        status: 'draft',
        source: 'rule',
        scope: 'nationwide',
        location: null,
        legalBasis: null,
        declared: false,
        createdBy: null,
      });
    }
    expect(must(byKey.get('rule:goodFriday')).type).toBe('regular');
    expect(must(byKey.get('rule:blackSaturday')).type).toBe('specialNonWorking');
    expect(must(byKey.get('rule:edsaRevolutionAnniversary')).type).toBe('specialWorking');

    // One create entry per draft, with no actor (a system action), labelled <name> · <date>.
    const entries = await AuditLogModel.find({
      'record.type': 'core.holiday',
      'record.id': { $in: drafts.map((d) => d._id) },
    }).lean();
    expect(entries).toHaveLength(18);
    expect(entries.every((e) => e.action === 'create' && e.actorId === null)).toBe(true);
    expect(entries.map((e) => e.record.label)).toContain('Christmas Day · 2027-12-25');
    // Nothing is confirmed, nobody is notified, holidays-changed isn't enqueued.
    expect(await NotificationModel.countDocuments({})).toBe(0);
    expect(enqueued).toEqual([]);
  });

  it('shows someone who isn’t HR or a System Administrator only the confirmed ones', async () => {
    // Every 2027 holiday is still a draft: the year doesn't reach them at all.
    expect(await listHolidays(STAFF, { year: 2027 })).toEqual([]);
    expect(await listHolidayYears(STAFF)).not.toContain(2027);
    expect(await listHolidays(HR, { year: 2027 })).toHaveLength(18);

    const christmas = must(
      (await yearHolidays(2027)).find((d) => d.sourceKey === 'rule:christmasDay'),
    );
    await updateHoliday(HR, {
      id: christmas._id.toHexString(),
      name: christmas.name,
      date: '2027-12-25',
      type: christmas.type,
      scope: 'nationwide',
      legalBasis: 'Proclamation No. 1',
      expectedUpdatedAt: christmas.updatedAt.toISOString(),
    });
    await confirmHoliday(HR, { id: christmas._id.toHexString() });

    const seen = await listHolidays(STAFF, { year: 2027 });
    expect(seen.map((h) => [h.name, h.date, h.status])).toEqual([
      ['Christmas Day', '2027-12-25', 'confirmed'],
    ]);
    expect(await listHolidayYears(STAFF)).toContain(2027);
    expect(await listHolidays(ADMIN, { year: 2027 })).toHaveLength(18);
    enqueued.length = 0;
  });

  it('adds nothing on a second run', async () => {
    const result = await runScheduledHolidayAutoDraft(OCTOBER_1);
    expect(result).toMatchObject({ added: 0, skipped: 18 });
    expect(await yearHolidays(2027)).toHaveLength(18);
  });

  it('never re-creates a deleted or moved auto-draft', async () => {
    const drafts = await yearHolidays(2027);
    const goodFriday = must(drafts.find((d) => d.sourceKey === 'rule:goodFriday'));
    const laborDay = must(drafts.find((d) => d.sourceKey === 'rule:laborDay'));
    await deleteHoliday(HR, { id: goodFriday._id.toHexString() });
    await updateHoliday(HR, {
      id: laborDay._id.toHexString(),
      name: laborDay.name,
      date: '2027-05-03',
      type: laborDay.type,
      scope: 'nationwide',
      location: null,
      legalBasis: null,
      expectedUpdatedAt: laborDay.updatedAt.toISOString(),
    });

    const result = await runHolidayAutoDraft({ year: 2027, actor: HR, at: OCTOBER_1 });
    expect(result).toMatchObject({ added: 0, skipped: 18 });
    expect(await HolidayModel.countDocuments({ year: 2027, sourceKey: 'rule:goodFriday' })).toBe(0);
    expect(
      await HolidayModel.countDocuments(
        { year: 2027, sourceKey: 'rule:laborDay' },
        { withDeleted: true },
      ),
    ).toBe(1);
  });

  it('never makes the same draft twice when two runs overlap', async () => {
    const results = await Promise.all([
      runHolidayAutoDraft({ year: 2028, actor: null, at: OCTOBER_1 }),
      runHolidayAutoDraft({ year: 2028, actor: null, at: OCTOBER_1 }),
    ]);
    expect(results.reduce((n, r) => n + r.added, 0)).toBe(18);
    expect(await yearHolidays(2028)).toHaveLength(18);
  });
});

describe('running the auto-draft by hand', () => {
  it('is for HR and System Administrators only', async () => {
    await expect(
      runHolidayAutoDraft({ year: 2026, actor: STAFF, at: OCTOBER_1 }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    expect(await HolidayModel.countDocuments({ year: 2026 }, { withDeleted: true })).toBe(0);
  });

  it('runs for the current or next year only', async () => {
    for (const year of [2025, 2029]) {
      await expect(runHolidayAutoDraft({ year, actor: HR, at: OCTOBER_1 })).rejects.toMatchObject({
        field: 'year',
      });
    }
    await expect(
      runHolidayAutoDraft({ year: 2026, actor: STAFF, at: OCTOBER_1 }),
    ).rejects.toThrow();
  });

  it('drafts the current year with the person as the actor of each entry', async () => {
    const result = await runHolidayAutoDraft({ year: 2026, actor: ADMIN, at: OCTOBER_1 });
    expect(result).toMatchObject({ year: 2026, added: 18, skipped: 0 });
    const drafts = await yearHolidays(2026);
    const entries = await AuditLogModel.find({
      'record.id': { $in: drafts.map((d) => d._id) },
    }).lean();
    expect(entries).toHaveLength(18);
    expect(entries.every((e) => e.actorId?.toString() === ADMIN.id)).toBe(true);
    expect(entries.every((e) => e.actorEmail === ADMIN.email)).toBe(true);
    expect(drafts.every((d) => d.createdBy?.toHexString() === ADMIN.id)).toBe(true);
  });

  it('skips a rule whose date already has a live holiday', async () => {
    // Jan 1 2029 is drafted by hand first; the run then skips New Year's Day.
    await createHoliday(HR, {
      name: 'New Year',
      date: '2029-01-01',
      type: 'regular',
      scope: 'nationwide',
      legalBasis: null,
    });
    const at = new Date('2028-10-01T00:00:00Z');
    const result = await runHolidayAutoDraft({ year: 2029, actor: HR, at });
    expect(result).toMatchObject({ added: 17, skipped: 1 });
    expect(await HolidayModel.countDocuments({ year: 2029, sourceKey: 'rule:newYearsDay' })).toBe(
      0,
    );
  });

  it('drafts two rules that fall on the same date', async () => {
    // Easter 2039 is April 10, so Black Saturday is April 9, Araw ng Kagitingan.
    const result = await runScheduledHolidayAutoDraft(new Date('2038-10-01T00:00:00Z'));
    expect(result).toMatchObject({ year: 2039, added: 18, skipped: 0 });
    const onApril9 = await HolidayModel.find({ date: new Date('2039-04-08T16:00:00Z') })
      .sort({ name: 1 })
      .lean();
    expect(onApril9.map((d) => d.sourceKey)).toEqual([
      'rule:arawNgKagitingan',
      'rule:blackSaturday',
    ]);
  });
});

describe('the online source', () => {
  const at2033 = new Date('2033-10-01T00:00:00Z');

  it('is off while HOLIDAY_SOURCE_URL is empty, and never fetches', async () => {
    const fetchImpl = vi.fn<HolidayFetch>();
    process.env[HOLIDAY_SOURCE_URL_ENV] = '   ';
    const result = await runHolidayAutoDraft({ year: 2034, actor: null, at: at2033, fetchImpl });
    expect(result.online).toEqual({ status: 'off', added: 0, skipped: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('adds each date with no holiday (deleted ones included) as a draft, and confirms nothing', async () => {
    const year = 2035;
    const at = new Date('2034-10-01T00:00:00Z');
    // A deleted holiday on Feb 8 blocks that date; a live one on Feb 9 (any name) does too.
    const deleted = await createHoliday(HR, {
      name: 'Deleted day',
      date: '2035-02-08',
      type: 'regular',
      scope: 'nationwide',
    });
    await deleteHoliday(HR, { id: deleted.id });
    await createHoliday(HR, {
      name: 'Something else',
      date: '2035-02-09',
      type: 'regular',
      scope: 'nationwide',
    });

    process.env[HOLIDAY_SOURCE_URL_ENV] = 'https://holidays.example.test/api/{year}/PH';
    const fetchImpl = vi.fn<HolidayFetch>(async () =>
      jsonResponse([
        { date: '2035-01-01', localName: 'Bagong Taon', name: "New Year's Day", countryCode: 'PH' },
        { date: '2035-02-08', name: 'Chinese New Year' },
        { date: '2035-02-09', name: 'Lantern Festival' },
        { date: '2035-02-10', name: 'Sample Feed Day' },
        { date: '2035-02-10', name: 'Duplicate date' },
        { date: '2036-01-01', name: 'Next year' },
      ]),
    );

    const result = await runHolidayAutoDraft({ year, actor: HR, at, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://holidays.example.test/api/2035/PH');
    expect(result.added).toBe(18);
    // Jan 1 has the rule draft, Feb 8 a deleted holiday, Feb 9 a live one: only Feb 10 is new.
    expect(result.online).toEqual({ status: 'ok', added: 1, skipped: 3 });

    const online = await HolidayModel.find({ year, source: 'online' }).lean();
    expect(online).toHaveLength(1);
    expect(online[0]).toMatchObject({
      name: 'Sample Feed Day',
      sourceKey: 'online:2035-02-10',
      type: 'specialNonWorking',
      scope: 'nationwide',
      legalBasis: null,
      status: 'draft',
    });
    expect(await HolidayModel.countDocuments({ year, status: 'confirmed' })).toBe(0);

    // Running again adds nothing.
    const again = await runHolidayAutoDraft({ year, actor: HR, at, fetchImpl });
    expect(again).toMatchObject({ added: 0, online: { status: 'ok', added: 0 } });
  });

  it('logs a failing or malformed feed, and the rule drafts are still made', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env[HOLIDAY_SOURCE_URL_ENV] = 'https://holidays.example.test/{year}';
    const failures: [number, HolidayFetch][] = [
      [2036, async () => jsonResponse({ message: 'nope' }, 503)],
      [2037, async () => jsonResponse({ not: 'a list' })],
      [
        2038,
        async () => {
          throw new TypeError('fetch failed');
        },
      ],
    ];
    for (const [year, fetchImpl] of failures) {
      const at = new Date(`${year - 1}-10-01T00:00:00Z`);
      const result = await runHolidayAutoDraft({ year, actor: null, at, fetchImpl });
      expect(result.added, `${year}`).toBe(18);
      expect(result.online.status, `${year}`).toBe('failed');
      expect(await HolidayModel.countDocuments({ year, source: 'online' })).toBe(0);
    }
    expect(error).toHaveBeenCalledTimes(3);
    for (const [message] of error.mock.calls) {
      expect(String(message)).not.toContain('holidays.example.test');
    }
  });
});

describe('the rules version in effect', () => {
  it('uses the version in effect on the Manila day the run happens', async () => {
    const onlyChristmas: HolidayRules = [
      {
        key: 'christmasDay',
        name: 'Christmas Day',
        type: 'regular',
        kind: 'fixed',
        month: 12,
        day: 25,
      },
      {
        key: 'newRuleDay',
        name: 'New Rule Day',
        type: 'specialNonWorking',
        kind: 'fixed',
        month: 7,
        day: 1,
      },
    ];
    await addConfigVersion(HOLIDAY_RULES_SETTING, {
      effectiveFrom: '2030-06-01',
      value: onlyChristmas,
      actorId: null,
    });
    // May 31, 2030 in Manila still uses the seeded version (and 2031 gets every seeded rule).
    const before = await runHolidayAutoDraft({
      year: 2031,
      actor: null,
      at: new Date('2030-05-31T15:59:00Z'),
    });
    expect(before).toMatchObject({ rulesEffectiveFrom: '2026-01-01', added: 18 });
    // From June 1 in Manila (16:00 UTC the day before) the new version applies.
    const after = await runHolidayAutoDraft({
      year: 2032,
      actor: null,
      at: new Date('2030-05-31T16:00:00Z'),
    });
    expect(after).toMatchObject({ rulesEffectiveFrom: '2030-06-01', added: 2 });
    expect((await yearHolidays(2032)).map((d) => d.name)).toEqual([
      'New Rule Day',
      'Christmas Day',
    ]);
  });

  it('refuses when no version is in effect yet', async () => {
    await expect(
      runHolidayAutoDraft({ year: 2026, actor: null, at: new Date('2025-06-01T00:00:00Z') }),
    ).rejects.toBeInstanceOf(ActionError);
  });
});
