import { z } from 'zod';
import { emailDomainOf, normalizeEmail } from './account';
import { OBJECT_ID_PATTERN } from './audit';

// Spec: docs/modules/core.md#managing-master-data — the shared master data forms: clients with
// their sites and contacts (docs/modules/engage.md#clients-sites-and-contacts), products
// (docs/modules/engage.md#deals-and-stages), catalog items (docs/modules/supply.md#stock) and
// suppliers (docs/modules/supply.md#suppliers). Pure code, safe in the browser, so the sheets and
// the services check the same rules. The services are server-only (`@pulse/core/server`); they
// check what needs the database: uniqueness, live records, the Account Manager's account and the
// duplicate client name.

// ---------------------------------------------------------------------------------------------
// Fixed sets (docs/CODE_STYLE.md: fixed sets are code)

/** How VAT applies to a client. The rate is versioned configuration, so no label names it. */
export const VAT_TREATMENTS = ['vatRegistered', 'zeroRated', 'vatExempt'] as const;
export type VatTreatment = (typeof VAT_TREATMENTS)[number];
export const DEFAULT_VAT_TREATMENT: VatTreatment = 'vatRegistered';
export const VAT_TREATMENT_LABELS: Readonly<Record<VatTreatment, string>> = {
  vatRegistered: 'VAT-registered',
  zeroRated: 'Zero-rated',
  vatExempt: 'VAT-exempt',
};

/** How a client's quotations show prices. */
export const PRICE_DISPLAYS = ['vatExclusive', 'vatInclusive'] as const;
export type PriceDisplay = (typeof PRICE_DISPLAYS)[number];
export const DEFAULT_PRICE_DISPLAY: PriceDisplay = 'vatExclusive';
export const PRICE_DISPLAY_LABELS: Readonly<Record<PriceDisplay, string>> = {
  vatExclusive: 'VAT-exclusive',
  vatInclusive: 'VAT-inclusive',
};

/** How a catalog item is tracked: by serial, by quantity, or not stocked (services, licenses). */
export const ITEM_KINDS = ['serialized', 'bulk', 'nonStock'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
export const ITEM_KIND_LABELS: Readonly<Record<ItemKind, string>> = {
  serialized: 'Serialized',
  bulk: 'Bulk',
  nonStock: 'Non-stock',
};

export const SUPPLIER_TYPES = ['distributor', 'brandPrincipal', 'subcontractor', 'other'] as const;
export type SupplierType = (typeof SUPPLIER_TYPES)[number];
export const DEFAULT_SUPPLIER_TYPE: SupplierType = 'distributor';
export const SUPPLIER_TYPE_LABELS: Readonly<Record<SupplierType, string>> = {
  distributor: 'Distributor',
  brandPrincipal: 'Brand principal',
  subcontractor: 'Subcontractor',
  other: 'Other',
};

/** Suggestions for a catalog item's unit. The unit is free text: these are not a fixed set. */
export const UNIT_SUGGESTIONS = [
  'pc',
  'unit',
  'set',
  'lot',
  'box',
  'roll',
  'm',
  'license',
  'service',
] as const;

// ---------------------------------------------------------------------------------------------
// Limits

/** Credit terms (clients) and payment terms (suppliers): whole days from 0 to 365. */
export const TERMS_DAYS_MAX = 365;
/** Default warranty months on a catalog item: a whole number from 0 to 120. */
export const WARRANTY_MONTHS_MAX = 120;
export const DEFAULT_WARRANTY_MONTHS = 12;
/** The default warranty the form sets when a non-stock item is chosen (still editable). */
export const NON_STOCK_WARRANTY_MONTHS = 0;
export const SUPPLIER_CONTACTS_MAX = 20;
export const INDUSTRY_MAX_LENGTH = 100;

// Not set by the spec; generous limits so a bad request can't store a huge value.
export const MASTER_NAME_MAX_LENGTH = 200;
export const PRODUCT_NAME_MAX_LENGTH = 100;
export const PART_NUMBER_MAX_LENGTH = 100;
export const ITEM_DESCRIPTION_MAX_LENGTH = 1000;
export const UNIT_MAX_LENGTH = 30;
export const PERSON_NAME_MAX_LENGTH = 100;
export const CONTACT_POSITION_MAX_LENGTH = 100;
export const CONTACT_EMAIL_MAX_LENGTH = 254;
export const CONTACT_MOBILE_MAX_LENGTH = 30;
export const CITY_MAX_LENGTH = 100;
export const ADDRESS_MAX_LENGTH = 500;
export const NOTES_MAX_LENGTH = 2000;

// ---------------------------------------------------------------------------------------------
// TIN and mobile

/** A TIN's allowed lengths in digits: 9, 12 or 14. */
export const TIN_DIGIT_LENGTHS = [9, 12, 14] as const;
/** A stored TIN: digits only, 9, 12 or 14 of them. */
export const TIN_PATTERN = /^(?:\d{9}|\d{12}|\d{14})$/;
export const TIN_HELP = 'Enter 9, 12 or 14 digits. Dashes and spaces are fine.';

/** A TIN as typed, with its dashes and spaces taken out (and nothing else). */
export function normalizeTin(value: string): string {
  return value.replace(/[\s-]/g, '');
}

/** True for a normalized TIN of 9, 12 or 14 digits. */
export function isValidTin(digits: string): boolean {
  return TIN_PATTERN.test(digits);
}

/**
 * A stored TIN for display: groups of three, the last group taking the remaining digits
 * (`000-000-000`, `000-000-000-000`, `000-000-000-00000`). Anything that isn't a valid TIN is
 * returned as it is.
 */
export function formatTin(digits: string): string {
  if (!isValidTin(digits)) return digits;
  const groups = [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6, 9)];
  if (digits.length > 9) groups.push(digits.slice(9));
  return groups.join('-');
}

const PH_MOBILE_PATTERN = /^(?:\+?63|0)9\d{9}$/;
export const PH_MOBILE_HELP = 'Enter a Philippine mobile number, for example 0917 123 4567.';

/**
 * The lenient Philippine mobile check: with spaces, dashes and parentheses taken out, `+63`, `63`
 * or `0`, then `9` and 9 more digits. The value itself is stored as typed.
 */
export function isPhMobile(value: string): boolean {
  return PH_MOBILE_PATTERN.test(value.replace(/[\s\-()]/g, ''));
}

// ---------------------------------------------------------------------------------------------
// Fields

const tooLong = (max: number) => `Use ${max} characters or fewer.`;

function requiredText(message: string, max: number) {
  return z.string({ error: message }).trim().min(1, message).max(max, tooLong(max));
}

// Optional free text: an empty value is stored as null.
function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max, tooLong(max))
    .nullable()
    .optional()
    .transform((value) => (value ? value : null));
}

// An empty field (or no field) as undefined, so `.optional()` and `.default()` apply.
const emptyAsUndefined = (value: unknown) =>
  value === null || (typeof value === 'string' && value.trim() === '') ? undefined : value;

function wholeNumber(message: string, min: number, max: number) {
  return z.coerce.number({ error: message }).int(message).min(min, message).max(max, message);
}

// Optional whole days from 0 to 365; empty means none (null).
function optionalTermsDays(label: string) {
  const message = `Enter ${label} as a whole number of days from 0 to ${TERMS_DAYS_MAX}, or leave it empty.`;
  return z.preprocess(
    emptyAsUndefined,
    wholeNumber(message, 0, TERMS_DAYS_MAX)
      .optional()
      .transform((value) => value ?? null),
  );
}

// A checkbox: `true`, or `'on'`/`'true'` from a form, is checked. Optional in the input type (an
// unchecked box sends nothing), always a boolean once parsed.
const checkbox = z
  .preprocess((value) => value === true || value === 'on' || value === 'true', z.boolean())
  .optional()
  .transform((value) => value === true);

function objectId(message: string) {
  return z.string({ error: message }).regex(OBJECT_ID_PATTERN, message);
}

// Optional: an empty value (a cleared picker) means none.
function optionalObjectId(message: string) {
  return z
    .union([z.literal(''), z.string().regex(OBJECT_ID_PATTERN, message)])
    .nullable()
    .optional()
    .transform((value) => (value ? value : null));
}

const tin = z
  .string()
  .nullable()
  .optional()
  .transform((value) => (value ? normalizeTin(value) : ''))
  .refine((digits) => digits === '' || isValidTin(digits), { message: TIN_HELP })
  .transform((digits) => (digits ? digits : null));

const contactEmail = z
  .string()
  .trim()
  .max(CONTACT_EMAIL_MAX_LENGTH, tooLong(CONTACT_EMAIL_MAX_LENGTH))
  .nullable()
  .optional()
  .refine((value) => !value || emailDomainOf(value) !== null, {
    message: 'Enter a valid email address.',
  })
  .transform((value) => (value ? normalizeEmail(value) : null));

const contactMobile = z
  .string()
  .trim()
  .max(CONTACT_MOBILE_MAX_LENGTH, tooLong(CONTACT_MOBILE_MAX_LENGTH))
  .nullable()
  .optional()
  .refine((value) => !value || isPhMobile(value), { message: PH_MOBILE_HELP })
  .transform((value) => (value ? value : null));

const contactName = requiredText('Enter the contact’s name.', PERSON_NAME_MAX_LENGTH);
const contactPosition = optionalText(CONTACT_POSITION_MAX_LENGTH);

const address = optionalText(ADDRESS_MAX_LENGTH);
const notes = optionalText(NOTES_MAX_LENGTH);

// Each *Input type is what a service takes: the form's values as sent (the service parses them
// again with the same schema). Each *Values type is the parsed result.

// ---------------------------------------------------------------------------------------------
// Clients

/**
 * Adding or editing a client. `allowDuplicateName` is the "Save anyway" confirmation: without it,
 * the service refuses a name that matches another client's ignoring case (retired ones included).
 */
export const clientInputSchema = z.object({
  name: requiredText('Enter the client’s name.', MASTER_NAME_MAX_LENGTH),
  tin,
  billingAddress: address,
  vatTreatment: z.preprocess(
    emptyAsUndefined,
    z.enum(VAT_TREATMENTS, { error: 'Choose a VAT treatment.' }).default(DEFAULT_VAT_TREATMENT),
  ),
  priceDisplay: z.preprocess(
    emptyAsUndefined,
    z.enum(PRICE_DISPLAYS, { error: 'Choose a price display.' }).default(DEFAULT_PRICE_DISPLAY),
  ),
  creditTermsDays: optionalTermsDays('the credit terms'),
  industry: optionalText(INDUSTRY_MAX_LENGTH),
  accountManagerEmployeeId: optionalObjectId('Choose the Account Manager again.'),
  notes,
  allowDuplicateName: checkbox,
});
export type ClientInput = z.input<typeof clientInputSchema>;
export type ClientValues = z.output<typeof clientInputSchema>;

/** Editing a client: the same fields as adding one. */
export const clientUpdateSchema = clientInputSchema;
export type ClientUpdateInput = z.input<typeof clientUpdateSchema>;

/** Adding a site to a client (fixed from then on). The name is unique within the client. */
export const clientSiteInputSchema = z.object({
  clientId: objectId('Choose a client.'),
  name: requiredText('Enter the site name.', MASTER_NAME_MAX_LENGTH),
  address,
  city: optionalText(CITY_MAX_LENGTH),
  siteContact: optionalText(MASTER_NAME_MAX_LENGTH),
});
export type ClientSiteInput = z.input<typeof clientSiteInputSchema>;
export type ClientSiteValues = z.output<typeof clientSiteInputSchema>;

/** Editing a site: everything but its client. */
export const clientSiteUpdateSchema = clientSiteInputSchema.omit({ clientId: true });
export type ClientSiteUpdateInput = z.input<typeof clientSiteUpdateSchema>;

/** Adding a contact to a client (fixed from then on). */
export const clientContactInputSchema = z.object({
  clientId: objectId('Choose a client.'),
  name: contactName,
  position: contactPosition,
  email: contactEmail,
  mobile: contactMobile,
  isPrimary: checkbox,
});
export type ClientContactInput = z.input<typeof clientContactInputSchema>;
export type ClientContactValues = z.output<typeof clientContactInputSchema>;

/** Editing a contact: everything but its client. */
export const clientContactUpdateSchema = clientContactInputSchema.omit({ clientId: true });
export type ClientContactUpdateInput = z.input<typeof clientContactUpdateSchema>;

// ---------------------------------------------------------------------------------------------
// Products (`brands` in code)

/** Adding or renaming a product. The name is unique ignoring case, retired products included. */
export const brandInputSchema = z.object({
  name: requiredText('Enter the product name.', PRODUCT_NAME_MAX_LENGTH),
});
export type BrandInput = z.input<typeof brandInputSchema>;

// ---------------------------------------------------------------------------------------------
// Catalog items

const warrantyMessage = `Enter the default warranty as a whole number of months from 0 to ${WARRANTY_MONTHS_MAX}.`;

/** Adding a catalog item. Its product and item kind are fixed from then on. */
export const catalogItemInputSchema = z.object({
  brandId: objectId('Choose a product.'),
  partNumber: requiredText('Enter the part number.', PART_NUMBER_MAX_LENGTH),
  description: requiredText('Enter a description.', ITEM_DESCRIPTION_MAX_LENGTH),
  unit: requiredText('Enter a unit, for example pc.', UNIT_MAX_LENGTH),
  itemKind: z.enum(ITEM_KINDS, { error: 'Choose an item kind.' }),
  defaultWarrantyMonths: z.preprocess(
    emptyAsUndefined,
    wholeNumber(warrantyMessage, 0, WARRANTY_MONTHS_MAX).default(DEFAULT_WARRANTY_MONTHS),
  ),
});
export type CatalogItemInput = z.input<typeof catalogItemInputSchema>;
export type CatalogItemValues = z.output<typeof catalogItemInputSchema>;

/** Editing a catalog item: the product and item kind can't be changed. */
export const catalogItemUpdateSchema = catalogItemInputSchema.omit({
  brandId: true,
  itemKind: true,
});
export type CatalogItemUpdateInput = z.input<typeof catalogItemUpdateSchema>;

// ---------------------------------------------------------------------------------------------
// Suppliers

/** A contact kept on the supplier. Suppliers have no primary contact. */
export const supplierContactSchema = z.object({
  name: contactName,
  position: contactPosition,
  email: contactEmail,
  mobile: contactMobile,
});
export type SupplierContactInput = z.input<typeof supplierContactSchema>;

/**
 * Adding or editing a supplier. The name is unique ignoring case, retired suppliers included. The
 * products supplied are listed once each; a newly picked one must be live (the service checks).
 */
export const supplierInputSchema = z.object({
  name: requiredText('Enter the supplier’s name.', MASTER_NAME_MAX_LENGTH),
  tin,
  address,
  paymentTermsDays: optionalTermsDays('the payment terms'),
  contacts: z
    .array(supplierContactSchema, { error: 'Check the contacts.' })
    .max(SUPPLIER_CONTACTS_MAX, `A supplier has at most ${SUPPLIER_CONTACTS_MAX} contacts.`)
    .default([]),
  // Optional: none (or an empty value) means no products. A form sends one id as a string and
  // several as an array; each id is kept once.
  brandIds: z
    .union([z.array(z.string()), z.string()], { error: 'Choose each product from the list.' })
    .nullable()
    .optional()
    .transform((value) =>
      value == null || value === '' ? [] : Array.isArray(value) ? value : [value],
    )
    .pipe(
      z.array(objectId('Choose each product from the list.')).transform((ids) => [...new Set(ids)]),
    ),
  supplierType: z.preprocess(
    emptyAsUndefined,
    z.enum(SUPPLIER_TYPES, { error: 'Choose a supplier type.' }).default(DEFAULT_SUPPLIER_TYPE),
  ),
  notes,
});
export type SupplierInput = z.input<typeof supplierInputSchema>;
export type SupplierValues = z.output<typeof supplierInputSchema>;

/** Editing a supplier: the same fields as adding one. */
export const supplierUpdateSchema = supplierInputSchema;
export type SupplierUpdateInput = z.input<typeof supplierUpdateSchema>;
