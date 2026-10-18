import { describe, expect, it } from 'vitest';
import { addDays, type TimesheetType } from '@pulse/core';
import { PAYROLL_SEED_VERSIONS, SEED_WORK_SCHEDULE } from '../server/payroll-settings/seed-data';
import {
  formatHours,
  type TimeEntryHoursInput,
  type TimesheetHoliday,
} from '../timesheets/compute';
import type { WorkScheduleAssignmentInput } from '../timesheets/schedule';
import {
  computeDtr,
  type Dtr,
  type DtrDay,
  type DtrInput,
  dtrDayHalves,
  type DtrTimeOffInput,
  lateAndUndertime,
} from './compute';
import {
  DTR_DAY_STATUS_LABELS,
  DTR_DAY_STATUSES,
  type DtrTimeOffPortion,
  type DtrTimeOffStatus,
  dtrTimeOffLabel,
} from './statuses';

// The DTR tests (docs/TESTING.md#timesheet-approval-dtr-and-offset-tests, build step 2.7,
// decisions 288–291 in docs/BUILD_PLAN.md): the hand-checked cases D1–D12 of
// docs/modules/talent.md#timesheet-approval-the-dtr-and-the-offset-balance-build-step-27, each its
// own test, the DTR offset totals behind D13 and D14 (the credit and the adjustment themselves are
// server tests), and the edge cases. The seeded schedule (08:00–17:00, break 12:00–13:00, grace 15
// minutes), hoursPerDay 8, the night window 22:00–06:00 and offsetRatio 1. Each extra-hours entry
// is marked unless it says "unmarked".

/** A Manila wall-clock time on a day. */
const at = (day: string, time: string) => new Date(`${day}T${time}:00+08:00`);

let ids = 0;
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

const VERSIONS = {
  workSchedules: PAYROLL_SEED_VERSIONS['talent.workSchedule'],
  premiumRates: PAYROLL_SEED_VERSIONS['talent.premiumRates'],
  timesheetSettings: PAYROLL_SEED_VERSIONS['talent.timesheetSettings'],
  payrollSettings: PAYROLL_SEED_VERSIONS['talent.payrollSettings'],
};

const SEPTEMBER = { periodStart: '2026-09-11', periodEnd: '2026-09-25' };
const OCTOBER = { periodStart: '2026-10-26', periodEnd: '2026-11-10' };
const NOVEMBER = { periodStart: '2026-11-26', periodEnd: '2026-12-10' };

function dtr(
  input: Partial<DtrInput> & { entries: TimeEntryHoursInput[] },
  type: TimesheetType = 'overtime',
): Dtr {
  return computeDtr({
    timesheetType: type,
    ...SEPTEMBER,
    holidays: [],
    assignments: [],
    ...VERSIONS,
    approved: false,
    dateHired: '2020-01-06',
    today: '2026-12-31',
    ...input,
  });
}

function dayOf(result: Dtr, date: string): DtrDay {
  const found = result.days.find((day) => day.date === date);
  if (!found) throw new Error(`${date} isn't listed.`);
  return found;
}

/** The DTR day of one date with the given entries. */
function oneDay(
  date: string,
  entries: TimeEntryHoursInput[],
  options: {
    type?: TimesheetType;
    holidays?: TimesheetHoliday[];
    assignments?: WorkScheduleAssignmentInput[];
  } = {},
): DtrDay {
  const period =
    date >= NOVEMBER.periodStart ? NOVEMBER : date >= OCTOBER.periodStart ? OCTOBER : SEPTEMBER;
  return dayOf(
    dtr(
      {
        ...period,
        entries,
        holidays: options.holidays ?? [],
        assignments: options.assignments ?? [],
      },
      options.type,
    ),
    date,
  );
}

const BONIFACIO: TimesheetHoliday = {
  date: '2026-11-30',
  name: 'Bonifacio Day',
  type: 'regular',
  scope: 'nationwide',
  status: 'confirmed',
};

// Monday 2026-09-14, an ordinary day.
const MONDAY = '2026-09-14';

/** One day of approved time off (step 2.8): VL for leave, Offset for offset time off. */
function off(
  date: string,
  status: DtrTimeOffStatus,
  portion: DtrTimeOffPortion = 'whole',
  extra: Partial<DtrTimeOffInput> = {},
): DtrTimeOffInput {
  const kind = status === 'offsetPaid' ? 'offset' : 'leave';
  return {
    date,
    status,
    portion,
    kind,
    shortName: kind === 'offset' ? 'Offset' : 'VL',
    requestId: `req-${date}-${portion}`,
    ...extra,
  };
}

// ---------------------------------------------------------------------------------------------

describe('the hand-checked DTR cases', () => {
  it('D1: ordinary day, 08:10–17:00 — present, late 0 within the grace, worked 7.8 h', () => {
    const d = oneDay(MONDAY, [entry(MONDAY, '08:10', '17:00')]);
    expect(d.status).toBe('present');
    expect(d.lateMinutes).toBe(0);
    expect(d.undertimeMinutes).toBe(0);
    expect(d.workedMinutes).toBe(470);
    expect(formatHours(d.workedMinutes)).toBe('7.8 h');
  });

  it('D2: ordinary day, 08:16–17:00 — late 16 min, undertime 0', () => {
    const d = oneDay(MONDAY, [entry(MONDAY, '08:16', '17:00')]);
    expect(d.status).toBe('present');
    expect(d.lateMinutes).toBe(16);
    expect(d.undertimeMinutes).toBe(0);
  });

  it('D3: ordinary day, 08:15–17:00 — late 0, exactly the grace period', () => {
    const d = oneDay(MONDAY, [entry(MONDAY, '08:15', '17:00')]);
    expect(d.status).toBe('present');
    expect(d.lateMinutes).toBe(0);
  });

  it('D4: ordinary day, 08:00–16:00 — undertime 60 min', () => {
    const d = oneDay(MONDAY, [entry(MONDAY, '08:00', '16:00')]);
    expect(d.status).toBe('present');
    expect(d.lateMinutes).toBe(0);
    expect(d.undertimeMinutes).toBe(60);
  });

  it('D5: ordinary day, 08:00–12:00 and 14:00–17:00 — undertime 60 min, worked 7.0 h', () => {
    const d = oneDay(MONDAY, [entry(MONDAY, '08:00', '12:00'), entry(MONDAY, '14:00', '17:00')]);
    expect(d.status).toBe('present');
    expect(d.undertimeMinutes).toBe(60);
    expect(d.workedMinutes).toBe(420);
    expect(formatHours(d.workedMinutes)).toBe('7.0 h');
  });

  it('D6: ordinary day, 08:30–17:30 — late 30 min, undertime 0, extra 0 (no make-up)', () => {
    const d = oneDay(MONDAY, [entry(MONDAY, '08:30', '17:30')]);
    expect(d.status).toBe('present');
    expect(d.lateMinutes).toBe(30);
    expect(d.undertimeMinutes).toBe(0);
    expect(d.extraMinutes).toBe(0);
    expect(d.overtime.totalMinutes).toBe(0);
  });

  it('D7: ordinary day, no entry — absent (unpaid)', () => {
    const d = oneDay(MONDAY, []);
    expect(d.status).toBe('absentUnpaid');
    expect(DTR_DAY_STATUS_LABELS[d.status]).toBe('Absent (unpaid)');
    expect(d.lateMinutes).toBe(0);
    expect(d.undertimeMinutes).toBe(0);
  });

  it('D8: Saturday, no entry — rest day', () => {
    const d = oneDay('2026-09-12', []);
    expect(d.status).toBe('restDay');
  });

  it('D9: Monday 2026-11-30, confirmed regular holiday, no entry — holiday; a draft — absent', () => {
    expect(oneDay('2026-11-30', [], { holidays: [BONIFACIO] }).status).toBe('holiday');
    expect(oneDay('2026-11-30', [], { holidays: [{ ...BONIFACIO, status: 'draft' }] }).status).toBe(
      'absentUnpaid',
    );
  });

  it('D10: Standard, ordinary day, 08:00–19:00 — offset 120 min, night differential 0', () => {
    const d = oneDay(MONDAY, [entry(MONDAY, '08:00', '19:00')], { type: 'standard' });
    expect(d.status).toBe('present');
    expect(d.offsetMinutes).toBe(120);
    expect(formatHours(d.offsetMinutes)).toBe('2.0 h');
    expect(d.nightDifferentialMinutes).toBe(0);
    expect(d.overtime.totalMinutes).toBe(0);
  });

  it('D11: Overtime (a Driver), ordinary day, 08:00–23:30 — ordinary 6.5 h, night 1.5 h', () => {
    const d = oneDay(MONDAY, [entry(MONDAY, '08:00', '23:30')]);
    expect(d.status).toBe('present');
    expect(d.overtime.ordinaryMinutes).toBe(390);
    expect(formatHours(d.overtime.ordinaryMinutes)).toBe('6.5 h');
    expect(d.nightDifferentialMinutes).toBe(90);
    expect(d.lateMinutes).toBe(0);
    expect(d.undertimeMinutes).toBe(0);
  });

  it('D12: Standard, own schedule 14:00–23:00, 14:00–23:00 — late 0, night 1.0 h, offset 0', () => {
    const own: WorkScheduleAssignmentInput = {
      effectiveFrom: '2026-09-01',
      schedule: { ...SEED_WORK_SCHEDULE, start: '14:00', end: '23:00', breakStart: '18:00' },
      createdAt: new Date('2026-08-20T00:00:00Z'),
    };
    const d = oneDay(MONDAY, [entry(MONDAY, '14:00', '23:00')], {
      type: 'standard',
      assignments: [own],
    });
    expect(d.schedule.origin).toBe('own');
    expect(d.status).toBe('present');
    expect(d.lateMinutes).toBe(0);
    expect(d.undertimeMinutes).toBe(0);
    expect(d.nightDifferentialMinutes).toBe(60);
    expect(formatHours(d.nightDifferentialMinutes)).toBe('1.0 h');
    expect(d.offsetMinutes).toBe(0);
  });

  it('D13 (the DTR side): a Standard timesheet with D10 and step 2.4 case 10 totals 275 min', () => {
    const result = dtr(
      {
        entries: [entry(MONDAY, '07:55', '19:30'), entry('2026-09-15', '08:00', '19:00')],
      },
      'standard',
    );
    expect(dayOf(result, MONDAY).offsetMinutes).toBe(155);
    expect(dayOf(result, '2026-09-15').offsetMinutes).toBe(120);
    expect(result.totals.offsetMinutes).toBe(275);
    expect(formatHours(result.totals.offsetMinutes)).toBe('4.6 h');
  });

  it('D14 (the DTR side): Nov 30 08:00–17:00 marked gives offset 0 as a draft, 480 confirmed', () => {
    const entries = [entry('2026-11-30', '08:00', '17:00')];
    const draft = dtr(
      { ...NOVEMBER, entries, holidays: [{ ...BONIFACIO, status: 'draft' }], approved: true },
      'standard',
    );
    const confirmed = dtr(
      { ...NOVEMBER, entries, holidays: [BONIFACIO], approved: true },
      'standard',
    );
    expect(draft.totals.offsetMinutes).toBe(0);
    expect(dayOf(draft, '2026-11-30').status).toBe('present');
    expect(confirmed.totals.offsetMinutes).toBe(480);
    expect(dayOf(confirmed, '2026-11-30').status).toBe('holiday');
    expect(confirmed.totals.offsetMinutes - draft.totals.offsetMinutes).toBe(480);
  });
});

describe('day statuses', () => {
  it('a holiday on a rest day is a holiday', () => {
    const saturday: TimesheetHoliday = {
      date: '2026-10-31',
      name: 'All Saints’ Day Eve',
      type: 'specialNonWorking',
      scope: 'nationwide',
      status: 'confirmed',
    };
    const d = oneDay('2026-10-31', [], { holidays: [saturday] });
    expect(d.restDay).toBe(true);
    expect(d.status).toBe('holiday');
  });

  it('a worked holiday is a holiday, with no late or undertime', () => {
    const d = oneDay('2026-11-30', [entry('2026-11-30', '09:00', '12:00')], {
      holidays: [BONIFACIO],
    });
    expect(d.status).toBe('holiday');
    expect(d.workedMinutes).toBe(180);
    expect(d.lateMinutes).toBe(0);
    expect(d.undertimeMinutes).toBe(0);
  });

  it('a worked rest day is a rest day', () => {
    const d = oneDay('2026-09-12', [entry('2026-09-12', '09:00', '12:00')]);
    expect(d.status).toBe('restDay');
    expect(d.overtime.restDayMinutes).toBe(180);
  });

  it('a special working day with no entry is absent', () => {
    const d = oneDay(MONDAY, [], {
      holidays: [
        {
          date: MONDAY,
          name: 'Special working day',
          type: 'specialWorking',
          scope: 'nationwide',
          status: 'confirmed',
        },
      ],
    });
    expect(d.status).toBe('absentUnpaid');
  });

  it('a local holiday is not applied: no entry is absent', () => {
    const d = oneDay(MONDAY, [], {
      holidays: [{ date: MONDAY, name: 'City day', type: 'specialNonWorking', scope: 'local' }],
    });
    expect(d.status).toBe('absentUnpaid');
  });

  it('an open entry counts nothing: the day is absent', () => {
    const d = oneDay(MONDAY, [entry(MONDAY, '08:00', null)]);
    expect(d.status).toBe('absentUnpaid');
    expect(d.openEntries).toBe(1);
    expect(d.firstTimeIn).toBeNull();
  });

  it('time off (step 2.8) wins over present and absent, never over a holiday or rest day', () => {
    const result = dtr({
      entries: [entry('2026-09-16', '08:00', '17:00')],
      timeOff: [
        off(MONDAY, 'onLeavePaid'),
        off('2026-09-15', 'leaveWithoutPay'),
        off('2026-09-16', 'offsetPaid'),
        off('2026-09-12', 'onLeavePaid'),
      ],
    });
    expect(dayOf(result, MONDAY).status).toBe('onLeavePaid');
    expect(dayOf(result, '2026-09-15').status).toBe('leaveWithoutPay');
    expect(dayOf(result, '2026-09-16').status).toBe('offsetPaid');
    expect(dayOf(result, '2026-09-16').workedMinutes).toBe(480);
    expect(dayOf(result, '2026-09-12').status).toBe('restDay');
  });

  it('refuses a time off status that is not one', () => {
    expect(() =>
      dtr({
        entries: [],
        timeOff: [{ ...off(MONDAY, 'onLeavePaid'), status: 'present' as never }],
      }),
    ).toThrow(RangeError);
  });

  it('lists every status, with a label for each', () => {
    for (const status of DTR_DAY_STATUSES) expect(DTR_DAY_STATUS_LABELS[status]).toBeTruthy();
  });
});

describe('late and undertime', () => {
  it('counts a late start after lunch without the break', () => {
    // First in 13:30: 08:00–12:00 and 13:00–13:30 are late (270 min), not the 12:00 break.
    const d = oneDay(MONDAY, [entry(MONDAY, '13:30', '17:00')]);
    expect(d.lateMinutes).toBe(270);
    expect(d.undertimeMinutes).toBe(0);
  });

  it('a late start and leaving early both count', () => {
    const d = oneDay(MONDAY, [entry(MONDAY, '09:00', '16:30')]);
    expect(d.lateMinutes).toBe(60);
    expect(d.undertimeMinutes).toBe(30);
  });

  it('work only after the scheduled end is all late, and makes nothing up', () => {
    const d = oneDay(MONDAY, [entry(MONDAY, '18:00', '20:00')]);
    expect(d.status).toBe('present');
    expect(d.lateMinutes).toBe(480);
    expect(d.undertimeMinutes).toBe(0);
  });

  it('an early start is never late, and seconds are dropped', () => {
    const early = oneDay(MONDAY, [entry(MONDAY, '07:30', '17:00')]);
    expect(early.lateMinutes).toBe(0);
    const seconds: TimeEntryHoursInput = {
      id: 'sec',
      timeIn: new Date(`${MONDAY}T08:16:59+08:00`),
      timeOut: at(MONDAY, '17:00'),
      extraHours: null,
    };
    expect(oneDay(MONDAY, [seconds]).lateMinutes).toBe(16);
  });

  it('lateAndUndertime is zero with no closed entry', () => {
    expect(lateAndUndertime(MONDAY, SEED_WORK_SCHEDULE, [])).toEqual({
      firstTimeIn: null,
      lateMinutes: 0,
      undertimeMinutes: 0,
    });
  });

  it('a grace period of 0 makes any minute late', () => {
    const d = oneDay(MONDAY, [entry(MONDAY, '08:01', '17:00')], {
      assignments: [
        {
          effectiveFrom: '2026-09-01',
          schedule: { ...SEED_WORK_SCHEDULE, graceMinutes: 0 },
          createdAt: new Date('2026-08-20T00:00:00Z'),
        },
      ],
    });
    expect(d.lateMinutes).toBe(1);
  });
});

describe('the days listed, final and totals', () => {
  it('lists no day before the date hired, after the separation date or after today', () => {
    const result = dtr({ entries: [], dateHired: '2026-09-14', separationDate: '2026-09-20' });
    expect(result.from).toBe('2026-09-14');
    expect(result.to).toBe('2026-09-20');
    expect(result.days.map((day) => day.date)).toEqual([
      '2026-09-14',
      '2026-09-15',
      '2026-09-16',
      '2026-09-17',
      '2026-09-18',
      '2026-09-19',
      '2026-09-20',
    ]);
    expect(dtr({ entries: [], today: '2026-09-14' }).to).toBe('2026-09-14');
  });

  it('narrows to a requested window', () => {
    const result = dtr({ entries: [], from: '2026-09-20', to: '2026-09-22' });
    expect(result.days.map((day) => day.date)).toEqual(['2026-09-20', '2026-09-21', '2026-09-22']);
  });

  it('lists nothing when hired after the period', () => {
    const result = dtr({ entries: [], dateHired: '2026-10-01' });
    expect(result.days).toEqual([]);
    expect(result.totals.days.absentUnpaid).toBe(0);
  });

  it('a day on an approved timesheet is final; on a pending one, a preview', () => {
    const approved = dtr({ entries: [], approved: true });
    expect(approved.final).toBe(true);
    expect(approved.days.every((day) => day.final)).toBe(true);
    const pending = dtr({ entries: [] });
    expect(pending.final).toBe(false);
    expect(pending.days.some((day) => day.final)).toBe(false);
  });

  it('adds the totals in minutes and counts the days by status', () => {
    const result = dtr({
      entries: [
        entry(MONDAY, '08:16', '17:00'),
        entry('2026-09-15', '08:30', '16:00'),
        entry('2026-09-16', '08:00', '19:00'),
      ],
    });
    // Sep 11–25: 11 work days, 4 rest days; 3 present, 8 absent.
    expect(result.totals.days).toEqual({
      holiday: 0,
      restDay: 4,
      onLeavePaid: 0,
      offsetPaid: 0,
      leaveWithoutPay: 0,
      present: 3,
      absentUnpaid: 8,
    });
    expect(result.totals.lateDays).toBe(2);
    expect(result.totals.lateMinutes).toBe(16 + 30);
    expect(result.totals.undertimeMinutes).toBe(60);
    expect(result.totals.ordinaryMinutes).toBe(120);
    expect(result.totals.workedMinutes).toBe(464 + 390 + 600);
  });

  it('the period start is the first day when hired earlier', () => {
    expect(dtr({ entries: [] }).from).toBe(SEPTEMBER.periodStart);
  });
});

// ---------------------------------------------------------------------------------------------
// Step 2.8: time off on the DTR (docs/TESTING.md#leave-and-time-off-tests, decision 315): the DTR
// side of the hand-checked cases L4–L8, O1 and O5 of
// docs/modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28, from hand-built
// inputs (the balances themselves are server tests).

// Monday 2026-11-02, an ordinary day in the Oct 26 – Nov 10 cut-off.
const NOV_2 = '2026-11-02';

/** The DTR of a cut-off (October's unless given), with the given entries and time off. */
function withTimeOff(
  entries: TimeEntryHoursInput[],
  timeOff: DtrTimeOffInput[],
  options: { type?: TimesheetType; holidays?: TimesheetHoliday[]; period?: typeof OCTOBER } = {},
): Dtr {
  return dtr(
    {
      ...(options.period ?? OCTOBER),
      entries,
      timeOff,
      holidays: options.holidays ?? [],
    },
    options.type,
  );
}

/** The first time off part of a day. */
function firstPart(day: DtrDay) {
  const part = day.timeOff[0];
  if (!part) throw new Error(`${day.date} has no time off.`);
  return part;
}

const unmarked = { marked: false };

describe('time off on the DTR: the hand-checked cases', () => {
  it('L4: VL Nov 30 – Dec 1 with Nov 30 a confirmed holiday — Nov 30 Holiday, 1 day of leave', () => {
    const result = withTimeOff(
      [],
      [off('2026-11-30', 'onLeavePaid'), off('2026-12-01', 'onLeavePaid')],
      { holidays: [BONIFACIO], period: NOVEMBER },
    );
    const holiday = dayOf(result, '2026-11-30');
    expect(holiday.status).toBe('holiday');
    expect(holiday.timeOff).toEqual([]);
    expect(dayOf(result, '2026-12-01').status).toBe('onLeavePaid');
    expect(result.totals.paidLeaveDays).toBe(1);
    expect(result.totals.days.onLeavePaid).toBe(1);
  });

  it('L5: VL for 3 days, the last without pay — leaveWithoutPayDays 1', () => {
    const result = withTimeOff(
      [],
      [
        off(NOV_2, 'onLeavePaid'),
        off('2026-11-03', 'onLeavePaid'),
        off('2026-11-04', 'leaveWithoutPay'),
      ],
    );
    expect(dayOf(result, NOV_2).status).toBe('onLeavePaid');
    expect(dayOf(result, NOV_2).leaveWithoutPayDays).toBe(0);
    const last = dayOf(result, '2026-11-04');
    expect(last.status).toBe('leaveWithoutPay');
    expect(DTR_DAY_STATUS_LABELS[last.status]).toBe('Leave without pay');
    expect(last.leaveWithoutPayDays).toBe(1);
    expect(last.absentMinutes).toBe(0);
    expect(result.totals.paidLeaveDays).toBe(2);
    expect(result.totals.leaveWithoutPayDays).toBe(1);
    expect(result.totals.days.leaveWithoutPay).toBe(1);
  });

  it('L6: half-day VL, first half, worked 13:00–17:00 — present, late 0, undertime 0', () => {
    const result = withTimeOff(
      [entry(NOV_2, '13:00', '17:00', unmarked)],
      [off(NOV_2, 'onLeavePaid', 'firstHalf')],
    );
    const d = dayOf(result, NOV_2);
    expect(d.status).toBe('present');
    expect(d.lateMinutes).toBe(0);
    expect(d.undertimeMinutes).toBe(0);
    expect(d.absentMinutes).toBe(0);
    expect(d.timeOff).toHaveLength(1);
    const part = firstPart(d);
    expect(part.minutes).toBe(240);
    expect(part.intervals).toEqual([{ start: at(NOV_2, '08:00'), end: at(NOV_2, '12:00') }]);
    expect(dtrTimeOffLabel(part)).toBe('Half day VL (paid)');
    expect(result.totals.paidLeaveDays).toBe(0.5);
    expect(result.totals.days.present).toBe(1);
  });

  it('L7: half-day VL, first half, first time in 13:20 — late 20 min from 13:00', () => {
    const late = withTimeOff(
      [entry(NOV_2, '13:20', '17:00', unmarked)],
      [off(NOV_2, 'onLeavePaid', 'firstHalf')],
    );
    expect(dayOf(late, NOV_2).status).toBe('present');
    expect(dayOf(late, NOV_2).lateMinutes).toBe(20);
    expect(dayOf(late, NOV_2).undertimeMinutes).toBe(0);
    expect(late.totals.lateDays).toBe(1);
    // 13:15 is within the 15-minute grace period from the uncovered start.
    const grace = withTimeOff(
      [entry(NOV_2, '13:15', '17:00', unmarked)],
      [off(NOV_2, 'onLeavePaid', 'firstHalf')],
    );
    expect(dayOf(grace, NOV_2).lateMinutes).toBe(0);
  });

  it('L8: half-day VL, second half, nothing worked — on leave (paid), absentMinutes 240', () => {
    const result = withTimeOff([], [off(NOV_2, 'onLeavePaid', 'secondHalf')]);
    const d = dayOf(result, NOV_2);
    expect(d.status).toBe('onLeavePaid');
    expect(d.absentMinutes).toBe(240);
    expect(d.lateMinutes).toBe(0);
    expect(d.undertimeMinutes).toBe(0);
    expect(firstPart(d).intervals).toEqual([
      { start: at(NOV_2, '13:00'), end: at(NOV_2, '17:00') },
    ]);
    expect(result.totals.absentMinutes).toBe(240);
    expect(result.totals.paidLeaveDays).toBe(0.5);
  });

  it('O1: offset 13:00–17:00, worked 08:00–12:00 — present, "Offset (paid) 4.0 h", undertime 0', () => {
    const result = withTimeOff(
      [entry(NOV_2, '08:00', '12:00', unmarked)],
      [off(NOV_2, 'offsetPaid', 'part', { intervals: [{ fromTime: '13:00', toTime: '17:00' }] })],
      { type: 'standard' },
    );
    const d = dayOf(result, NOV_2);
    expect(d.status).toBe('present');
    expect(d.lateMinutes).toBe(0);
    expect(d.undertimeMinutes).toBe(0);
    expect(d.absentMinutes).toBe(0);
    expect(firstPart(d).minutes).toBe(240);
    expect(dtrTimeOffLabel(firstPart(d))).toBe('Offset (paid) 4.0 h');
    expect(result.totals.offsetMinutesUsed).toBe(240);
    expect(result.totals.paidLeaveDays).toBe(0);
  });

  it('O5 (the DTR side): whole-day offset time off — Offset (paid), 480 min used', () => {
    const result = withTimeOff([], [off(NOV_2, 'offsetPaid')], { type: 'standard' });
    const d = dayOf(result, NOV_2);
    expect(d.status).toBe('offsetPaid');
    expect(DTR_DAY_STATUS_LABELS[d.status]).toBe('Offset (paid)');
    expect(firstPart(d).minutes).toBe(480);
    expect(d.absentMinutes).toBe(0);
    expect(result.totals.offsetMinutesUsed).toBe(480);
    expect(result.totals.days.offsetPaid).toBe(1);
  });
});

describe('time off on the DTR: the rules', () => {
  it('a whole day of leave is on leave (paid) even when worked, with no late or undertime', () => {
    const d = dayOf(
      withTimeOff([entry(NOV_2, '10:00', '11:00', unmarked)], [off(NOV_2, 'onLeavePaid')]),
      NOV_2,
    );
    expect(d.status).toBe('onLeavePaid');
    expect(d.lateMinutes).toBe(0);
    expect(d.undertimeMinutes).toBe(0);
    expect(d.absentMinutes).toBe(0);
    expect(dtrTimeOffLabel(firstPart(d))).toBe('On leave (paid) · VL');
  });

  it('time off on a rest day is never charged: the rest day is shown', () => {
    const result = withTimeOff(
      [],
      [off('2026-10-31', 'offsetPaid'), off('2026-11-01', 'onLeavePaid')],
    );
    expect(dayOf(result, '2026-10-31').status).toBe('restDay');
    expect(dayOf(result, '2026-11-01').timeOff).toEqual([]);
    expect(result.totals.offsetMinutesUsed).toBe(0);
    expect(result.totals.paidLeaveDays).toBe(0);
  });

  it('a partly covered day counts undertime only against the uncovered minutes', () => {
    const d = dayOf(
      withTimeOff(
        [entry(NOV_2, '13:00', '16:00', unmarked)],
        [off(NOV_2, 'onLeavePaid', 'firstHalf')],
      ),
      NOV_2,
    );
    expect(d.status).toBe('present');
    expect(d.lateMinutes).toBe(0);
    expect(d.undertimeMinutes).toBe(60);
  });

  it('a half paid and a half without pay cover the day: on leave (paid), 0.5 without pay', () => {
    const result = withTimeOff(
      [],
      [off(NOV_2, 'onLeavePaid', 'firstHalf'), off(NOV_2, 'leaveWithoutPay', 'secondHalf')],
    );
    const d = dayOf(result, NOV_2);
    expect(d.status).toBe('onLeavePaid');
    expect(d.timeOff).toHaveLength(2);
    expect(d.absentMinutes).toBe(0);
    expect(d.leaveWithoutPayDays).toBe(0.5);
    const unpaid = d.timeOff[1];
    expect(unpaid && dtrTimeOffLabel(unpaid)).toBe('Half day leave without pay');
    expect(result.totals.paidLeaveDays).toBe(0.5);
    expect(result.totals.leaveWithoutPayDays).toBe(0.5);
  });

  it('a half day without pay and nothing worked: leave without pay, 240 min absent', () => {
    const d = dayOf(withTimeOff([], [off(NOV_2, 'leaveWithoutPay', 'firstHalf')]), NOV_2);
    expect(d.status).toBe('leaveWithoutPay');
    expect(d.leaveWithoutPayDays).toBe(0.5);
    expect(d.absentMinutes).toBe(240);
  });

  it('offset over the break covers only scheduled minutes', () => {
    const result = withTimeOff(
      [entry(NOV_2, '08:00', '11:00', unmarked), entry(NOV_2, '15:00', '17:00', unmarked)],
      [off(NOV_2, 'offsetPaid', 'part', { intervals: [{ fromTime: '11:00', toTime: '15:00' }] })],
      { type: 'standard' },
    );
    const d = dayOf(result, NOV_2);
    expect(firstPart(d).minutes).toBe(180);
    expect(d.status).toBe('present');
    expect(d.undertimeMinutes).toBe(0);
    expect(result.totals.offsetMinutesUsed).toBe(180);
  });

  it('a day without time off keeps step 2.7 behaviour, with the new fields at 0', () => {
    const d = oneDay(MONDAY, [entry(MONDAY, '08:00', '16:00')]);
    expect(d.timeOff).toEqual([]);
    expect(d.absentMinutes).toBe(0);
    expect(d.leaveWithoutPayDays).toBe(0);
    expect(d.undertimeMinutes).toBe(60);
  });

  it('splits a schedule with no break at its midpoint, rounded down', () => {
    const halves = dtrDayHalves(NOV_2, { ...SEED_WORK_SCHEDULE, breakMinutes: 0 });
    expect(halves.firstHalf).toEqual({ start: at(NOV_2, '08:00'), end: at(NOV_2, '12:30') });
    expect(halves.secondHalf).toEqual({ start: at(NOV_2, '12:30'), end: at(NOV_2, '17:00') });
    const withBreak = dtrDayHalves(NOV_2, SEED_WORK_SCHEDULE);
    expect(withBreak.firstHalf.end).toEqual(at(NOV_2, '12:00'));
    expect(withBreak.secondHalf.start).toEqual(at(NOV_2, '13:00'));
  });

  it('lateAndUndertime with the whole day covered is zero', () => {
    const halves = dtrDayHalves(NOV_2, SEED_WORK_SCHEDULE);
    const covered = [halves.firstHalf, halves.secondHalf];
    expect(
      lateAndUndertime(NOV_2, SEED_WORK_SCHEDULE, [entry(NOV_2, '15:00', '16:00')], covered),
    ).toMatchObject({ lateMinutes: 0, undertimeMinutes: 0 });
  });

  it('refuses part of a day without times, part-day leave, and a mismatched kind', () => {
    expect(() => withTimeOff([], [off(NOV_2, 'offsetPaid', 'part')])).toThrow(RangeError);
    const partLeave = off(NOV_2, 'onLeavePaid', 'part', {
      intervals: [{ fromTime: '13:00', toTime: '17:00' }],
    });
    expect(() => withTimeOff([], [partLeave])).toThrow(RangeError);
    const mismatched = off(NOV_2, 'onLeavePaid', 'whole', { kind: 'offset' });
    expect(() => withTimeOff([], [mismatched])).toThrow(RangeError);
  });

  it('labels whole-day leave without pay plainly', () => {
    const part = {
      status: 'leaveWithoutPay',
      portion: 'whole',
      shortName: 'VL',
      minutes: 480,
    } as const;
    expect(dtrTimeOffLabel(part)).toBe('Leave without pay');
  });
});
