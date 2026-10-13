import { describe, expect, it } from 'vitest';
import { addDays, type TimesheetType } from '@pulse/core';
import {
  PAYROLL_SEED_VERSIONS,
  SEED_PAYROLL_SETTINGS,
  SEED_PREMIUM_RATES,
  SEED_TIMESHEET_SETTINGS,
  SEED_WORK_SCHEDULE,
} from '../server/payroll-settings/seed-data';
import {
  beyondHoursText,
  computeDay,
  computeTimesheet,
  type DayHours,
  dayKindLabel,
  type DaySettings,
  formatHours,
  isoWeekdayOf,
  manilaDateOf,
  type TimeEntryHoursInput,
  type TimesheetHoliday,
  type TimesheetHoursInput,
  tenthsOfHour,
} from './compute';
import { scheduleOn, timesheetPeriodFor, versionOn } from './schedule';
import {
  isOvernightSchedule,
  scheduledMinutes,
  timesheetSettingsSchema,
  type WorkSchedule,
  workScheduleSchema,
} from './schemas';

// The hours computation tests (docs/TESTING.md#timesheet-and-work-schedule-tests, build step 2.4,
// decisions 223–233 in docs/BUILD_PLAN.md): the 14 hand-checked cases of
// docs/modules/talent.md#work-schedules-and-daily-time-entries-build-step-24, each its own test,
// plus the edge cases. The seeded schedule (08:00–17:00, break 12:00–13:00), hoursPerDay 8, the
// night window 22:00–06:00 and offsetRatio 1 unless a test says otherwise.

const NIGHT = { nightStart: SEED_PREMIUM_RATES.nightStart, nightEnd: SEED_PREMIUM_RATES.nightEnd };

/** A Manila wall-clock time on a day. */
const at = (day: string, time: string) => new Date(`${day}T${time}:00+08:00`);

let ids = 0;
/** An entry from `from` to `to` (on the next day when `nextDay`), marked unless `marked` is false. */
function entry(
  day: string,
  from: string,
  to: string | null,
  { marked = true, nextDay = false }: { marked?: boolean; nextDay?: boolean } = {},
): TimeEntryHoursInput {
  ids += 1;
  return {
    id: `e${String(ids).padStart(3, '0')}`,
    timeIn: at(day, from),
    timeOut: to === null ? null : at(nextDay ? addDays(day, 1) : day, to),
    extraHours: marked ? { reason: 'Network cutover for a client' } : null,
  };
}

const SETTINGS: DaySettings = {
  schedule: SEED_WORK_SCHEDULE,
  nightWindow: NIGHT,
  timesheetSettings: SEED_TIMESHEET_SETTINGS,
  hoursPerDay: SEED_PAYROLL_SETTINGS.hoursPerDay,
};

function day(
  date: string,
  entries: TimeEntryHoursInput[],
  {
    type = 'overtime',
    holidays = [],
    settings = {},
  }: {
    type?: TimesheetType;
    holidays?: TimesheetHoliday[];
    settings?: Partial<DaySettings>;
  } = {},
): DayHours {
  return computeDay({
    date,
    timesheetType: type,
    entries,
    holidays,
    settings: { ...SETTINGS, ...settings },
  });
}

const BONIFACIO: TimesheetHoliday = {
  date: '2026-11-30',
  name: 'Bonifacio Day',
  type: 'regular',
  scope: 'nationwide',
  status: 'confirmed',
};
const ALL_SAINTS_EVE: TimesheetHoliday = {
  date: '2026-10-31',
  name: 'All Saints’ Day Eve',
  type: 'specialNonWorking',
  scope: 'nationwide',
  status: 'confirmed',
};

/** The seeded versions, for computeTimesheet. */
const VERSIONS = {
  workSchedules: PAYROLL_SEED_VERSIONS['talent.workSchedule'],
  premiumRates: PAYROLL_SEED_VERSIONS['talent.premiumRates'],
  timesheetSettings: PAYROLL_SEED_VERSIONS['talent.timesheetSettings'],
  payrollSettings: PAYROLL_SEED_VERSIONS['talent.payrollSettings'],
};

function timesheet(input: Partial<TimesheetHoursInput> & Pick<TimesheetHoursInput, 'entries'>) {
  return computeTimesheet({
    timesheetType: 'overtime',
    periodStart: '2026-09-11',
    periodEnd: '2026-09-25',
    holidays: [],
    assignments: [],
    ...VERSIONS,
    ...input,
  });
}

// ---------------------------------------------------------------------------------------------

describe('the hand-checked cases', () => {
  it('case 1: Overtime, Friday 2026-09-11, 08:00–19:00 marked', () => {
    const d = day('2026-09-11', [entry('2026-09-11', '08:00', '19:00')]);
    expect(d.kind).toBe('ordinary');
    expect(d.workedMinutes).toBe(600);
    expect(formatHours(d.workedMinutes)).toBe('10.0 h');
    expect(d.overtime.ordinaryMinutes).toBe(120);
    expect(formatHours(d.overtime.ordinaryMinutes)).toBe('2.0 h');
    expect(d.nightDifferentialMinutes).toBe(0);
    expect(d.overtime.totalMinutes).toBe(120);
  });

  it('case 2: case 1 unmarked — no overtime, 2.0 h not claimed', () => {
    const d = day('2026-09-11', [entry('2026-09-11', '08:00', '19:00', { marked: false })]);
    expect(d.overtime.totalMinutes).toBe(0);
    expect(d.claimedMinutes).toBe(0);
    expect(d.notClaimedMinutes).toBe(120);
    expect(formatHours(d.notClaimedMinutes)).toBe('2.0 h');
  });

  it('case 3: Overtime, Saturday 2026-09-12 (rest day), 09:00–12:00 — rest day 3.0 h', () => {
    const d = day('2026-09-12', [entry('2026-09-12', '09:00', '12:00')]);
    expect(d.kind).toBe('restDay');
    expect(d.overtime.restDayMinutes).toBe(180);
    expect(formatHours(d.overtime.restDayMinutes)).toBe('3.0 h');
    expect(d.overtime).toMatchObject({ firstHoursMinutes: 180, beyondHoursMinutes: 0 });
  });

  it('case 4: Overtime, ordinary day, 09:00–18:00 — worked 8.0 h, extra 0', () => {
    const d = day('2026-09-11', [entry('2026-09-11', '09:00', '18:00')]);
    expect(formatHours(d.workedMinutes)).toBe('8.0 h');
    expect(d.extraMinutes).toBe(0);
    expect(d.overtime.totalMinutes).toBe(0);
  });

  it('case 5: a Driver, ordinary day, 08:00–23:30 — ordinary 6.5 h, night differential 1.5 h', () => {
    const d = day('2026-09-11', [entry('2026-09-11', '08:00', '23:30')]);
    expect(d.workedMinutes).toBe(870);
    expect(formatHours(d.workedMinutes)).toBe('14.5 h');
    expect(d.overtime.ordinaryMinutes).toBe(390);
    expect(formatHours(d.overtime.ordinaryMinutes)).toBe('6.5 h');
    expect(d.nightDifferentialMinutes).toBe(90);
    expect(formatHours(d.nightDifferentialMinutes)).toBe('1.5 h');
    // Night differential isn't added to the total.
    expect(d.overtime.totalMinutes).toBe(390);
  });

  it('case 6: Overtime, Sunday 2026-09-13, 20:00 to 02:00 — rest day 6.0 h on 2026-09-13, night 4.0 h', () => {
    const sheet = timesheet({
      entries: [entry('2026-09-13', '20:00', '02:00', { nextDay: true })],
    });
    const sunday = sheet.days.find((d) => d.date === '2026-09-13');
    const monday = sheet.days.find((d) => d.date === '2026-09-14');
    expect(sunday?.kind).toBe('restDay');
    expect(sunday?.overtime.restDayMinutes).toBe(360);
    expect(sunday?.nightDifferentialMinutes).toBe(240);
    expect(monday?.workedMinutes).toBe(0);
    expect(formatHours(sheet.totals.restDay.minutes)).toBe('6.0 h');
    expect(formatHours(sheet.totals.nightDifferentialMinutes)).toBe('4.0 h');
  });

  it('case 7: Overtime, Monday 2026-11-30 (confirmed regular holiday), 08:00–19:00 — 8.0 h + 2.0 h beyond 8', () => {
    const d = day('2026-11-30', [entry('2026-11-30', '08:00', '19:00')], {
      holidays: [BONIFACIO],
    });
    expect(d.kind).toBe('regularHoliday');
    expect(d.restDay).toBe(false);
    expect(dayKindLabel(d)).toBe('Regular holiday');
    expect(d.holidayNames).toEqual(['Bonifacio Day']);
    expect(d.overtime.holidayMinutes).toBe(600);
    expect(formatHours(d.overtime.holidayMinutes)).toBe('10.0 h');
    expect(d.overtime).toMatchObject({ firstHoursMinutes: 480, beyondHoursMinutes: 120 });
    expect(beyondHoursText(d.overtime, 8)).toBe('8.0 h + 2.0 h beyond 8');
  });

  it('case 8: case 7 with the holiday a draft, or local — an ordinary day, ordinary 2.0 h', () => {
    const draft = day('2026-11-30', [entry('2026-11-30', '08:00', '19:00')], {
      holidays: [{ ...BONIFACIO, status: 'draft' }],
    });
    expect(draft.kind).toBe('ordinary');
    expect(draft.holidayNames).toEqual([]);
    expect(formatHours(draft.overtime.ordinaryMinutes)).toBe('2.0 h');
    const local = day('2026-11-30', [entry('2026-11-30', '08:00', '19:00')], {
      holidays: [{ ...BONIFACIO, scope: 'local', name: 'City Day' }],
    });
    expect(local.kind).toBe('ordinary');
    expect(local.localHolidayNames).toEqual(['City Day']);
    expect(formatHours(local.overtime.ordinaryMinutes)).toBe('2.0 h');
  });

  it('case 9: Saturday 2026-10-31, a confirmed special day, 09:00–13:00 — holiday 3.0 h on a rest day', () => {
    const d = day('2026-10-31', [entry('2026-10-31', '09:00', '13:00')], {
      holidays: [ALL_SAINTS_EVE],
    });
    expect(d.kind).toBe('specialDay');
    expect(d.restDay).toBe(true);
    expect(dayKindLabel(d)).toBe('Special day on a rest day');
    // The break 12:00–13:00 is deducted.
    expect(d.workedMinutes).toBe(180);
    expect(formatHours(d.overtime.holidayMinutes)).toBe('3.0 h');
    expect(d.overtime.restDayMinutes).toBe(0);
  });

  it('case 10: Standard, Monday 2026-09-14, 07:55 to 19:30 — offset 2.6 h; 3.9 h at 1.5', () => {
    const entries = [entry('2026-09-14', '07:55', '19:30')];
    const d = day('2026-09-14', entries, { type: 'standard' });
    expect(d.treatment).toBe('offset');
    expect(d.workedMinutes).toBe(635);
    expect(formatHours(d.workedMinutes)).toBe('10.6 h');
    expect(d.offsetMinutes).toBe(155);
    expect(formatHours(d.offsetMinutes)).toBe('2.6 h');
    expect(d.overtime.totalMinutes).toBe(0);
    const ratio = day('2026-09-14', entries, {
      type: 'standard',
      settings: { timesheetSettings: { ...SEED_TIMESHEET_SETTINGS, offsetRatio: '1.5' } },
    });
    expect(ratio.offsetMinutes).toBe(233);
    expect(formatHours(ratio.offsetMinutes)).toBe('3.9 h');
  });

  it('case 11: Standard, a rest day, 09:00–12:00 unmarked — offset 0, not claimed 3.0 h', () => {
    const d = day('2026-09-12', [entry('2026-09-12', '09:00', '12:00', { marked: false })], {
      type: 'standard',
    });
    expect(d.offsetMinutes).toBe(0);
    expect(formatHours(d.notClaimedMinutes)).toBe('3.0 h');
  });

  it('case 12: two entries — the extra hours are the last ones, in the second entry', () => {
    const d = day('2026-09-11', [
      entry('2026-09-11', '08:00', '12:00', { marked: false }),
      entry('2026-09-11', '13:00', '19:00'),
    ]);
    expect(formatHours(d.claimedMinutes)).toBe('2.0 h');
    expect(d.notClaimedMinutes).toBe(0);
    expect(d.entries.map((e) => e.claimedMinutes)).toEqual([0, 120]);
    const swapped = day('2026-09-11', [
      entry('2026-09-11', '08:00', '12:00'),
      entry('2026-09-11', '13:00', '19:00', { marked: false }),
    ]);
    expect(swapped.claimedMinutes).toBe(0);
    expect(formatHours(swapped.notClaimedMinutes)).toBe('2.0 h');
  });

  it('case 13: an own schedule 10:00–19:00 from Wednesday 2026-09-16', () => {
    const own: WorkSchedule = {
      ...SEED_WORK_SCHEDULE,
      start: '10:00',
      end: '19:00',
      breakStart: '14:00',
      breakMinutes: 60,
    };
    const assignments = [
      { effectiveFrom: '2026-09-16', schedule: own, createdAt: new Date('2026-09-01T02:00:00Z') },
    ];
    expect(scheduleOn('2026-09-15', VERSIONS.workSchedules, assignments)).toMatchObject({
      origin: 'company',
      schedule: SEED_WORK_SCHEDULE,
    });
    expect(scheduleOn('2026-09-16', VERSIONS.workSchedules, assignments)).toMatchObject({
      origin: 'own',
      schedule: own,
    });
    const sheet = timesheet({
      assignments,
      entries: [entry('2026-09-15', '08:00', '19:00'), entry('2026-09-16', '08:00', '19:00')],
    });
    const tuesday = sheet.days.find((d) => d.date === '2026-09-15');
    const wednesday = sheet.days.find((d) => d.date === '2026-09-16');
    expect(tuesday?.schedule.origin).toBe('company');
    // The default's break 12:00–13:00 is deducted on Tuesday: 10.0 h worked, 2.0 h extra.
    expect(tuesday?.extraMinutes).toBe(120);
    expect(wednesday?.schedule.origin).toBe('own');
    // The own break 14:00–15:00: 08:00–19:00 is 10.0 h worked against 8.0 h scheduled.
    expect(wednesday?.workedMinutes).toBe(600);
    expect(formatHours(wednesday?.extraMinutes ?? -1)).toBe('2.0 h');
  });

  it('case 14: cut-offs', () => {
    const versions = PAYROLL_SEED_VERSIONS['talent.payrollSettings'];
    expect(timesheetPeriodFor('2026-09-26', versions)).toEqual({
      key: 'midMonth',
      start: '2026-09-26',
      end: '2026-10-10',
      payDate: '2026-10-15',
    });
    expect(timesheetPeriodFor('2026-02-20', versions)).toEqual({
      key: 'endOfMonth',
      start: '2026-02-11',
      end: '2026-02-25',
      payDate: '2026-02-28',
    });
    expect(timesheetPeriodFor('2026-02-27', versions)).toEqual({
      key: 'midMonth',
      start: '2026-02-26',
      end: '2026-03-10',
      payDate: '2026-03-15',
    });
  });
});

// ---------------------------------------------------------------------------------------------

describe('cut-offs', () => {
  it('ends a period the day before a later pay schedule takes effect inside it', () => {
    const versions = [
      ...PAYROLL_SEED_VERSIONS['talent.payrollSettings'],
      {
        effectiveFrom: '2026-10-01',
        value: {
          ...SEED_PAYROLL_SETTINGS,
          cutOffs: [
            { key: 'midMonth' as const, startDay: 1, endDay: 15, payDay: 20 },
            { key: 'endOfMonth' as const, startDay: 16, endDay: 28, payDay: 31 },
          ],
        },
      },
    ];
    expect(timesheetPeriodFor('2026-09-28', versions)).toMatchObject({
      start: '2026-09-26',
      end: '2026-09-30',
    });
    expect(timesheetPeriodFor('2026-10-01', versions)).toMatchObject({
      key: 'midMonth',
      start: '2026-10-01',
      end: '2026-10-15',
      payDate: '2026-10-20',
    });
  });

  it('refuses a day with no pay schedule in effect', () => {
    expect(() =>
      timesheetPeriodFor('1999-12-31', PAYROLL_SEED_VERSIONS['talent.payrollSettings']),
    ).toThrow(/No pay schedule/);
  });
});

describe('the break', () => {
  it('is deducted only where an entry overlaps it', () => {
    expect(day('2026-09-11', [entry('2026-09-11', '11:30', '12:30')]).workedMinutes).toBe(30);
    expect(day('2026-09-11', [entry('2026-09-11', '12:15', '12:45')]).workedMinutes).toBe(0);
    expect(day('2026-09-11', [entry('2026-09-11', '12:30', '14:00')]).workedMinutes).toBe(60);
    expect(day('2026-09-11', [entry('2026-09-11', '13:00', '14:00')]).workedMinutes).toBe(60);
  });

  it('is deducted on a rest day too, even when worked through', () => {
    expect(day('2026-09-12', [entry('2026-09-12', '10:00', '15:00')]).workedMinutes).toBe(240);
  });

  it('of an overnight schedule falls after midnight', () => {
    const night: WorkSchedule = {
      workDays: [1, 2, 3, 4, 5],
      start: '22:00',
      end: '06:00',
      breakStart: '02:00',
      breakMinutes: 60,
      graceMinutes: 15,
    };
    const d = day('2026-09-14', [entry('2026-09-14', '22:00', '07:00', { nextDay: true })], {
      settings: { schedule: night },
    });
    expect(scheduledMinutes(night)).toBe(420);
    expect(d.workedMinutes).toBe(480);
    expect(d.extraMinutes).toBe(60);
    // 22:00–06:00 less the 02:00 break: 7 h of night, all paid (the extra hour is 06:00–07:00).
    expect(d.nightDifferentialMinutes).toBe(420);
  });
});

describe('extra minutes', () => {
  it('are the day’s last minutes: a late start made up at the end earns none', () => {
    const d = day('2026-09-11', [entry('2026-09-11', '10:00', '19:00')]);
    expect(d.workedMinutes).toBe(480);
    expect(d.extraMinutes).toBe(0);
  });

  it('count an early start only through the day’s total', () => {
    const d = day('2026-09-11', [entry('2026-09-11', '07:00', '17:00')]);
    expect(d.extraMinutes).toBe(60);
    expect(d.overtime.ordinaryMinutes).toBe(60);
  });

  it('are every minute on a rest day, split at hoursPerDay', () => {
    const d = day('2026-09-12', [entry('2026-09-12', '07:00', '19:00')]);
    expect(d.workedMinutes).toBe(660);
    expect(d.overtime).toMatchObject({
      restDayMinutes: 660,
      firstHoursMinutes: 480,
      beyondHoursMinutes: 180,
    });
  });

  it('drop seconds: an instant counts from its minute', () => {
    const e = entry('2026-09-11', '08:00', '17:00');
    e.timeIn = new Date('2026-09-11T07:59:45+08:00');
    e.timeOut = new Date('2026-09-11T17:30:59+08:00');
    const d = day('2026-09-11', [e]);
    expect(d.workedMinutes).toBe(511);
    expect(d.extraMinutes).toBe(31);
  });
});

describe('the night window', () => {
  it('wraps past midnight on both sides of a day', () => {
    // The early morning: 04:00–09:00, all within the schedule's minutes (paid).
    expect(
      day('2026-09-11', [entry('2026-09-11', '04:00', '09:00')]).nightDifferentialMinutes,
    ).toBe(120);
    // The late night into the next day, on a rest day: 21:00–07:00.
    const d = day('2026-09-12', [entry('2026-09-12', '21:00', '07:00', { nextDay: true })]);
    expect(d.workedMinutes).toBe(600);
    expect(d.nightDifferentialMinutes).toBe(480);
  });

  it('counts paid minutes only: unclaimed extra minutes earn none', () => {
    const d = day('2026-09-11', [entry('2026-09-11', '08:00', '23:30', { marked: false })]);
    expect(d.nightDifferentialMinutes).toBe(0);
    expect(d.notClaimedMinutes).toBe(390);
  });

  it('counts the claimed extra minutes as paid only under the Overtime treatment', () => {
    const d = day('2026-09-11', [entry('2026-09-11', '08:00', '23:30')], { type: 'standard' });
    expect(d.offsetMinutes).toBe(390);
    expect(d.nightDifferentialMinutes).toBe(0);
  });

  it('reads the window from the premium rates', () => {
    const d = day('2026-09-11', [entry('2026-09-11', '08:00', '23:30')], {
      settings: { nightWindow: { nightStart: '23:00', nightEnd: '05:00' } },
    });
    expect(d.nightDifferentialMinutes).toBe(30);
  });
});

describe('the kind of day', () => {
  it('treats a special working day as an ordinary day', () => {
    const d = day('2026-09-11', [entry('2026-09-11', '08:00', '19:00')], {
      holidays: [{ ...BONIFACIO, date: '2026-09-11', type: 'specialWorking' }],
    });
    expect(d.kind).toBe('ordinary');
    expect(d.overtime.ordinaryMinutes).toBe(120);
  });

  it('counts two holidays on one date as one regular holiday', () => {
    const d = day('2026-11-30', [entry('2026-11-30', '08:00', '10:00')], {
      holidays: [BONIFACIO, { ...ALL_SAINTS_EVE, date: '2026-11-30', name: 'Made-up special day' }],
    });
    expect(d.kind).toBe('regularHoliday');
    expect(d.holidayNames).toHaveLength(2);
    expect(d.overtime.holidayMinutes).toBe(120);
  });

  it('marks a regular holiday on a rest day', () => {
    const d = day('2026-11-29', [entry('2026-11-29', '09:00', '10:00')], {
      holidays: [{ ...BONIFACIO, date: '2026-11-29' }],
    });
    expect(dayKindLabel(d)).toBe('Regular holiday on a rest day');
  });

  it('ignores holidays on other dates', () => {
    expect(day('2026-11-27', [], { holidays: [BONIFACIO] }).kind).toBe('ordinary');
  });

  it('knows the ISO weekday', () => {
    expect(isoWeekdayOf('2026-09-13')).toBe(7);
    expect(isoWeekdayOf('2026-09-14')).toBe(1);
  });
});

describe('open entries', () => {
  it('count nothing and are flagged, while closed entries still count', () => {
    const d = day('2026-09-14', [
      entry('2026-09-14', '08:00', '12:00'),
      entry('2026-09-14', '13:00', null),
    ]);
    expect(d.workedMinutes).toBe(240);
    expect(d.openEntries).toBe(1);
    expect(d.entries.map((e) => [e.open, e.workedMinutes])).toEqual([
      [false, 240],
      [true, 0],
    ]);
  });
});

describe('the timesheet', () => {
  it('adds totals in minutes before rounding: three days of 20 minutes show 1.0 h', () => {
    const sheet = timesheet({
      entries: ['2026-09-14', '2026-09-15', '2026-09-16'].map((d) => entry(d, '08:00', '17:20')),
    });
    const days = sheet.days.filter((d) => d.overtime.ordinaryMinutes > 0);
    expect(days.map((d) => formatHours(d.overtime.ordinaryMinutes))).toEqual([
      '0.3 h',
      '0.3 h',
      '0.3 h',
    ]);
    expect(sheet.totals.ordinaryMinutes).toBe(60);
    expect(formatHours(sheet.totals.totalOvertimeMinutes)).toBe('1.0 h');
  });

  it('takes the treatment from the timesheet settings, never the type name', () => {
    const swapped = [
      {
        effectiveFrom: '2000-01-01',
        value: { offsetRatio: '1', extraHours: { overtime: 'overtime', standard: 'overtime' } },
      },
    ] as const;
    const sheet = timesheet({
      timesheetType: 'standard',
      timesheetSettings: swapped,
      entries: [entry('2026-09-14', '08:00', '19:00')],
    });
    expect(sheet.treatment).toBe('overtime');
    expect(sheet.totals.ordinaryMinutes).toBe(120);
    expect(sheet.totals.offsetMinutes).toBe(0);
  });

  it('lists the days from `from` to `to` and adds up every total', () => {
    const sheet = timesheet({
      from: '2026-09-12',
      to: '2026-09-14',
      entries: [
        entry('2026-09-11', '08:00', '19:00'), // before `from`: not listed
        entry('2026-09-12', '09:00', '12:00'),
        entry('2026-09-14', '08:00', '23:30'),
        entry('2026-09-14', '23:40', null),
      ],
    });
    expect(sheet.days.map((d) => d.date)).toEqual(['2026-09-12', '2026-09-13', '2026-09-14']);
    expect(sheet.totals).toEqual({
      workedMinutes: 180 + 870,
      extraMinutes: 180 + 390,
      claimedMinutes: 570,
      notClaimedMinutes: 0,
      ordinaryMinutes: 390,
      restDay: { minutes: 180, firstHoursMinutes: 180, beyondHoursMinutes: 0 },
      holiday: { minutes: 0, firstHoursMinutes: 0, beyondHoursMinutes: 0 },
      nightDifferentialMinutes: 90,
      totalOvertimeMinutes: 570,
      offsetMinutes: 0,
      openEntries: 1,
    });
  });

  it('applies settings versions that change in the middle of the period, day by day', () => {
    const sheet = timesheet({
      timesheetType: 'standard',
      workSchedules: [
        ...VERSIONS.workSchedules,
        {
          effectiveFrom: '2026-09-16',
          value: { ...SEED_WORK_SCHEDULE, start: '09:00', end: '18:00', breakStart: '13:00' },
        },
      ],
      timesheetSettings: [
        ...VERSIONS.timesheetSettings,
        { effectiveFrom: '2026-09-16', value: { ...SEED_TIMESHEET_SETTINGS, offsetRatio: '2' } },
      ],
      entries: [entry('2026-09-15', '09:00', '19:00'), entry('2026-09-16', '09:00', '19:00')],
    });
    const tuesday = sheet.days.find((d) => d.date === '2026-09-15');
    const wednesday = sheet.days.find((d) => d.date === '2026-09-16');
    // Tuesday: the old schedule (break 12:00) and ratio 1: 9 h worked, 1 h extra, offset 60.
    expect(tuesday).toMatchObject({ workedMinutes: 540, extraMinutes: 60, offsetMinutes: 60 });
    // Wednesday: the new schedule (break 13:00) and ratio 2: offset 120.
    expect(wednesday).toMatchObject({ workedMinutes: 540, extraMinutes: 60, offsetMinutes: 120 });
    expect(wednesday?.schedule.effectiveFrom).toBe('2026-09-16');
    expect(sheet.totals.offsetMinutes).toBe(180);
    // The timesheet-level treatment and hoursPerDay come from the period start.
    expect(sheet.treatment).toBe('offset');
    expect(sheet.hoursPerDay).toBe(8);
  });

  it('puts an entry on the Manila day of its time in', () => {
    expect(manilaDateOf(new Date('2026-09-13T16:30:00Z'))).toBe('2026-09-14');
    expect(manilaDateOf(new Date('2026-09-13T15:59:00Z'))).toBe('2026-09-13');
  });
});

describe('scheduleOn and versionOn', () => {
  const evening: WorkSchedule = {
    ...SEED_WORK_SCHEDULE,
    start: '12:00',
    end: '21:00',
    breakStart: '16:00',
  };
  const late: WorkSchedule = {
    ...SEED_WORK_SCHEDULE,
    start: '10:00',
    end: '19:00',
    breakStart: '14:00',
  };

  it('takes the latest assignment on or before the day; a tie goes to the newest', () => {
    const assignments = [
      { effectiveFrom: '2026-09-16', schedule: late, createdAt: new Date('2026-09-02T00:00:00Z') },
      {
        effectiveFrom: '2026-09-16',
        schedule: evening,
        createdAt: new Date('2026-09-03T00:00:00Z'),
      },
      { effectiveFrom: '2026-09-10', schedule: late, createdAt: new Date('2026-09-04T00:00:00Z') },
    ];
    expect(scheduleOn('2026-09-15', VERSIONS.workSchedules, assignments)?.schedule).toBe(late);
    expect(scheduleOn('2026-09-16', VERSIONS.workSchedules, assignments)).toEqual({
      schedule: evening,
      origin: 'own',
      effectiveFrom: '2026-09-16',
    });
    expect(scheduleOn('2026-09-09', VERSIONS.workSchedules, assignments)?.origin).toBe('company');
  });

  it('returns to the company default on a null assignment, by the default’s own versions', () => {
    const defaults = [...VERSIONS.workSchedules, { effectiveFrom: '2026-10-01', value: evening }];
    const assignments = [
      { effectiveFrom: '2026-09-01', schedule: late, createdAt: new Date('2026-08-01T00:00:00Z') },
      { effectiveFrom: '2026-09-20', schedule: null, createdAt: new Date('2026-08-02T00:00:00Z') },
    ];
    expect(scheduleOn('2026-09-19', defaults, assignments)?.origin).toBe('own');
    expect(scheduleOn('2026-09-20', defaults, assignments)).toEqual({
      schedule: SEED_WORK_SCHEDULE,
      origin: 'company',
      effectiveFrom: '2000-01-01',
    });
    expect(scheduleOn('2026-10-01', defaults, assignments)?.schedule).toBe(evening);
    expect(scheduleOn('1999-12-31', defaults, [])).toBeNull();
  });

  it('versionOn picks the latest version on or before the day, in any order', () => {
    const versions = [
      { effectiveFrom: '2026-10-01', value: 'b' },
      { effectiveFrom: '2000-01-01', value: 'a' },
      { effectiveFrom: '2027-01-01', value: 'c' },
    ];
    expect(versionOn(versions, '2026-09-30')?.value).toBe('a');
    expect(versionOn(versions, '2026-10-01')?.value).toBe('b');
    expect(versionOn(versions, '2027-06-01')?.value).toBe('c');
    expect(versionOn(versions, '1999-01-01')).toBeNull();
  });
});

describe('schedule and settings checks', () => {
  const parse = (value: object) =>
    workScheduleSchema.safeParse({ ...SEED_WORK_SCHEDULE, ...value });
  const paths = (value: object) => {
    const result = parse(value);
    return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
  };

  it('accepts the seeded schedule', () => {
    expect(parse({}).success).toBe(true);
    expect(scheduledMinutes(SEED_WORK_SCHEDULE)).toBe(480);
    expect(isOvernightSchedule(SEED_WORK_SCHEDULE)).toBe(false);
  });

  it('refuses no work days, a repeated day, a break outside the span and under 60 minutes', () => {
    expect(paths({ workDays: [] })).toEqual(['workDays']);
    expect(paths({ workDays: [1, 1] })).toEqual(['workDays']);
    expect(paths({ workDays: [0] })).toEqual(['workDays.0']);
    expect(paths({ breakStart: '16:30' })).toEqual(['breakStart']);
    expect(paths({ breakStart: '07:00' })).toEqual(['breakStart']);
    expect(paths({ end: '09:30', breakStart: '08:30' })).toEqual(['end']);
    expect(paths({ breakMinutes: 181 })).toEqual(['breakMinutes']);
    expect(paths({ graceMinutes: 61 })).toEqual(['graceMinutes']);
    expect(paths({ start: '8:00' })).toEqual(['start']);
  });

  it('reads an end before the start as an overnight schedule, and equal as 24 hours', () => {
    const overnight = { start: '22:00', end: '06:00', breakStart: '02:00' };
    expect(parse(overnight).success).toBe(true);
    expect(isOvernightSchedule({ ...SEED_WORK_SCHEDULE, ...overnight })).toBe(true);
    expect(scheduledMinutes({ ...SEED_WORK_SCHEDULE, ...overnight })).toBe(420);
    const fullDay = { start: '08:00', end: '08:00', breakStart: '12:00', breakMinutes: 0 };
    expect(parse(fullDay).success).toBe(true);
    expect(scheduledMinutes({ ...SEED_WORK_SCHEDULE, ...fullDay })).toBe(1440);
  });

  it('checks the timesheet settings', () => {
    expect(timesheetSettingsSchema.safeParse(SEED_TIMESHEET_SETTINGS).success).toBe(true);
    for (const offsetRatio of ['0', '0.000', '-1', 'one', '1.1234567']) {
      expect(
        timesheetSettingsSchema.safeParse({ ...SEED_TIMESHEET_SETTINGS, offsetRatio }).success,
        offsetRatio,
      ).toBe(false);
    }
    expect(
      timesheetSettingsSchema.safeParse({
        ...SEED_TIMESHEET_SETTINGS,
        extraHours: { overtime: 'overtime' },
      }).success,
    ).toBe(false);
  });
});

describe('display', () => {
  it('rounds hours half-up to one decimal, in integers', () => {
    expect([0, 2, 3, 8, 9, 155, 233, 635].map(tenthsOfHour)).toEqual([0, 0, 1, 1, 2, 26, 39, 106]);
    expect(formatHours(0)).toBe('0.0 h');
    expect(formatHours(870)).toBe('14.5 h');
    expect(() => formatHours(-1)).toThrow();
    expect(() => formatHours(1.5)).toThrow();
  });
});
