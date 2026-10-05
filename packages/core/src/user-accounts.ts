import { z } from 'zod';
import {
  EMPLOYMENT_STATUS,
  EMPLOYMENT_STATUSES,
  emailDomainOf,
  type EmploymentStatus,
  normalizeEmail,
} from './account';
import { OBJECT_ID_PATTERN } from './audit';
import {
  addDays,
  type BusinessDate,
  businessToday,
  compareBusinessDates,
  formatDate,
  isBusinessDate,
} from './dates';
import { EMPLOYEE_NUMBER_PATTERN } from './employee-number';
import { businessDateField } from './validation';

// Spec: docs/modules/core.md#managing-user-accounts and SECURITY.md#account-status — the user
// sheet on `/admin/users`: creating a user, editing one, and changing the employment status. Pure
// code, safe in the browser, so the sheet and the user service check the same rules. The service
// (`@pulse/core/server`) checks what needs the database or the record: allowed email domains,
// duplicates, the employee number's year and use, live departments and positions, reporting
// lines, the date hired staying within the number's year, and the separation date not being
// before the date hired.

/** The longest first, middle or last name. */
export const EMPLOYEE_NAME_MAX_LENGTH = 100;

// Spec: docs/modules/core.md#managing-user-accounts — the date hired runs from 1990-01-01 to a
// year ahead (today + 365 days in Manila).
export const DATE_HIRED_EARLIEST: BusinessDate = '1990-01-01';
export const DATE_HIRED_DAYS_AHEAD = 365;

/** The dates a date hired may take, both inclusive, from Manila's `today`. */
export function dateHiredRange(today: BusinessDate = businessToday()): {
  earliest: BusinessDate;
  latest: BusinessDate;
} {
  return { earliest: DATE_HIRED_EARLIEST, latest: addDays(today, DATE_HIRED_DAYS_AHEAD) };
}

// Spec: SECURITY.md#account-status — the employment statuses on the sheet.

/** A new user starts in one of these. */
export const HIRE_EMPLOYMENT_STATUSES = [
  'Probationary',
  'Regular',
  'Contractual',
] as const satisfies readonly EmploymentStatus[];
export type HireEmploymentStatus = (typeof HIRE_EMPLOYMENT_STATUSES)[number];

/** Refusal and hint for Terminated, until termination due process is built (Phase 2). */
export const TERMINATED_UNAVAILABLE =
  'Terminated is available once termination due process is built (Phase 2). Use Resigned or Retired, or wait.';
/** A separation date later than today in Manila. */
export const SEPARATION_IN_FUTURE = 'Set this on the separation date.';
/** A separation date before the date hired (checked by the service and the employee schema). */
export const SEPARATION_BEFORE_HIRE = 'The separation date can’t be before the date hired.';

/** True for Resigned, Terminated and Retired: the account is deactivated. */
export function isSeparatedStatus(status: EmploymentStatus): boolean {
  return EMPLOYMENT_STATUS[status] === 'deactivated';
}

export interface EmploymentStatusOption {
  value: EmploymentStatus;
  /** Shown disabled, with `hint` under it. */
  disabled: boolean;
  hint: string | null;
  /** A separation date goes with it. */
  needsSeparationDate: boolean;
}

/** The employment status choices when changing a status, in `EMPLOYMENT_STATUS` order. */
export const EMPLOYMENT_STATUS_OPTIONS: readonly EmploymentStatusOption[] = EMPLOYMENT_STATUSES.map(
  (value) => ({
    value,
    disabled: value === 'Terminated',
    hint: value === 'Terminated' ? TERMINATED_UNAVAILABLE : null,
    needsSeparationDate: isSeparatedStatus(value),
  }),
);

// ---------------------------------------------------------------------------------------------
// Fields

function nameField(label: string) {
  return z
    .string({ error: `Enter the ${label}.` })
    .trim()
    .min(1, `Enter the ${label}.`)
    .max(EMPLOYEE_NAME_MAX_LENGTH, `Use ${EMPLOYEE_NAME_MAX_LENGTH} characters or fewer.`);
}

// Optional: an empty value means none.
const middleName = z
  .string()
  .trim()
  .max(EMPLOYEE_NAME_MAX_LENGTH, `Use ${EMPLOYEE_NAME_MAX_LENGTH} characters or fewer.`)
  .nullable()
  .optional()
  .transform((value) => (value ? value : null));

const email = z
  .string({ error: 'Enter the login email.' })
  .trim()
  .min(1, 'Enter the login email.')
  .refine((value) => emailDomainOf(value) !== null, { message: 'Enter a valid email address.' })
  .transform(normalizeEmail);

const dateHired = businessDateField('Enter the date hired.').superRefine((value, ctx) => {
  // Zod runs every check, so this one sees a value the "real date" check already refused.
  if (!isBusinessDate(value)) return;
  const { earliest, latest } = dateHiredRange();
  if (compareBusinessDates(value, earliest) < 0 || compareBusinessDates(value, latest) > 0) {
    ctx.addIssue({
      code: 'custom',
      message: `Enter a date from ${formatDate(earliest)} to ${formatDate(latest)}.`,
    });
  }
});

const departmentId = z
  .string({ error: 'Choose a department.' })
  .regex(OBJECT_ID_PATTERN, 'Choose a department.');

const positionId = z
  .string({ error: 'Choose a position.' })
  .regex(OBJECT_ID_PATTERN, 'Choose a position.');

// Spec: docs/modules/core.md#reporting-lines — the supervisor limit, and the hint the sheet shows
// when a non-Board employee is saved with no supervisor.

/** The most supervisors one employee can have. */
export const MAX_SUPERVISORS = 10;
/** Shown under the supervisors field when a non-Board employee has none. */
export const NO_SUPERVISOR_HINT = 'No supervisor: leave and offset time off go to HR.';

// The shape only. The limits (not self, at most 10, no repeats, active, no cycles) need the
// records, so the user service checks them (docs/modules/core.md#reporting-lines).
const reportingTo = z
  .array(z.string().regex(OBJECT_ID_PATTERN, 'Choose each supervisor from the list.'), {
    error: 'Choose each supervisor from the list.',
  })
  .default([]);

const identityFields = {
  email,
  firstName: nameField('first name'),
  middleName,
  lastName: nameField('last name'),
  dateHired,
  departmentId,
  positionId,
  reportingTo,
};

// Each *Input type is what a service takes: the form's values as sent (the service parses them
// again with the same schema).

/**
 * Creating a user. The employee number is generated, or entered when the person already has a
 * company ID (`employeeNumber` is null when generated).
 */
export const userCreateSchema = z
  .object({
    ...identityFields,
    employeeNumberMode: z.enum(['generate', 'existing'], {
      error: 'Choose Generate or Enter existing.',
    }),
    employeeNumber: z.string().trim().nullable().optional(),
    employmentStatus: z.enum(HIRE_EMPLOYMENT_STATUSES, {
      error: 'Choose Probationary, Regular or Contractual.',
    }),
  })
  .superRefine((value, ctx) => {
    if (value.employeeNumberMode !== 'existing') return;
    if (!value.employeeNumber) {
      ctx.addIssue({
        code: 'custom',
        path: ['employeeNumber'],
        message: 'Enter the employee number.',
      });
    } else if (!EMPLOYEE_NUMBER_PATTERN.test(value.employeeNumber)) {
      ctx.addIssue({
        code: 'custom',
        path: ['employeeNumber'],
        message: 'Enter the employee number as YYYY-NN, for example 2027-01.',
      });
    }
  })
  .transform((value) => ({
    ...value,
    employeeNumber: value.employeeNumberMode === 'existing' ? (value.employeeNumber ?? null) : null,
  }));
export type UserCreateInput = z.input<typeof userCreateSchema>;
export type UserCreateValues = z.output<typeof userCreateSchema>;

/**
 * Editing a user: name, email, department, position, reporting lines and date hired. The employee
 * number is fixed; the employment status changes through {@link employmentStatusChangeSchema}.
 */
export const userUpdateSchema = z.object(identityFields);
export type UserUpdateInput = z.input<typeof userUpdateSchema>;
export type UserUpdateValues = z.output<typeof userUpdateSchema>;

/**
 * Changing the employment status. A separated status needs a separation date, today or earlier in
 * Manila; an active status clears it (`separationDate` is null). Terminated is refused until
 * termination due process is built.
 */
export const employmentStatusChangeSchema = z
  .object({
    employmentStatus: z.enum(EMPLOYMENT_STATUSES as [EmploymentStatus, ...EmploymentStatus[]], {
      error: 'Choose an employment status.',
    }),
    separationDate: z.string().trim().nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.employmentStatus === 'Terminated') {
      ctx.addIssue({ code: 'custom', path: ['employmentStatus'], message: TERMINATED_UNAVAILABLE });
      return;
    }
    if (!isSeparatedStatus(value.employmentStatus)) return;
    const date = value.separationDate;
    if (!date) {
      ctx.addIssue({
        code: 'custom',
        path: ['separationDate'],
        message: 'Enter the separation date.',
      });
    } else if (!isBusinessDate(date)) {
      ctx.addIssue({ code: 'custom', path: ['separationDate'], message: 'Enter a real date.' });
    } else if (compareBusinessDates(date, businessToday()) > 0) {
      ctx.addIssue({ code: 'custom', path: ['separationDate'], message: SEPARATION_IN_FUTURE });
    }
  })
  .transform((value) => ({
    employmentStatus: value.employmentStatus,
    separationDate: isSeparatedStatus(value.employmentStatus)
      ? (value.separationDate as BusinessDate)
      : null,
  }));
export type EmploymentStatusChangeInput = z.input<typeof employmentStatusChangeSchema>;
export type EmploymentStatusChangeValues = z.output<typeof employmentStatusChangeSchema>;
