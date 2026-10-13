import {
  addDays,
  type BusinessDate,
  type HolidayScope,
  type HolidayStatus,
  type HolidayType,
  isBusinessDate,
  ratio,
  roundHalfUp,
  type TimesheetType,
} from '@pulse/core';
import type { PayrollSettings, PremiumRates } from '../payroll/schemas';
import {
  type EffectiveVersion,
  type ScheduleOnDay,
  scheduleOn,
  versionOn,
  type WorkScheduleAssignmentInput,
} from './schedule';
import {
  breakOffsetMinutes,
  type ExtraHoursTreatment,
  type IsoWeekday,
  MINUTES_PER_DAY,
  minutesOfClockTime,
  scheduledMinutes,
  type TimesheetSettings,
  type WorkSchedule,
} from './schemas';

// Spec: docs/modules/talent.md#work-schedules-and-daily-time-entries-build-step-24 ("How hours are
// computed"), docs/COMPLIANCE.md#timesheet-hours-build-step-24 (decisions 223–230 and 232 in
// docs/BUILD_PLAN.md) — the hours of a day and of a timesheet, FOR DISPLAY. No pay is computed and
// nothing here is stored; steps 2.7 (the DTR) and 2.9 (payroll) build on the same functions.
//
// Units: whole minutes, on Manila time, fixed at UTC+8 with no daylight saving. An instant is
// counted from its minute (seconds are dropped). Totals are added in minutes before any rounding.
// Every rule marked *Assumption* in the spec is one of HANDOFF items 46–61.

/** Manila's fixed offset from UTC, in minutes. */
export const MANILA_UTC_OFFSET_MINUTES = 480;
const MS_PER_MINUTE = 60_000;

// ---------------------------------------------------------------------------------------------
// Minutes and days

/** The whole minute an instant falls in, counted from the Unix epoch (seconds are dropped). */
export function epochMinuteOf(instant: Date): number {
  const ms = instant.getTime();
  if (!Number.isFinite(ms)) throw new RangeError('The time is not a valid instant.');
  return Math.floor(ms / MS_PER_MINUTE);
}

function partsOf(day: BusinessDate): { year: number; month: number; date: number } {
  if (!isBusinessDate(day)) throw new RangeError(`"${day}" is not a date in YYYY-MM-DD form.`);
  return {
    year: Number(day.slice(0, 4)),
    month: Number(day.slice(5, 7)),
    date: Number(day.slice(8)),
  };
}

/** The epoch minute at which a Manila day starts (00:00 Manila = 16:00 UTC the day before). */
export function manilaDayStartMinute(day: BusinessDate): number {
  const { year, month, date } = partsOf(day);
  return Date.UTC(year, month - 1, date) / MS_PER_MINUTE - MANILA_UTC_OFFSET_MINUTES;
}

/** The Manila day an instant falls on (an entry's date is the Manila day of its time in). */
export function manilaDateOf(instant: Date): BusinessDate {
  const minute = epochMinuteOf(instant) + MANILA_UTC_OFFSET_MINUTES;
  return new Date(minute * MS_PER_MINUTE).toISOString().slice(0, 10);
}

/** The ISO weekday of a day: 1 Monday to 7 Sunday. */
export function isoWeekdayOf(day: BusinessDate): IsoWeekday {
  const { year, month, date } = partsOf(day);
  const weekday = new Date(Date.UTC(year, month - 1, date)).getUTCDay();
  return (weekday === 0 ? 7 : weekday) as IsoWeekday;
}

// ---------------------------------------------------------------------------------------------
// Display: hours to one decimal, half-up

function assertMinutes(minutes: number): void {
  if (!Number.isSafeInteger(minutes) || minutes < 0) {
    throw new RangeError('Minutes must be a whole number of zero or more.');
  }
}

/** Minutes as tenths of an hour, rounded half-up (155 → 26, i.e. 2.6 h). Integer arithmetic. */
export function tenthsOfHour(minutes: number): number {
  assertMinutes(minutes);
  // minutes ÷ 60 × 10 = minutes ÷ 6; half-up: floor((minutes + 3) ÷ 6).
  return Math.floor((minutes + 3) / 6);
}

/** Minutes as hours to one decimal, rounded half-up: 635 → "10.6". */
export function hoursText(minutes: number): string {
  const tenths = tenthsOfHour(minutes);
  return `${Math.floor(tenths / 10)}.${tenths % 10}`;
}

/** Minutes as hours for display: 155 → "2.6 h". Add minutes first, then format the total. */
export function formatHours(minutes: number): string {
  return `${hoursText(minutes)} h`;
}

// ---------------------------------------------------------------------------------------------
// Inputs

/** A holiday on the calendar, as Core's `listConfirmedHolidays` returns it. */
export interface TimesheetHoliday {
  date: BusinessDate;
  name: string;
  type: HolidayType;
  scope: HolidayScope;
  /** Core's read returns confirmed holidays only; a draft passed here is ignored. */
  status?: HolidayStatus;
}

/** A time entry, as the hours computation needs it. */
export interface TimeEntryHoursInput {
  id: string;
  timeIn: Date;
  /** Null while the entry is open: it counts nothing. */
  timeOut: Date | null;
  /** The extra-hours mark: its extra minutes are claimed. Null when unmarked. */
  extraHours: { reason: string } | null;
}

/** The night window of the `talent.premiumRates` version in effect that day. */
export type NightWindow = Pick<PremiumRates, 'nightStart' | 'nightEnd'>;

/** The settings for one day (talent.md, "The settings for a day"). */
export interface DaySettings {
  /** The schedule in effect that day (the employee's own or the company default). */
  schedule: WorkSchedule;
  nightWindow: NightWindow;
  /** `talent.timesheetSettings` in effect that day. */
  timesheetSettings: TimesheetSettings;
  /** `hoursPerDay` of the `talent.payrollSettings` version in effect on the cut-off's start. */
  hoursPerDay: number;
}

export interface DayInput {
  /** The Manila day. Entries belong to the day of their time in. */
  date: BusinessDate;
  /** The timesheet's stored type; the treatment comes from `timesheetSettings.extraHours`. */
  timesheetType: TimesheetType;
  /** The day's entries (whose time in falls on `date`). They never overlap. */
  entries: readonly TimeEntryHoursInput[];
  /** Holidays on or around the day; only those on `date` are read. */
  holidays: readonly TimesheetHoliday[];
  settings: DaySettings;
}

// ---------------------------------------------------------------------------------------------
// Outputs

export const DAY_KINDS = ['ordinary', 'restDay', 'regularHoliday', 'specialDay'] as const;
export type DayKind = (typeof DAY_KINDS)[number];
export const DAY_KIND_LABELS: Record<DayKind, string> = {
  ordinary: 'Ordinary day',
  restDay: 'Rest day',
  regularHoliday: 'Regular holiday',
  specialDay: 'Special day',
};

/** The day's claimed hours by kind (Overtime treatment; all zero for Offset). */
export interface OvertimeByKind {
  /** Claimed extra minutes on an ordinary day. */
  ordinaryMinutes: number;
  /** Claimed minutes on a rest day (not a holiday). */
  restDayMinutes: number;
  /** Claimed minutes on a regular holiday or special day, on a rest day or not. */
  holidayMinutes: number;
  /** On a rest day or holiday: the claimed minutes within the first `hoursPerDay` hours. */
  firstHoursMinutes: number;
  /** On a rest day or holiday: the claimed minutes beyond the first `hoursPerDay` hours. */
  beyondHoursMinutes: number;
  /** Ordinary + rest day + holiday; night differential isn't added in. */
  totalMinutes: number;
}

export interface EntryHours {
  id: string;
  /** True while the entry has no time out ("No time out"); it counts nothing. */
  open: boolean;
  /** True when the entry has the extra-hours mark. */
  marked: boolean;
  /** Its minutes less any overlap with the break window. */
  workedMinutes: number;
  /** Its minutes among the day's extra minutes. */
  extraMinutes: number;
  /** Extra minutes in a marked entry. */
  claimedMinutes: number;
  /** Extra minutes in an unmarked entry ("Not claimed"). */
  notClaimedMinutes: number;
}

export interface DayHours {
  date: BusinessDate;
  weekday: IsoWeekday;
  kind: DayKind;
  /** True when the schedule doesn't list the weekday (a holiday may also be on a rest day). */
  restDay: boolean;
  /** The applied nationwide holiday names (two on one date count as one), or empty. */
  holidayNames: string[];
  /** Local holidays on the day: shown as information, never applied (*Assumption*). */
  localHolidayNames: string[];
  /** The treatment of claimed extra hours that day, from `timesheetSettings.extraHours`. */
  treatment: ExtraHoursTreatment;
  /** The schedule's scheduled minutes (span less break). */
  scheduledMinutes: number;
  workedMinutes: number;
  /** Ordinary day: the last worked minutes beyond the schedule; rest day or holiday: all. */
  extraMinutes: number;
  claimedMinutes: number;
  notClaimedMinutes: number;
  /** Claimed hours by kind (Overtime treatment), zeros under Offset. */
  overtime: OvertimeByKind;
  /**
   * Paid minutes inside the night window. Paid minutes are the scheduled (non-extra) worked
   * minutes, plus the claimed extra minutes under the Overtime treatment. The Overtime timesheet
   * shows it; the DTR (step 2.7) also uses it for Standard employees.
   */
  nightDifferentialMinutes: number;
  /** Offset treatment: claimed minutes × `offsetRatio`, half-up to the minute; 0 under Overtime. */
  offsetMinutes: number;
  /** The number of open entries ("No time out"). */
  openEntries: number;
  /** Each entry, in time-in order. */
  entries: EntryHours[];
}

// ---------------------------------------------------------------------------------------------
// The day

interface Interval {
  start: number;
  end: number;
}

interface Piece extends Interval {
  entry: number;
}

function overlap(a: Interval, b: Interval): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

/** `interval` less every window in `windows` (non-overlapping), as ordered pieces. */
function subtract(interval: Interval, windows: readonly Interval[]): Interval[] {
  let pieces: Interval[] = [interval];
  for (const window of windows) {
    const next: Interval[] = [];
    for (const piece of pieces) {
      if (window.end <= piece.start || window.start >= piece.end) {
        next.push(piece);
        continue;
      }
      if (piece.start < window.start) next.push({ start: piece.start, end: window.start });
      if (window.end < piece.end) next.push({ start: window.end, end: piece.end });
    }
    pieces = next;
  }
  return pieces.filter((piece) => piece.end > piece.start);
}

/**
 * The break windows that can touch an entry starting on the day: the schedule's break placed on
 * the day before, the day itself and the day after (an overnight schedule's break may fall after
 * midnight; an entry lasts at most 24 hours).
 */
function breakWindows(dayStart: number, schedule: WorkSchedule): Interval[] {
  if (schedule.breakMinutes === 0) return [];
  const offset = minutesOfClockTime(schedule.start) + breakOffsetMinutes(schedule);
  return [-1, 0, 1].map((k) => {
    const start = dayStart + k * MINUTES_PER_DAY + offset;
    return { start, end: start + schedule.breakMinutes };
  });
}

/** The night windows that can touch an entry starting on the day; the window may wrap midnight. */
function nightWindows(dayStart: number, night: NightWindow): Interval[] {
  const start = minutesOfClockTime(night.nightStart);
  const end = minutesOfClockTime(night.nightEnd);
  const length = end > start ? end - start : end + MINUTES_PER_DAY - start;
  return [-1, 0, 1, 2].map((k) => {
    const from = dayStart + k * MINUTES_PER_DAY + start;
    return { start: from, end: from + length };
  });
}

/** The kind of a day, its applied holidays and its local holidays (information only). */
export function dayKindOf(
  date: BusinessDate,
  schedule: Pick<WorkSchedule, 'workDays'>,
  holidays: readonly TimesheetHoliday[],
): { kind: DayKind; restDay: boolean; holidayNames: string[]; localHolidayNames: string[] } {
  const weekday = isoWeekdayOf(date);
  const restDay = !schedule.workDays.includes(weekday);
  const live = holidays.filter(
    (holiday) => holiday.date === date && (holiday.status ?? 'confirmed') === 'confirmed',
  );
  // A special working day is an ordinary day; local holidays wait for a work location.
  const applied = live.filter(
    (holiday) => holiday.scope === 'nationwide' && holiday.type !== 'specialWorking',
  );
  const localHolidayNames = live
    .filter((holiday) => holiday.scope === 'local')
    .map((holiday) => holiday.name);
  const holidayNames = applied.map((holiday) => holiday.name);
  let kind: DayKind = restDay ? 'restDay' : 'ordinary';
  if (applied.length > 0) {
    // Two holidays on one date count as one (decision 210): a regular holiday when either is,
    // and two regular holidays are one regular holiday (double holiday pay isn't seeded).
    kind = applied.some((holiday) => holiday.type === 'regular') ? 'regularHoliday' : 'specialDay';
  }
  return { kind, restDay, holidayNames, localHolidayNames };
}

/** "Regular holiday on a rest day", "Special day", "Rest day", "Ordinary day". */
export function dayKindLabel(day: Pick<DayHours, 'kind' | 'restDay'>): string {
  const label = DAY_KIND_LABELS[day.kind];
  const holiday = day.kind === 'regularHoliday' || day.kind === 'specialDay';
  return holiday && day.restDay ? `${label} on a rest day` : label;
}

function treatmentFor(settings: TimesheetSettings, type: TimesheetType): ExtraHoursTreatment {
  const treatment = settings.extraHours[type];
  if (treatment !== 'overtime' && treatment !== 'offset') {
    throw new RangeError(`The timesheet settings have no treatment for the ${type} type.`);
  }
  return treatment;
}

/** Claimed minutes × the offset ratio, rounded half-up to the minute (exact, no floats). */
export function offsetMinutesFor(claimedMinutes: number, offsetRatio: string): number {
  assertMinutes(claimedMinutes);
  const r = ratio(offsetRatio);
  return Number(roundHalfUp(BigInt(claimedMinutes) * r.numerator, r.denominator));
}

/** The hours of one day, for display. */
export function computeDay(input: DayInput): DayHours {
  const { date, settings } = input;
  const { schedule } = settings;
  const dayStart = manilaDayStartMinute(date);
  const scheduled = scheduledMinutes(schedule);
  const { kind, restDay, holidayNames, localHolidayNames } = dayKindOf(
    date,
    schedule,
    input.holidays,
  );
  const treatment = treatmentFor(settings.timesheetSettings, input.timesheetType);
  if (!Number.isSafeInteger(settings.hoursPerDay) || settings.hoursPerDay <= 0) {
    throw new RangeError('The hours per day must be a whole number above zero.');
  }

  // Entries in time-in order; open ones count nothing.
  const entries = [...input.entries].sort(
    (a, b) => epochMinuteOf(a.timeIn) - epochMinuteOf(b.timeIn) || a.id.localeCompare(b.id),
  );
  const breaks = breakWindows(dayStart, schedule);
  const pieces: Piece[] = [];
  entries.forEach((entry, index) => {
    if (!entry.timeOut) return;
    const start = epochMinuteOf(entry.timeIn);
    const end = epochMinuteOf(entry.timeOut);
    if (end <= start) return;
    for (const piece of subtract({ start, end }, breaks)) pieces.push({ ...piece, entry: index });
  });
  pieces.sort((a, b) => a.start - b.start);

  const worked = pieces.reduce((sum, piece) => sum + (piece.end - piece.start), 0);
  const extra = kind === 'ordinary' ? Math.max(0, worked - scheduled) : worked;

  // The extra minutes are the day's LAST worked minutes, in time order.
  const extraPieces: Piece[] = [];
  const regularPieces: Piece[] = [];
  let remaining = extra;
  for (let i = pieces.length - 1; i >= 0; i -= 1) {
    const piece = pieces[i] as Piece;
    const length = piece.end - piece.start;
    const take = Math.min(remaining, length);
    remaining -= take;
    if (take > 0) extraPieces.push({ ...piece, start: piece.end - take });
    if (take < length) regularPieces.push({ ...piece, end: piece.end - take });
  }

  const entryHours: EntryHours[] = entries.map((entry) => ({
    id: entry.id,
    open: entry.timeOut === null,
    marked: entry.extraHours !== null,
    workedMinutes: 0,
    extraMinutes: 0,
    claimedMinutes: 0,
    notClaimedMinutes: 0,
  }));
  for (const piece of pieces) {
    (entryHours[piece.entry] as EntryHours).workedMinutes += piece.end - piece.start;
  }
  const claimedPieces: Piece[] = [];
  for (const piece of extraPieces) {
    const hours = entryHours[piece.entry] as EntryHours;
    const length = piece.end - piece.start;
    hours.extraMinutes += length;
    if (hours.marked) {
      hours.claimedMinutes += length;
      claimedPieces.push(piece);
    } else {
      hours.notClaimedMinutes += length;
    }
  }
  const claimed = entryHours.reduce((sum, hours) => sum + hours.claimedMinutes, 0);

  // Paid minutes: the scheduled worked minutes, plus the claimed extra ones under Overtime.
  const paid = treatment === 'overtime' ? [...regularPieces, ...claimedPieces] : regularPieces;
  const nights = nightWindows(dayStart, settings.nightWindow);
  const nightDifferential = paid.reduce(
    (sum, piece) => sum + nights.reduce((inner, night) => inner + overlap(piece, night), 0),
    0,
  );

  const overtime: OvertimeByKind = {
    ordinaryMinutes: 0,
    restDayMinutes: 0,
    holidayMinutes: 0,
    firstHoursMinutes: 0,
    beyondHoursMinutes: 0,
    totalMinutes: 0,
  };
  if (treatment === 'overtime' && claimed > 0) {
    if (kind === 'ordinary') {
      overtime.ordinaryMinutes = claimed;
    } else {
      if (kind === 'restDay') overtime.restDayMinutes = claimed;
      else overtime.holidayMinutes = claimed;
      overtime.firstHoursMinutes = Math.min(claimed, settings.hoursPerDay * 60);
      overtime.beyondHoursMinutes = claimed - overtime.firstHoursMinutes;
    }
    overtime.totalMinutes = claimed;
  }

  return {
    date,
    weekday: isoWeekdayOf(date),
    kind,
    restDay,
    holidayNames,
    localHolidayNames,
    treatment,
    scheduledMinutes: scheduled,
    workedMinutes: worked,
    extraMinutes: extra,
    claimedMinutes: claimed,
    notClaimedMinutes: extra - claimed,
    overtime,
    nightDifferentialMinutes: nightDifferential,
    offsetMinutes:
      treatment === 'offset'
        ? offsetMinutesFor(claimed, settings.timesheetSettings.offsetRatio)
        : 0,
    openEntries: entryHours.filter((hours) => hours.open).length,
    entries: entryHours,
  };
}

// ---------------------------------------------------------------------------------------------
// The timesheet

export interface TimesheetHoursInput {
  timesheetType: TimesheetType;
  periodStart: BusinessDate;
  periodEnd: BusinessDate;
  /** The first day listed (the date hired, when later than the period start). */
  from?: BusinessDate;
  /** The last day listed (today, when earlier than the period end). */
  to?: BusinessDate;
  /** The timesheet's entries; each belongs to the Manila day of its time in. */
  entries: readonly TimeEntryHoursInput[];
  /** Confirmed holidays from the period start to the period end (Core's `listConfirmedHolidays`). */
  holidays: readonly TimesheetHoliday[];
  /** `talent.workSchedule` versions (the company default). */
  workSchedules: readonly EffectiveVersion<WorkSchedule>[];
  /** The employee's `workScheduleAssignments`. */
  assignments: readonly WorkScheduleAssignmentInput[];
  /** `talent.premiumRates` versions (only the night window is read). */
  premiumRates: readonly EffectiveVersion<NightWindow>[];
  /** `talent.timesheetSettings` versions. */
  timesheetSettings: readonly EffectiveVersion<TimesheetSettings>[];
  /** `talent.payrollSettings` versions (only `hoursPerDay`, on the period start, is read). */
  payrollSettings: readonly EffectiveVersion<Pick<PayrollSettings, 'hoursPerDay'>>[];
}

/** A day of the timesheet, with the schedule it was computed against. */
export interface TimesheetDayHours extends DayHours {
  schedule: ScheduleOnDay;
}

/** The claimed minutes of a kind across the cut-off, with the rest-day and holiday split. */
export interface KindTotal {
  minutes: number;
  /** Within the first `hoursPerDay` hours of each day. */
  firstHoursMinutes: number;
  /** Beyond the first `hoursPerDay` hours of each day. */
  beyondHoursMinutes: number;
}

export interface TimesheetTotals {
  workedMinutes: number;
  extraMinutes: number;
  claimedMinutes: number;
  notClaimedMinutes: number;
  ordinaryMinutes: number;
  restDay: KindTotal;
  holiday: KindTotal;
  nightDifferentialMinutes: number;
  /** Ordinary + rest day + holiday; night differential isn't added in. */
  totalOvertimeMinutes: number;
  /** The sum of each day's rounded offset. */
  offsetMinutes: number;
  openEntries: number;
}

export interface TimesheetHours {
  timesheetType: TimesheetType;
  periodStart: BusinessDate;
  periodEnd: BusinessDate;
  /** The treatment in effect on the period start: which extra-hours card the page shows. */
  treatment: ExtraHoursTreatment;
  hoursPerDay: number;
  /** One per day from `from` to `to`, in date order. */
  days: TimesheetDayHours[];
  totals: TimesheetTotals;
}

function required<T>(value: T | null, what: string, day: BusinessDate): T {
  if (value === null) throw new RangeError(`No ${what} is in effect on ${day}.`);
  return value;
}

/**
 * The hours of a timesheet: each day from `from` (or the period start) to `to` (or the period
 * end), against the settings in effect that day, with the cut-off's totals added in minutes.
 * Entries whose time-in day falls outside those days are not counted.
 */
export function computeTimesheet(input: TimesheetHoursInput): TimesheetHours {
  const { periodStart, periodEnd } = input;
  partsOf(periodStart);
  partsOf(periodEnd);
  const first = input.from && input.from > periodStart ? input.from : periodStart;
  const last = input.to && input.to < periodEnd ? input.to : periodEnd;

  const hoursPerDay = required(
    versionOn(input.payrollSettings, periodStart),
    'pay schedule',
    periodStart,
  ).value.hoursPerDay;
  const treatment = treatmentFor(
    required(versionOn(input.timesheetSettings, periodStart), 'timesheet setting', periodStart)
      .value,
    input.timesheetType,
  );

  const byDate = new Map<BusinessDate, TimeEntryHoursInput[]>();
  for (const entry of input.entries) {
    const date = manilaDateOf(entry.timeIn);
    const list = byDate.get(date);
    if (list) list.push(entry);
    else byDate.set(date, [entry]);
  }

  const days: TimesheetDayHours[] = [];
  for (let date = first; date <= last; date = addDays(date, 1)) {
    const schedule = required(
      scheduleOn(date, input.workSchedules, input.assignments),
      'work schedule',
      date,
    );
    const day = computeDay({
      date,
      timesheetType: input.timesheetType,
      entries: byDate.get(date) ?? [],
      holidays: input.holidays,
      settings: {
        schedule: schedule.schedule,
        nightWindow: required(versionOn(input.premiumRates, date), 'premium rate', date).value,
        timesheetSettings: required(
          versionOn(input.timesheetSettings, date),
          'timesheet setting',
          date,
        ).value,
        hoursPerDay,
      },
    });
    days.push({ ...day, schedule });
  }

  const totals: TimesheetTotals = {
    workedMinutes: 0,
    extraMinutes: 0,
    claimedMinutes: 0,
    notClaimedMinutes: 0,
    ordinaryMinutes: 0,
    restDay: { minutes: 0, firstHoursMinutes: 0, beyondHoursMinutes: 0 },
    holiday: { minutes: 0, firstHoursMinutes: 0, beyondHoursMinutes: 0 },
    nightDifferentialMinutes: 0,
    totalOvertimeMinutes: 0,
    offsetMinutes: 0,
    openEntries: 0,
  };
  for (const day of days) {
    totals.workedMinutes += day.workedMinutes;
    totals.extraMinutes += day.extraMinutes;
    totals.claimedMinutes += day.claimedMinutes;
    totals.notClaimedMinutes += day.notClaimedMinutes;
    totals.ordinaryMinutes += day.overtime.ordinaryMinutes;
    const kindTotal = day.overtime.restDayMinutes > 0 ? totals.restDay : totals.holiday;
    if (day.overtime.restDayMinutes > 0 || day.overtime.holidayMinutes > 0) {
      kindTotal.minutes += day.overtime.restDayMinutes + day.overtime.holidayMinutes;
      kindTotal.firstHoursMinutes += day.overtime.firstHoursMinutes;
      kindTotal.beyondHoursMinutes += day.overtime.beyondHoursMinutes;
    }
    totals.nightDifferentialMinutes += day.nightDifferentialMinutes;
    totals.totalOvertimeMinutes += day.overtime.totalMinutes;
    totals.offsetMinutes += day.offsetMinutes;
    totals.openEntries += day.openEntries;
  }

  return {
    timesheetType: input.timesheetType,
    periodStart,
    periodEnd,
    treatment,
    hoursPerDay,
    days,
    totals,
  };
}

/** The rest-day or holiday split sub-line: "8.0 h + 2.0 h beyond 8". */
export function beyondHoursText(
  split: { firstHoursMinutes: number; beyondHoursMinutes: number },
  hoursPerDay: number,
): string {
  return `${formatHours(split.firstHoursMinutes)} + ${formatHours(split.beyondHoursMinutes)} beyond ${hoursPerDay}`;
}
