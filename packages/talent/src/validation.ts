import { z } from 'zod';
import { businessDateField, isBusinessDate, OBJECT_ID_PATTERN, pesoField } from '@pulse/core';
import {
  CIVIL_STATUSES,
  DOCUMENT_201_TYPES,
  PAYROLL_BANKS,
  RATE_TYPES,
  SEXES,
  WORK_REGIONS,
} from './fixed-sets';
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
/** The refusal when the employee is gone. */
export const EMPLOYEE_GONE = 'This employee no longer exists. Reload the page.';
/** Step 2.2 refusals for a 201 document or certification that changed or went away. */
export const DOCUMENT_GONE = 'This document no longer exists. Reload the page.';
export const DOCUMENT_ARCHIVED =
  'This document is archived, so it can’t be changed. Reload the page.';
export const REPLACED_DOCUMENT_GONE =
  'The document this one replaces no longer exists. Reload the page.';
export const REPLACED_DOCUMENT_ARCHIVED =
  'The document this one replaces is already archived. Reload the page.';
export const CERTIFICATION_GONE = 'This certification no longer exists. Reload the page.';
/**
 * The form errors that mean the sheet's data is out of date: the sheets offer Reload for these
 * (and only these) instead of the plain error.
 */
export const STALE_FORM_MESSAGES: readonly string[] = [
  RECORD_CHANGED_ELSEWHERE,
  EMPLOYEE_GONE,
  DOCUMENT_GONE,
  DOCUMENT_ARCHIVED,
  REPLACED_DOCUMENT_GONE,
  REPLACED_DOCUMENT_ARCHIVED,
  CERTIFICATION_GONE,
];
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

// ---------------------------------------------------------------------------------------------
// Step 2.2: 201 documents, certifications, skills and the expiry alert setting
// (docs/modules/talent.md#documents-photo-e-signature-and-certifications-build-step-22,
// docs/DATA_MODEL.md#collection-ownership, decisions 178–187 in docs/BUILD_PLAN.md).

/** The line shown instead of the 201 file to anyone who may not see it (decision 179). */
export const DOCUMENTS_NOTICE =
  '201 file documents are visible to HR, Accounting and the System Administrator.';
/** The line Accounting gets instead of medical certificates (decision 179). */
export const MEDICAL_DOCUMENTS_NOTICE =
  'Medical certificates are visible to HR and the System Administrator.';

export const DOCUMENT_TITLE_MAX_LENGTH = 200;
export const ARCHIVE_REASON_MAX_LENGTH = 500;
export const CERTIFICATION_NAME_MAX_LENGTH = 200;
export const CERTIFICATION_ISSUER_MAX_LENGTH = 200;
export const LICENSE_NUMBER_MAX_LENGTH = 100;
export const SKILLS_MAX_COUNT = 30;
export const SKILL_MAX_LENGTH = 50;
/** The expiry alert lead days (`talent.expiryAlerts`): 1 to 180, 30 until a version is added. */
export const EXPIRY_LEAD_DAYS_MIN = 1;
export const EXPIRY_LEAD_DAYS_MAX = 180;
export const DEFAULT_EXPIRY_LEAD_DAYS = 30;

const RELOAD = 'Reload the page and try again.';

/** A record id the form sends back (a document, a certification). */
function recordIdField(message = RELOAD) {
  return z.string({ error: message }).regex(OBJECT_ID_PATTERN, message);
}

/** An optional record id: empty is null. */
function nullableRecordId(message: string) {
  return z.preprocess(blankToNull, z.string().regex(OBJECT_ID_PATTERN, message).nullable());
}

/** Required text: trimmed, 1 to `max` characters. */
function requiredText(max: number, missing: string) {
  return z.preprocess(
    (value) => (typeof value === 'string' ? value.trim() : value),
    z.string({ error: missing }).min(1, missing).max(max, `Use at most ${max} characters.`),
  );
}

/** A stored record's `version` the form loaded: 1 or more. */
const storedVersionField = z.coerce.number({ error: RELOAD }).int(RELOAD).min(1, RELOAD);

/** The issue date and an optional expiry date after it. */
const datesShape = {
  issueDate: businessDateField('Enter the issue date.'),
  expiryDate: nullableDate(),
};

function checkExpiryAfterIssue(
  value: { issueDate: string; expiryDate: string | null },
  ctx: z.RefinementCtx,
): void {
  if (value.expiryDate !== null && value.expiryDate <= value.issueDate) {
    ctx.addIssue({
      code: 'custom',
      path: ['expiryDate'],
      message: 'The expiry date must be after the issue date.',
    });
  }
}

/** A 201 document's details: "Other" needs a title. */
const documentDetailsShape = {
  type: z.enum(DOCUMENT_201_TYPES, { error: 'Choose a document type from the list.' }),
  title: nullableText(
    DOCUMENT_TITLE_MAX_LENGTH,
    `Use at most ${DOCUMENT_TITLE_MAX_LENGTH} characters.`,
  ),
  ...datesShape,
};

function checkDocumentDetails(
  value: { type: string; title: string | null; issueDate: string; expiryDate: string | null },
  ctx: z.RefinementCtx,
): void {
  if (value.type === 'other' && !value.title) {
    ctx.addIssue({ code: 'custom', path: ['title'], message: 'Enter a title for this document.' });
  }
  checkExpiryAfterIssue(value, ctx);
}

/**
 * The 201 document upload sheet (the file comes separately, field `file`). `replacesDocumentId`
 * and `replacesVersion` archive the document this renewal replaces, in the same save.
 */
export const employeeDocumentAddSchema = z
  .object({
    employeeId: employeeIdField,
    ...documentDetailsShape,
    replacesDocumentId: nullableRecordId('Choose the document this one replaces.').optional(),
    replacesVersion: z.preprocess(
      (value) => (value === '' || value === null ? undefined : value),
      storedVersionField.optional(),
    ),
  })
  .superRefine((value, ctx) => {
    checkDocumentDetails(value, ctx);
    if (value.replacesDocumentId && value.replacesVersion === undefined) {
      ctx.addIssue({ code: 'custom', path: ['replacesVersion'], message: RELOAD });
    }
  });
export type EmployeeDocumentAddInput = z.output<typeof employeeDocumentAddSchema>;

/** The 201 document Edit sheet: the details only, never the file. */
export const employeeDocumentUpdateSchema = z
  .object({
    documentId: recordIdField(),
    version: storedVersionField,
    ...documentDetailsShape,
  })
  .superRefine(checkDocumentDetails);
export type EmployeeDocumentUpdateInput = z.output<typeof employeeDocumentUpdateSchema>;

/** Archiving a 201 document needs a reason. */
export const employeeDocumentArchiveSchema = z.object({
  documentId: recordIdField(),
  version: storedVersionField,
  reason: requiredText(ARCHIVE_REASON_MAX_LENGTH, 'Enter the reason for archiving.'),
});
export type EmployeeDocumentArchiveInput = z.output<typeof employeeDocumentArchiveSchema>;

const certificationDetailsShape = {
  name: requiredText(CERTIFICATION_NAME_MAX_LENGTH, 'Enter the certification name.'),
  issuer: requiredText(CERTIFICATION_ISSUER_MAX_LENGTH, 'Enter who issued it.'),
  brandId: nullableRecordId('Choose a product from the list.'),
  licenseNumber: nullableText(
    LICENSE_NUMBER_MAX_LENGTH,
    `Use at most ${LICENSE_NUMBER_MAX_LENGTH} characters.`,
  ),
  ...datesShape,
};

/** The Add certification sheet (the optional attachment comes separately, field `attachment`). */
export const certificationCreateSchema = z
  .object({ employeeId: employeeIdField, ...certificationDetailsShape })
  .superRefine(checkExpiryAfterIssue);
export type CertificationCreateInput = z.output<typeof certificationCreateSchema>;

/**
 * The Edit certification sheet. A new attachment (field `attachment`) replaces the old one;
 * `removeAttachment` clears it.
 */
export const certificationUpdateSchema = z
  .object({
    certificationId: recordIdField(),
    version: storedVersionField,
    ...certificationDetailsShape,
    removeAttachment: checkbox,
  })
  .superRefine(checkExpiryAfterIssue);
export type CertificationUpdateInput = z.output<typeof certificationUpdateSchema>;

/** Removing a certification (a soft delete). */
export const certificationRemoveSchema = z.object({
  certificationId: recordIdField(),
  version: storedVersionField,
});
export type CertificationRemoveInput = z.output<typeof certificationRemoveSchema>;

/**
 * Skills as typed: an array of tags, or one text with a tag per line or comma. Each is trimmed and
 * empty ones are dropped.
 */
function splitSkills(value: unknown): unknown {
  let parts: unknown = value;
  if (typeof value === 'string') parts = value.split(/[\n,]/);
  if (!Array.isArray(parts)) return parts;
  return parts
    .map((part: unknown) => (typeof part === 'string' ? part.trim() : part))
    .filter((part: unknown) => part !== '');
}

/** The skills tags: up to 30, of up to 50 characters each, no duplicates ignoring case. */
export const skillsField = z.preprocess(
  splitSkills,
  z
    .array(
      z
        .string()
        .max(SKILL_MAX_LENGTH, `Keep each skill to ${SKILL_MAX_LENGTH} characters or fewer.`),
      { error: 'Enter the skills.' },
    )
    .max(SKILLS_MAX_COUNT, `Add at most ${SKILLS_MAX_COUNT} skills.`)
    .superRefine((skills, ctx) => {
      const seen = new Set<string>();
      for (const skill of skills) {
        const key = skill.toLocaleLowerCase('en');
        if (seen.has(key)) {
          ctx.addIssue({ code: 'custom', message: 'Each skill can be listed only once.' });
          return;
        }
        seen.add(key);
      }
    }),
);

/** The Skills Edit sheet, saved like a section with the record's `version`. */
export const skillsSectionSchema = z.object({
  employeeId: employeeIdField,
  version: recordVersionField,
  skills: skillsField,
});
export type SkillsSectionInput = z.output<typeof skillsSectionSchema>;

const leadDaysField = (missing: string) =>
  z.coerce
    .number({ error: missing })
    .int('Enter a whole number of days.')
    .min(EXPIRY_LEAD_DAYS_MIN, `Enter ${EXPIRY_LEAD_DAYS_MIN} to ${EXPIRY_LEAD_DAYS_MAX} days.`)
    .max(EXPIRY_LEAD_DAYS_MAX, `Enter ${EXPIRY_LEAD_DAYS_MIN} to ${EXPIRY_LEAD_DAYS_MAX} days.`);

/** The `talent.expiryAlerts` setting's value, and its Settings sheet. */
export const expiryAlertSettingsSchema = z.object({
  documentLeadDays: leadDaysField('Enter the days before a 201 document expires.'),
  certificationLeadDays: leadDaysField('Enter the days before a certification expires.'),
});
export type ExpiryAlertSettingsInput = z.output<typeof expiryAlertSettingsSchema>;
