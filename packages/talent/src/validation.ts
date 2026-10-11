import { z } from 'zod';
import { businessDateField, isBusinessDate, OBJECT_ID_PATTERN, pesoField } from '@pulse/core';
import { CIVIL_STATUSES, PAYROLL_BANKS, RATE_TYPES, SEXES, WORK_REGIONS } from './fixed-sets';
import {
  isBankAccountNumber,
  isMobileNumber,
  isPagibigMid,
  isPhilhealthPin,
  isRdoCode,
  isSssNumber,
  isTin,
  normalizeDigits,
} from './formats';

// Spec: docs/modules/talent.md#the-employee-record-build-step-21 (decisions 159–165 in
// docs/BUILD_PLAN.md) — the employee record's forms, one per section. Pure code, safe in the
// browser: the Edit sheets and the Server Actions parse with the same schemas, and the services
// parse their input again with them.
//
// Each schema reads what FormData sends (strings, a checkbox's "on") and is idempotent: parsing
// its own output again gives the same output, so a service can re-check what an action passes.
//
// - Plain text fields are trimmed, and an empty one is null.
// - A sensitive input (an ID, the account number) is never filled in with the stored value: empty
//   or absent means "keep the stored value", so it parses to undefined. A stored ID or account
//   number can be replaced but not cleared.
// - The date of birth and civil status are optional keys: absent means "keep" (the form of a
//   viewer who isn't sent them doesn't have them), empty clears them.

/** The stale-form refusal (decision 164). */
export const RECORD_CHANGED_ELSEWHERE = 'Someone else changed this record. Reload to see it.';
/** The line shown instead of the sections a viewer may not see (decision 158). */
export const RESTRICTED_SECTIONS_NOTICE =
  'Pay, government IDs and bank details are visible to HR, Accounting and the System Administrator.';

export const NATIONALITY_MAX_LENGTH = 100;
export const ADDRESS_MAX_LENGTH = 500;
export const PERSONAL_EMAIL_MAX_LENGTH = 320;
export const EMERGENCY_CONTACT_NAME_MAX_LENGTH = 200;
export const EMERGENCY_CONTACT_RELATIONSHIP_MAX_LENGTH = 100;
export const SEPARATION_REMARKS_MAX_LENGTH = 1000;
export const ACCOUNT_NAME_MAX_LENGTH = 200;
export const COMPENSATION_REASON_MAX_LENGTH = 1000;

const blankToNull = (value: unknown) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

const blankToUndefined = (value: unknown) =>
  value === null || (typeof value === 'string' && value.trim() === '') ? undefined : value;

/** Optional text: trimmed, empty is null. */
function nullableText(max: number, tooLong: string) {
  return z.preprocess(blankToNull, z.string().max(max, tooLong).nullable());
}

/** An optional choice from a fixed set: empty is null. */
function nullableChoice<T extends readonly [string, ...string[]]>(values: T, message: string) {
  return z.preprocess(blankToNull, z.enum(values, { error: message }).nullable());
}

/** An optional Manila day: empty is null. */
function nullableDate(message = 'Enter a real date.') {
  return z.preprocess(blankToNull, z.string().refine(isBusinessDate, { message }).nullable());
}

/** An optional mobile number: spaces and dashes removed, empty is null. */
function nullableMobile() {
  return z.preprocess(
    (value) => {
      const text = blankToNull(value);
      return typeof text === 'string' ? normalizeDigits(text) : text;
    },
    z
      .string()
      .refine(isMobileNumber, { message: 'Enter 11 digits starting with 09, like 0917 123 4567.' })
      .nullable(),
  );
}

/**
 * A sensitive digit string (an ID, the account number): spaces and dashes removed, and empty or
 * absent is undefined ("keep the stored value"). The message never repeats what was typed.
 */
function sensitiveDigits(check: (value: string) => boolean, message: string) {
  return z.preprocess((value) => {
    const kept = blankToUndefined(value);
    return typeof kept === 'string' ? normalizeDigits(kept) : kept;
  }, z.string().refine(check, { message }).optional());
}

/** A checkbox: "on" or "true" is true; absent, empty or "false" is false. */
const checkbox = z.preprocess((value) => {
  if (value === 'on' || value === 'true') return true;
  if (value === undefined || value === null || value === '' || value === 'false') return false;
  return value;
}, z.boolean());

export const employeeIdField = z
  .string({ error: 'Choose an employee.' })
  .regex(OBJECT_ID_PATTERN, 'Choose an employee.');

/** The record's `version` the form loaded: 0 while there is no record yet. */
export const recordVersionField = z.coerce
  .number({ error: 'Reload the page and try again.' })
  .int('Reload the page and try again.')
  .min(0, 'Reload the page and try again.');

/** The Personal section's Edit sheet. */
export const personalSectionSchema = z.object({
  employeeId: employeeIdField,
  version: recordVersionField,
  /** Only HR, the System Administrator (and in step 2.6 the employee's change request) send it. */
  dateOfBirth: z.preprocess(
    (value) => (value === undefined ? undefined : blankToNull(value)),
    z.string().refine(isBusinessDate, { message: 'Enter a real date.' }).nullable().optional(),
  ),
  sex: nullableChoice(SEXES, 'Choose male or female.'),
  /** Only HR and the System Administrator send it. */
  civilStatus: z.preprocess(
    (value) => (value === undefined ? undefined : blankToNull(value)),
    z.enum(CIVIL_STATUSES, { error: 'Choose a civil status from the list.' }).nullable().optional(),
  ),
  nationality: nullableText(
    NATIONALITY_MAX_LENGTH,
    `Use at most ${NATIONALITY_MAX_LENGTH} characters.`,
  ),
  presentAddress: nullableText(ADDRESS_MAX_LENGTH, `Use at most ${ADDRESS_MAX_LENGTH} characters.`),
  permanentAddress: nullableText(
    ADDRESS_MAX_LENGTH,
    `Use at most ${ADDRESS_MAX_LENGTH} characters.`,
  ),
  mobileNumber: nullableMobile(),
  personalEmail: z.preprocess(
    (value) => {
      const text = blankToNull(value);
      return typeof text === 'string' ? text.toLowerCase() : text;
    },
    z
      .email({ error: 'Enter an email address, like name@example.com.' })
      .max(PERSONAL_EMAIL_MAX_LENGTH, 'Enter a shorter email address.')
      .nullable(),
  ),
  emergencyContactName: nullableText(
    EMERGENCY_CONTACT_NAME_MAX_LENGTH,
    `Use at most ${EMERGENCY_CONTACT_NAME_MAX_LENGTH} characters.`,
  ),
  emergencyContactRelationship: nullableText(
    EMERGENCY_CONTACT_RELATIONSHIP_MAX_LENGTH,
    `Use at most ${EMERGENCY_CONTACT_RELATIONSHIP_MAX_LENGTH} characters.`,
  ),
  emergencyContactMobile: nullableMobile(),
});
export type PersonalSectionInput = z.output<typeof personalSectionSchema>;

/** The Employment section's Edit sheet (Talent's own employment fields). */
export const employmentSectionSchema = z.object({
  employeeId: employeeIdField,
  version: recordVersionField,
  workRegion: z.enum(WORK_REGIONS, { error: 'Choose a region from the list.' }),
  contractEndDate: nullableDate(),
  regularizationDate: nullableDate(),
  separationRemarks: nullableText(
    SEPARATION_REMARKS_MAX_LENGTH,
    `Use at most ${SEPARATION_REMARKS_MAX_LENGTH} characters.`,
  ),
});
export type EmploymentSectionInput = z.output<typeof employmentSectionSchema>;

/** The Government IDs section's Edit sheet. An empty ID keeps the stored one. */
export const governmentIdsSectionSchema = z.object({
  employeeId: employeeIdField,
  version: recordVersionField,
  tin: sensitiveDigits(isTin, 'Enter the TIN’s 9, 12 or 14 digits.'),
  rdoCode: z.preprocess(
    (value) => {
      const text = blankToNull(value);
      return typeof text === 'string' ? normalizeDigits(text) : text;
    },
    z.string().refine(isRdoCode, { message: 'Enter the 3-digit RDO code.' }).nullable(),
  ),
  sss: sensitiveDigits(isSssNumber, 'Enter the SSS number’s 10 digits.'),
  philhealth: sensitiveDigits(isPhilhealthPin, 'Enter the PhilHealth PIN’s 12 digits.'),
  pagibig: sensitiveDigits(isPagibigMid, 'Enter the Pag-IBIG MID’s 12 digits.'),
});
export type GovernmentIdsSectionInput = z.output<typeof governmentIdsSectionSchema>;

/** The Payroll bank account section's Edit sheet. An empty account number keeps the stored one. */
export const bankAccountSectionSchema = z.object({
  employeeId: employeeIdField,
  version: recordVersionField,
  bank: z.enum(PAYROLL_BANKS, { error: 'Choose UnionBank or RCBC.' }),
  accountNumber: sensitiveDigits(
    isBankAccountNumber,
    'Enter the account number’s 10 to 16 digits.',
  ),
  accountName: z.preprocess(
    (value) => (typeof value === 'string' ? value.trim() : value),
    z
      .string({ error: 'Enter the account name.' })
      .min(1, 'Enter the account name.')
      .max(ACCOUNT_NAME_MAX_LENGTH, `Use at most ${ACCOUNT_NAME_MAX_LENGTH} characters.`),
  ),
});
export type BankAccountSectionInput = z.output<typeof bankAccountSectionSchema>;

const reasonField = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim() : value),
  z
    .string({ error: 'Enter the reason for this change.' })
    .min(1, 'Enter the reason for this change.')
    .max(
      COMPENSATION_REASON_MAX_LENGTH,
      `Use at most ${COMPENSATION_REASON_MAX_LENGTH} characters.`,
    ),
);

/**
 * A new compensation entry, as the service takes it: the basic salary already in whole centavos.
 * The "Add salary change" form parses with {@link compensationEntryFormSchema}, which gives this.
 */
export const compensationEntrySchema = z.object({
  employeeId: employeeIdField,
  effectiveDate: businessDateField('Enter the effective date.'),
  basicSalaryCentavos: z
    .number({ error: 'Enter the basic salary.' })
    .int('Enter the basic salary in pesos and centavos.')
    .positive('Enter a basic salary above zero.')
    .max(Number.MAX_SAFE_INTEGER, 'The amount is too large.'),
  rateType: z.enum(RATE_TYPES, { error: 'Choose monthly-rated or daily-rated.' }),
  minimumWageEarner: checkbox,
  reason: reasonField,
});
export type CompensationEntryInput = z.output<typeof compensationEntrySchema>;

/**
 * The "Add salary change" form: the basic salary is typed in pesos with up to 2 decimals and
 * parsed to whole centavos without floating point (`pesoField`), then the result is shaped like
 * {@link compensationEntrySchema}. Field errors on the amount come back under `basicSalary`.
 */
export const compensationEntryFormSchema = z
  .object({
    employeeId: employeeIdField,
    effectiveDate: businessDateField('Enter the effective date.'),
    basicSalary: pesoField({ requiredMessage: 'Enter the basic salary.' }).refine(
      (centavos) => centavos > 0,
      { message: 'Enter a basic salary above zero.' },
    ),
    rateType: z.enum(RATE_TYPES, { error: 'Choose monthly-rated or daily-rated.' }),
    minimumWageEarner: checkbox,
    reason: reasonField,
  })
  .transform(({ basicSalary, ...rest }): CompensationEntryInput => ({
    ...rest,
    basicSalaryCentavos: basicSalary,
  }));
