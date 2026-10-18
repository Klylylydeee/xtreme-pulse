import { z } from 'zod';
import { type BusinessDate, businessDateField, type EmploymentStatus } from '@pulse/core';
import { SEXES } from '../fixed-sets';
import { daysTextOf, parseDaysText } from './units';

// Spec: docs/DATA_MODEL.md#versioned-configuration (`talent.leaveSettings`) and
// docs/modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28 ("Leave
// settings"; decisions 300, 301 and 306 in docs/BUILD_PLAN.md) — the leave types, the go-live
// date and the offset time off minimum, as one versioned setting. Pure code, safe in the browser:
// the Leave segment's "Add version" sheet and the service parse with the same schema. Nothing
// here is a hardcoded rate: every figure comes from the setting, seeded below.
//
// `days` and `carryOverCapDays` are whole or half days written as text ("5", "2.5"), because
// Core's store refuses fractional numbers; `halfDaysOf` reads them as whole half days.

/** The setting's key. */
export const LEAVE_SETTINGS_KEY = 'talent.leaveSettings';
/** The seeded version's effective date and source. */
export const LEAVE_SETTINGS_SEED_EFFECTIVE_FROM: BusinessDate = '2000-01-01';
export const LEAVE_SETTINGS_SEED_SOURCE = 'Company policy (spec) and the laws named per type';

/** How a type's limit works. */
export const LEAVE_BALANCE_KINDS = ['credited', 'perEvent', 'perYear'] as const;
export type LeaveBalanceKind = (typeof LEAVE_BALANCE_KINDS)[number];
export const LEAVE_BALANCE_KIND_LABELS: Record<LeaveBalanceKind, string> = {
  credited: 'Credited balance',
  perEvent: 'Per request',
  perYear: 'Per calendar year',
};

/** Which days of a request count. */
export const LEAVE_COUNT_DAYS = ['workDays', 'calendarDays'] as const;
export type LeaveCountDays = (typeof LEAVE_COUNT_DAYS)[number];
export const LEAVE_COUNT_DAYS_LABELS: Record<LeaveCountDays, string> = {
  workDays: 'Work days',
  calendarDays: 'Calendar days',
};

/** The employment statuses a type may be open to (active statuses only). */
export const LEAVE_ELIGIBLE_STATUSES = [
  'Probationary',
  'Regular',
  'Contractual',
] as const satisfies readonly EmploymentStatus[];
export type LeaveEligibleStatus = (typeof LEAVE_ELIGIBLE_STATUSES)[number];

/** The offset time off minimum and step run from 15 to 480 whole minutes. */
export const OFFSET_TIME_OFF_MINUTES_MIN = 15;
export const OFFSET_TIME_OFF_MINUTES_MAX = 480;
/** A type's `days` runs above 0 up to 366 days; the carry-over cap from 0 to 366. */
export const LEAVE_TYPE_DAYS_MAX = 366;
/** `minServiceMonths` runs from 1 to 120; `minNoticeDays` from 0 to 90. */
export const LEAVE_MIN_SERVICE_MONTHS_MAX = 120;
export const LEAVE_MIN_NOTICE_DAYS_MAX = 90;

const KEY = /^[a-z][a-zA-Z0-9]{0,39}$/;
const ANNUAL_DATE = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const text = (what: string, max: number) =>
  z
    .string({ error: `Enter the ${what}.` })
    .trim()
    .min(1, `Enter the ${what}.`)
    .max(max, `Use at most ${max} characters.`);

const nullableText = (max: number) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
    z.string().trim().max(max, `Use at most ${max} characters.`).nullable(),
  );

/** Days as text: a number or text in, the canonical text ("2.5", "5") out. */
const daysField = (what: string, { min }: { min: 0 | 'aboveZero' }) =>
  z
    .preprocess(
      (value) => (typeof value === 'number' ? String(value) : value),
      z.string({ error: `Enter the ${what} in days.` }).trim(),
    )
    .transform((value, ctx) => {
      const halfDays = parseDaysText(value);
      if (halfDays === null) {
        ctx.addIssue({ code: 'custom', message: `Enter the ${what} in whole or half days.` });
        return z.NEVER;
      }
      if (min === 'aboveZero' ? halfDays <= 0 : halfDays < 0) {
        ctx.addIssue({
          code: 'custom',
          message: `The ${what} must be ${min === 'aboveZero' ? 'above' : 'at least'} 0 days.`,
        });
        return z.NEVER;
      }
      if (halfDays > LEAVE_TYPE_DAYS_MAX * 2) {
        ctx.addIssue({
          code: 'custom',
          message: `The ${what} runs up to ${LEAVE_TYPE_DAYS_MAX} days.`,
        });
        return z.NEVER;
      }
      return daysTextOf(halfDays);
    });

const wholeNumber = (what: string, min: number, max: number) =>
  z
    .number({ error: `Enter the ${what}.` })
    .int(`Enter the ${what} as a whole number.`)
    .min(min, `The ${what} runs from ${min} to ${max}.`)
    .max(max, `The ${what} runs from ${min} to ${max}.`);

const offsetMinutesField = (what: string) =>
  wholeNumber(what, OFFSET_TIME_OFF_MINUTES_MIN, OFFSET_TIME_OFF_MINUTES_MAX);

export const leaveCreditingSchema = z.object({
  /** The day of the annual credit, `MM-DD` (seeded `01-01`). */
  annualCreditOn: z
    .string({ error: 'Enter the annual credit day as MM-DD.' })
    .trim()
    .regex(ANNUAL_DATE, 'Enter the annual credit day as MM-DD, like 01-01.'),
  prorateFromRegularization: z.boolean(),
  /** Null for no cap (the spec's default). */
  carryOverCapDays: daysField('carry-over cap', { min: 0 }).nullable(),
});
export type LeaveCrediting = z.output<typeof leaveCreditingSchema>;

export const leaveEligibilitySchema = z.object({
  employmentStatuses: z
    .array(
      z.enum(LEAVE_ELIGIBLE_STATUSES, { error: 'Choose Probationary, Regular or Contractual.' }),
    )
    .min(1, 'Choose at least one employment status.')
    .refine((list) => new Set(list).size === list.length, {
      message: 'Each employment status can appear only once.',
    }),
  sex: z.enum(SEXES, { error: 'Choose female or male.' }).nullable(),
  minServiceMonths: wholeNumber('service months', 1, LEAVE_MIN_SERVICE_MONTHS_MAX).nullable(),
  maxRequests: z
    .number({ error: 'Enter the most requests.' })
    .int('Enter the most requests as a whole number.')
    .min(1, 'The most requests is at least 1.')
    .nullable(),
});
export type LeaveEligibility = z.output<typeof leaveEligibilitySchema>;

export const leaveFilingSchema = z
  .object({
    minNoticeDays: wholeNumber('notice days', 0, LEAVE_MIN_NOTICE_DAYS_MAX).nullable(),
    allowFuture: z.boolean(),
    allowPast: z.boolean(),
  })
  .refine((value) => value.allowFuture || value.allowPast, {
    message: 'Allow filing ahead, after the fact, or both.',
    path: ['allowFuture'],
  });
export type LeaveFiling = z.output<typeof leaveFilingSchema>;

export const leaveAttachmentSchema = z.object({
  label: text('attachment label', 100),
  required: z.boolean(),
});
export type LeaveAttachment = z.output<typeof leaveAttachmentSchema>;

export const leaveTypeSchema = z
  .object({
    key: z
      .string({ error: 'Enter the leave type key.' })
      .trim()
      .regex(
        KEY,
        'Use a key of letters and digits starting with a lowercase letter, like vacation.',
      ),
    name: text('name', 100),
    shortName: text('short name', 10),
    active: z.boolean(),
    paid: z.boolean(),
    balance: z.enum(LEAVE_BALANCE_KINDS, { error: 'Choose how the balance works.' }),
    days: daysField('days', { min: 'aboveZero' }),
    countDays: z.enum(LEAVE_COUNT_DAYS, { error: 'Choose work days or calendar days.' }),
    halfDays: z.boolean(),
    crediting: leaveCreditingSchema.nullable(),
    eligibility: leaveEligibilitySchema,
    filing: leaveFilingSchema,
    attachment: leaveAttachmentSchema.nullable(),
    confidential: z.boolean(),
    legalBasis: nullableText(200),
  })
  .superRefine((value, ctx) => {
    if ((value.balance === 'credited') !== (value.crediting !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['crediting'],
        message:
          value.balance === 'credited'
            ? 'A credited type needs its crediting rules.'
            : 'Only a credited type has crediting rules.',
      });
    }
  });
export type LeaveType = z.output<typeof leaveTypeSchema>;
export type LeaveTypeInput = z.input<typeof leaveTypeSchema>;

export const leaveSettingsSchema = z
  .object({
    /** The Manila day Pulse Talent goes live, or null until HR sets it. */
    goLiveDate: z.preprocess(
      (value) => (value === '' || value === undefined ? null : value),
      businessDateField('Enter the go-live date.').nullable(),
    ),
    offsetTimeOff: z.object({
      minimumMinutes: offsetMinutesField('minimum'),
      stepMinutes: offsetMinutesField('step'),
    }),
    types: z.array(leaveTypeSchema),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.types.forEach((type, index) => {
      if (seen.has(type.key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['types', index, 'key'],
          message: 'Each leave type key can appear only once.',
        });
      }
      seen.add(type.key);
    });
  });
export type LeaveSettings = z.output<typeof leaveSettingsSchema>;
export type LeaveSettingsInput = z.input<typeof leaveSettingsSchema>;

/** The type with `key`, or null. */
export function leaveTypeOf(settings: Pick<LeaveSettings, 'types'>, key: string): LeaveType | null {
  return settings.types.find((type) => type.key === key) ?? null;
}

/** The active `credited` types (VL and SL when seeded): the ones with leave entries and balances. */
export function creditedLeaveTypes(settings: Pick<LeaveSettings, 'types'>): LeaveType[] {
  return settings.types.filter((type) => type.balance === 'credited' && type.active);
}

// ---------------------------------------------------------------------------------------------
// Adding a version

/** The keys of `previous` missing from `next`: a key, once added, stays in every later version. */
export function removedLeaveTypeKeys(
  previous: Pick<LeaveSettings, 'types'> | null | undefined,
  next: Pick<LeaveSettings, 'types'>,
): string[] {
  if (!previous) return [];
  const kept = new Set(next.types.map((type) => type.key));
  return previous.types.map((type) => type.key).filter((key) => !kept.has(key));
}

/** One reason a new version is refused, besides the schema's own checks. */
export type LeaveSettingsVersionProblem =
  | { kind: 'removedKeys'; keys: string[] }
  | { kind: 'goLiveLocked'; goLiveDate: BusinessDate | null };

/**
 * What blocks a new version: a dropped type key, or a changed go-live date once any opening entry
 * exists (decision 306).
 */
export function leaveSettingsVersionProblems(
  previous: Pick<LeaveSettings, 'types' | 'goLiveDate'> | null | undefined,
  next: Pick<LeaveSettings, 'types' | 'goLiveDate'>,
  { openingEntryExists }: { openingEntryExists: boolean },
): LeaveSettingsVersionProblem[] {
  const problems: LeaveSettingsVersionProblem[] = [];
  const keys = removedLeaveTypeKeys(previous, next);
  if (keys.length > 0) problems.push({ kind: 'removedKeys', keys });
  const before = previous?.goLiveDate ?? null;
  if (openingEntryExists && before !== next.goLiveDate) {
    problems.push({ kind: 'goLiveLocked', goLiveDate: before });
  }
  return problems;
}

export function leaveSettingsVersionProblemMessage(problem: LeaveSettingsVersionProblem): string {
  switch (problem.kind) {
    case 'removedKeys':
      return `A leave type can't be removed, only retired: keep ${problem.keys.join(', ')} and set it inactive.`;
    case 'goLiveLocked':
      return 'The go-live date can’t change once an opening balance has been entered.';
  }
}

/** The Leave segment's and the opening balances page's notice while the go-live date is null. */
export const GO_LIVE_DATE_MISSING_MESSAGE = 'Set the go-live date first.';

// ---------------------------------------------------------------------------------------------
// The seeded version (every figure an *Assumption*, items 150–155 and 174–175)

const EVERY_STATUS: LeaveEligibleStatus[] = ['Probationary', 'Regular', 'Contractual'];
/** Statutory leave: ahead with no minimum notice, or after the fact up to the deadline. */
const STATUTORY_FILING: LeaveFiling = { minNoticeDays: null, allowFuture: true, allowPast: true };
const COMPANY_CREDITING: LeaveCrediting = {
  annualCreditOn: '01-01',
  prorateFromRegularization: true,
  carryOverCapDays: null,
};

function statutory(
  type: Pick<LeaveType, 'key' | 'name' | 'shortName' | 'days' | 'countDays' | 'legalBasis'> &
    Partial<LeaveType>,
): LeaveType {
  return {
    active: true,
    paid: true,
    balance: 'perEvent',
    halfDays: false,
    crediting: null,
    eligibility: {
      employmentStatuses: [...EVERY_STATUS],
      sex: null,
      minServiceMonths: null,
      maxRequests: null,
    },
    filing: { ...STATUTORY_FILING },
    attachment: null,
    confidential: false,
    ...type,
  };
}

const female = (extra: Partial<LeaveEligibility> = {}): LeaveEligibility => ({
  employmentStatuses: [...EVERY_STATUS],
  sex: 'female',
  minServiceMonths: null,
  maxRequests: null,
  ...extra,
});

/**
 * `talent.leaveSettings` as `pnpm seed:admin` adds it from 2000-01-01: no go-live date, offset time
 * off from 60 minutes in 30-minute steps, and the ten types of the spec.
 */
export const SEED_LEAVE_SETTINGS: Readonly<LeaveSettings> = Object.freeze<LeaveSettings>({
  goLiveDate: null,
  offsetTimeOff: { minimumMinutes: 60, stepMinutes: 30 },
  types: [
    {
      key: 'vacation',
      name: 'Vacation leave',
      shortName: 'VL',
      active: true,
      paid: true,
      balance: 'credited',
      days: '5',
      countDays: 'workDays',
      halfDays: true,
      crediting: { ...COMPANY_CREDITING },
      eligibility: {
        employmentStatuses: ['Regular'],
        sex: null,
        minServiceMonths: null,
        maxRequests: null,
      },
      filing: { minNoticeDays: 14, allowFuture: true, allowPast: false },
      attachment: null,
      confidential: false,
      legalBasis: null,
    },
    {
      key: 'sick',
      name: 'Sick leave',
      shortName: 'SL',
      active: true,
      paid: true,
      balance: 'credited',
      days: '5',
      countDays: 'workDays',
      halfDays: true,
      crediting: { ...COMPANY_CREDITING },
      eligibility: {
        employmentStatuses: ['Regular'],
        sex: null,
        minServiceMonths: null,
        maxRequests: null,
      },
      filing: { minNoticeDays: null, allowFuture: false, allowPast: true },
      attachment: { label: 'Medical certificate', required: true },
      confidential: false,
      legalBasis: null,
    },
    statutory({
      key: 'maternity',
      name: 'Maternity leave',
      shortName: 'ML',
      days: '105',
      countDays: 'calendarDays',
      eligibility: female(),
      attachment: { label: 'Medical certificate or proof of pregnancy', required: true },
      legalBasis: 'RA 11210',
    }),
    statutory({
      key: 'maternitySoloParent',
      name: 'Maternity leave, solo parent',
      shortName: 'ML-SP',
      days: '120',
      countDays: 'calendarDays',
      eligibility: female(),
      attachment: {
        label: 'Medical certificate or proof of pregnancy, and the Solo Parent ID',
        required: true,
      },
      legalBasis: 'RA 11210',
    }),
    statutory({
      key: 'maternityMiscarriage',
      name: 'Maternity leave, miscarriage or emergency termination',
      shortName: 'ML-M',
      days: '60',
      countDays: 'calendarDays',
      eligibility: female(),
      attachment: { label: 'Medical certificate', required: true },
      legalBasis: 'RA 11210',
    }),
    statutory({
      key: 'maternityExtension',
      name: 'Maternity leave extension, without pay',
      shortName: 'ML-X',
      paid: false,
      days: '30',
      countDays: 'calendarDays',
      eligibility: female(),
      legalBasis: 'RA 11210',
    }),
    statutory({
      key: 'paternity',
      name: 'Paternity leave',
      shortName: 'PL',
      days: '7',
      countDays: 'workDays',
      eligibility: {
        employmentStatuses: [...EVERY_STATUS],
        sex: 'male',
        minServiceMonths: null,
        maxRequests: 4,
      },
      attachment: { label: 'Proof of the delivery', required: false },
      legalBasis: 'RA 8187',
    }),
    statutory({
      key: 'soloParent',
      name: 'Solo parent leave',
      shortName: 'SPL',
      balance: 'perYear',
      days: '7',
      countDays: 'workDays',
      halfDays: true,
      eligibility: {
        employmentStatuses: [...EVERY_STATUS],
        sex: null,
        minServiceMonths: 6,
        maxRequests: null,
      },
      attachment: { label: 'Solo Parent ID', required: true },
      legalBasis: 'RA 11861',
    }),
    statutory({
      key: 'vawc',
      name: 'VAWC leave',
      shortName: 'VAWC',
      balance: 'perYear',
      days: '10',
      countDays: 'workDays',
      halfDays: true,
      eligibility: female(),
      attachment: {
        label: 'Barangay, police, prosecutor or court certification',
        required: true,
      },
      confidential: true,
      legalBasis: 'RA 9262',
    }),
    statutory({
      key: 'specialLeaveWomen',
      name: 'Special leave for women',
      shortName: 'SLW',
      days: '60',
      countDays: 'calendarDays',
      eligibility: female({ minServiceMonths: 6 }),
      attachment: { label: 'Medical certificate', required: true },
      legalBasis: 'RA 9710',
    }),
  ],
});
