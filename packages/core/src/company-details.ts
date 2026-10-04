import { z } from 'zod';
import { EMAIL_DOMAIN_PATTERN } from './account';
import { isPlaceholder } from './placeholder';
import { UPLOAD_TYPE_NAMES } from './server/files/file-types';

// Spec: docs/modules/core.md#company-settings-page and
// docs/modules/core.md#company-details-pending-from-the-client — the company details the System
// Administrator fills in, which of them are still placeholders, and the input rules for the
// company settings page (details, allowed email domains, upload settings). Pure code: safe on the
// server and in the browser. `file-types.ts` is imported for its type names only; it has no
// server dependencies.

/** One company detail: its path on the company settings record and its label. */
export interface CompanyDetailField {
  /** The dotted path on the settings record, for example `birRegistration.invoiceSeries`. */
  path: string;
  label: string;
}

/** The text details, in the order the settings page shows them. */
export const COMPANY_DETAIL_FIELDS = [
  { path: 'registeredName', label: 'Registered company name' },
  { path: 'businessAddress', label: 'Business address' },
  { path: 'tin', label: 'Company TIN' },
  { path: 'rdoCode', label: 'RDO code' },
  { path: 'sssEmployerNumber', label: 'SSS employer number' },
  { path: 'philhealthEmployerNumber', label: 'PhilHealth employer number' },
  { path: 'pagibigEmployerId', label: 'Pag-IBIG employer ID' },
  {
    path: 'birRegistration.casPermitDetails',
    label: 'BIR CAS/CBA acknowledgment or permit details',
  },
  { path: 'birRegistration.invoiceSeries', label: 'BIR registered invoice number series' },
] as const satisfies readonly CompanyDetailField[];

export type CompanyDetailPath = (typeof COMPANY_DETAIL_FIELDS)[number]['path'];

/** The logo counts as a company detail: it is pending while no logo is uploaded. */
export const COMPANY_LOGO_DETAIL = {
  path: 'logoFileId',
  label: 'Company logo',
} as const satisfies CompanyDetailField;

/** What `pendingCompanyDetails` reads from the settings record (lean or a view). */
export interface CompanyDetailsSource {
  registeredName: string;
  businessAddress: string;
  tin: string;
  rdoCode: string;
  sssEmployerNumber: string;
  philhealthEmployerNumber: string;
  pagibigEmployerId: string;
  birRegistration: { casPermitDetails: string; invoiceSeries: string } | null;
  /** An id (ObjectId or string), or null while no logo is uploaded. */
  logoFileId: unknown;
}

function valueAt(settings: CompanyDetailsSource, path: CompanyDetailPath): unknown {
  let value: unknown = settings;
  for (const key of path.split('.')) {
    value =
      typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : null;
  }
  return value;
}

/**
 * The details still pending, in page order, the logo last: every text detail that is still a
 * marked placeholder (or missing or blank), and the logo while `logoFileId` is null. Empty once
 * everything is filled in.
 */
export function pendingCompanyDetails(settings: CompanyDetailsSource): CompanyDetailField[] {
  const pending: CompanyDetailField[] = [];
  for (const field of COMPANY_DETAIL_FIELDS) {
    const value = valueAt(settings, field.path);
    if (typeof value !== 'string' || value.trim() === '' || isPlaceholder(value)) {
      pending.push({ path: field.path, label: field.label });
    }
  }
  if (settings.logoFileId === null || settings.logoFileId === undefined) {
    pending.push({ ...COMPANY_LOGO_DETAIL });
  }
  return pending;
}

/** The longest company detail, as on the settings record. */
export const COMPANY_DETAIL_MAX_LENGTH = 500;

const detailField = (label: string) =>
  z
    .string({ error: `Enter the ${label}.` })
    .trim()
    .min(1, `Enter the ${label}.`)
    .max(
      COMPANY_DETAIL_MAX_LENGTH,
      `Keep the ${label} to ${COMPANY_DETAIL_MAX_LENGTH} characters.`,
    );

/**
 * The company details form. A detail may still hold its placeholder; it then stays pending. Field
 * errors use the dotted paths (`birRegistration.invoiceSeries`).
 */
export const companyDetailsSchema = z.object({
  registeredName: detailField('registered company name'),
  businessAddress: detailField('business address'),
  tin: detailField('company TIN'),
  rdoCode: detailField('RDO code'),
  sssEmployerNumber: detailField('SSS employer number'),
  philhealthEmployerNumber: detailField('PhilHealth employer number'),
  pagibigEmployerId: detailField('Pag-IBIG employer ID'),
  birRegistration: z.object({
    casPermitDetails: detailField('CAS/CBA acknowledgment or permit details'),
    invoiceSeries: detailField('registered invoice number series'),
  }),
});

export type CompanyDetailsFormInput = z.input<typeof companyDetailsSchema>;
export type CompanyDetailsValues = z.output<typeof companyDetailsSchema>;

/** Adding an allowed email domain: lowercase, without the `@` (a leading `@` is dropped). */
export const emailDomainSchema = z.object({
  domain: z
    .string({ error: 'Enter a domain such as xtreme-works.com.' })
    .trim()
    .toLowerCase()
    .transform((value) => value.replace(/^@/, ''))
    .pipe(
      z
        .string()
        .min(1, 'Enter a domain such as xtreme-works.com.')
        .max(253, 'A domain is at most 253 characters.')
        .regex(EMAIL_DOMAIN_PATTERN, 'Enter a domain such as xtreme-works.com, without the @.'),
    ),
});

export type EmailDomainInput = z.input<typeof emailDomainSchema>;

/**
 * The largest upload size the setting can hold, in megabytes: the Server Action body limit in
 * apps/web/next.config.ts (`serverActions.bodySizeLimit`, 25 MB). `UPLOAD_REQUEST_LIMIT_BYTES` in
 * the storage service is built from it.
 */
export const UPLOAD_SIZE_MAX_MEGABYTES = 25;

/**
 * The upload settings form: the maximum size in whole megabytes and at least one allowed type. A
 * single checked type (one FormData value) is read as a list of one.
 */
export const fileUploadSettingsInputSchema = z.object({
  maxSizeMegabytes: z.coerce
    .number({ error: 'Enter the maximum upload size in MB.' })
    .int('Enter a whole number of MB.')
    .min(1, 'The maximum upload size is at least 1 MB.')
    .max(
      UPLOAD_SIZE_MAX_MEGABYTES,
      `The maximum upload size is at most ${UPLOAD_SIZE_MAX_MEGABYTES} MB.`,
    ),
  allowedTypes: z.preprocess(
    (value) =>
      value === undefined || value === null ? [] : Array.isArray(value) ? value : [value],
    z
      .array(z.enum(UPLOAD_TYPE_NAMES, { error: 'Choose from the listed file types.' }))
      .min(1, 'Allow at least one file type.'),
  ),
});

export type FileUploadSettingsInput = z.input<typeof fileUploadSettingsInputSchema>;
export type FileUploadSettingsValues = z.output<typeof fileUploadSettingsInputSchema>;
