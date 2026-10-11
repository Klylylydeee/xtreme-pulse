import { describe, expect, it } from 'vitest';
import {
  declareHolidaySchema,
  easterSunday,
  expandHolidayRules,
  holidayAuditLabel,
  holidayInputSchema,
  holidayRulesSchema,
  holidayUpdateSchema,
  lastWeekdayOfMonth,
} from './holidays';
import { SEED_HOLIDAY_RULES } from './server/holidays/rules';

// The holiday date rules and form schemas (docs/TESTING.md#holiday-calendar-tests,
// docs/modules/core.md#holiday-calendar). Pure code; no database.

describe('easterSunday (anonymous Gregorian algorithm)', () => {
  it.each([
    [2026, '2026-04-05'],
    [2027, '2027-03-28'],
    [2028, '2028-04-16'],
    // Known dates around them, including the earliest and latest possible (March 22, April 25).
    [2000, '2000-04-23'],
    [2019, '2019-04-21'],
    [2024, '2024-03-31'],
    [2025, '2025-04-20'],
    [2029, '2029-04-01'],
    [2030, '2030-04-21'],
    [2038, '2038-04-25'],
    [2285, '2285-03-22'],
  ])('gives Easter %i as %s', (year, expected) => {
    expect(easterSunday(year)).toBe(expected);
  });

  it('refuses a year that isn’t four digits', () => {
    expect(() => easterSunday(999)).toThrow(RangeError);
    expect(() => easterSunday(2026.5)).toThrow(RangeError);
  });
});

describe('lastWeekdayOfMonth', () => {
  it.each([
    [2026, '2026-08-31'],
    [2027, '2027-08-30'],
    [2028, '2028-08-28'],
  ])('puts National Heroes Day (last Monday of August) %i on %s', (year, expected) => {
    expect(lastWeekdayOfMonth(year, 8, 1)).toBe(expected);
  });

  it('handles a month ending on the weekday asked for, and February in a leap year', () => {
    // 2026-01-31 is a Saturday.
    expect(lastWeekdayOfMonth(2026, 1, 6)).toBe('2026-01-31');
    // 2028-02-29 is a Tuesday.
    expect(lastWeekdayOfMonth(2028, 2, 2)).toBe('2028-02-29');
    expect(lastWeekdayOfMonth(2027, 2, 0)).toBe('2027-02-28');
  });

  it('refuses an impossible month or weekday', () => {
    expect(() => lastWeekdayOfMonth(2026, 13, 1)).toThrow(RangeError);
    expect(() => lastWeekdayOfMonth(2026, 8, 7)).toThrow(RangeError);
  });
});

describe('expandHolidayRules with the seeded rules', () => {
  const byKey = (year: number) =>
    new Map(expandHolidayRules(SEED_HOLIDAY_RULES, year).map((d) => [d.key, d]));

  it('gives the Holy Week dates from Easter for 2026, 2027 and 2028', () => {
    const cases: [number, string, string, string][] = [
      [2026, '2026-04-02', '2026-04-03', '2026-04-04'],
      [2027, '2027-03-25', '2027-03-26', '2027-03-27'],
      [2028, '2028-04-13', '2028-04-14', '2028-04-15'],
    ];
    for (const [year, thursday, friday, saturday] of cases) {
      const drafts = byKey(year);
      expect(drafts.get('maundyThursday')?.date, `${year}`).toBe(thursday);
      expect(drafts.get('goodFriday')?.date, `${year}`).toBe(friday);
      expect(drafts.get('blackSaturday')?.date, `${year}`).toBe(saturday);
    }
  });

  it('gives each fixed rule its month and day, and National Heroes Day its Monday', () => {
    const drafts = byKey(2027);
    expect(drafts.size).toBe(18);
    expect(drafts.get('newYearsDay')).toEqual({
      key: 'newYearsDay',
      sourceKey: 'rule:newYearsDay',
      name: "New Year's Day",
      type: 'regular',
      date: '2027-01-01',
    });
    expect(drafts.get('edsaRevolutionAnniversary')).toMatchObject({
      date: '2027-02-25',
      type: 'specialWorking',
    });
    expect(drafts.get('arawNgKagitingan')?.date).toBe('2027-04-09');
    expect(drafts.get('laborDay')?.date).toBe('2027-05-01');
    expect(drafts.get('independenceDay')?.date).toBe('2027-06-12');
    expect(drafts.get('ninoyAquinoDay')?.date).toBe('2027-08-21');
    expect(drafts.get('nationalHeroesDay')).toMatchObject({ date: '2027-08-30', type: 'regular' });
    expect(drafts.get('allSaintsDay')?.date).toBe('2027-11-01');
    expect(drafts.get('allSoulsDay')?.date).toBe('2027-11-02');
    expect(drafts.get('bonifacioDay')?.date).toBe('2027-11-30');
    expect(drafts.get('immaculateConception')?.date).toBe('2027-12-08');
    expect(drafts.get('christmasEve')?.date).toBe('2027-12-24');
    expect(drafts.get('christmasDay')).toMatchObject({ date: '2027-12-25', type: 'regular' });
    expect(drafts.get('rizalDay')?.date).toBe('2027-12-30');
    expect(drafts.get('lastDayOfTheYear')).toMatchObject({
      date: '2027-12-31',
      type: 'specialNonWorking',
    });
  });

  it('follows RA 9492 for the regular holidays and lists them by date', () => {
    const drafts = expandHolidayRules(SEED_HOLIDAY_RULES, 2026);
    const regular = drafts.filter((d) => d.type === 'regular').map((d) => d.key);
    expect(regular.sort()).toEqual(
      [
        'arawNgKagitingan',
        'bonifacioDay',
        'christmasDay',
        'goodFriday',
        'independenceDay',
        'laborDay',
        'maundyThursday',
        'nationalHeroesDay',
        'newYearsDay',
        'rizalDay',
      ].sort(),
    );
    const dates = drafts.map((d) => d.date);
    expect(dates).toEqual([...dates].sort());
  });
});

describe('the core.holidayRules schema', () => {
  it('accepts the three kinds, and the seeded rules', () => {
    expect(holidayRulesSchema.safeParse(SEED_HOLIDAY_RULES).success).toBe(true);
    const rules = [
      { key: 'a', name: 'A', type: 'regular', kind: 'fixed', month: 3, day: 31 },
      { key: 'b', name: 'B', type: 'specialWorking', kind: 'lastWeekday', month: 5, weekday: 0 },
      { key: 'c', name: 'C', type: 'specialNonWorking', kind: 'easterOffset', offsetDays: 1 },
    ];
    expect(holidayRulesSchema.safeParse(rules).success).toBe(true);
  });

  it('refuses an unknown kind, an impossible date and a repeated key', () => {
    const base = { key: 'x', name: 'X', type: 'regular' };
    expect(
      holidayRulesSchema.safeParse([{ ...base, kind: 'nthWeekday', month: 1, weekday: 1 }]).success,
    ).toBe(false);
    for (const [month, day] of [
      [2, 30],
      [4, 31],
      [13, 1],
      [2, 29],
      [1, 0],
    ]) {
      expect(
        holidayRulesSchema.safeParse([{ ...base, kind: 'fixed', month, day }]).success,
        `${month}/${day}`,
      ).toBe(false);
    }
    expect(
      holidayRulesSchema.safeParse([
        { ...base, kind: 'fixed', month: 1, day: 1 },
        { ...base, kind: 'fixed', month: 1, day: 2 },
      ]).success,
    ).toBe(false);
    expect(holidayRulesSchema.safeParse([]).success).toBe(false);
  });
});

describe('the holiday form schemas', () => {
  const draft = {
    name: '  Araw ng Maynila ',
    date: '2027-06-24',
    type: 'specialNonWorking',
    scope: 'local',
    location: 'Manila',
    legalBasis: '',
  };

  it('trims, reads an empty legal basis as none, and requires a location for a local holiday', () => {
    expect(holidayInputSchema.parse(draft)).toEqual({
      ...draft,
      name: 'Araw ng Maynila',
      legalBasis: null,
    });
    const noLocation = holidayInputSchema.safeParse({ ...draft, location: ' ' });
    expect(noLocation.success).toBe(false);
    expect(noLocation.error?.issues[0]?.path).toEqual(['location']);
  });

  it('stores no location for a nationwide holiday', () => {
    expect(holidayInputSchema.parse({ ...draft, scope: 'nationwide' }).location).toBeNull();
  });

  it('refuses an impossible date, a long name and an unknown type', () => {
    expect(holidayInputSchema.safeParse({ ...draft, date: '2027-02-30' }).success).toBe(false);
    expect(holidayInputSchema.safeParse({ ...draft, name: 'x'.repeat(101) }).success).toBe(false);
    expect(holidayInputSchema.safeParse({ ...draft, type: 'nationalDay' }).success).toBe(false);
  });

  it('requires a legal basis to declare', () => {
    expect(declareHolidaySchema.safeParse(draft).success).toBe(false);
    expect(
      declareHolidaySchema.safeParse({ ...draft, legalBasis: 'Proclamation No. 1' }).success,
    ).toBe(true);
  });

  it('drops source and sourceKey from an edit, which needs the loaded updatedAt', () => {
    const edit = {
      ...draft,
      id: '0123456789abcdef01234567',
      expectedUpdatedAt: '2026-10-11T01:02:03.456Z',
      source: 'rule',
      sourceKey: 'rule:hacked',
    };
    const parsed = holidayUpdateSchema.parse(edit);
    expect(parsed).not.toHaveProperty('source');
    expect(parsed).not.toHaveProperty('sourceKey');
    expect(holidayUpdateSchema.safeParse({ ...edit, expectedUpdatedAt: '' }).success).toBe(false);
  });

  it('labels audit entries <name> · <YYYY-MM-DD>', () => {
    expect(holidayAuditLabel({ name: 'Christmas Day', date: '2027-12-25' })).toBe(
      'Christmas Day · 2027-12-25',
    );
  });
});
