import { Schema, type Types } from 'mongoose';
import { baseSchemaPlugin, defineModel } from '@pulse/db';
import {
  ADDRESS_MAX_LENGTH,
  DEFAULT_PRICE_DISPLAY,
  DEFAULT_VAT_TREATMENT,
  INDUSTRY_MAX_LENGTH,
  MASTER_NAME_MAX_LENGTH,
  NOTES_MAX_LENGTH,
  PRICE_DISPLAYS,
  type PriceDisplay,
  TERMS_DAYS_MAX,
  TIN_HELP,
  TIN_PATTERN,
  VAT_TREATMENTS,
  type VatTreatment,
} from '../../master-data';
import { MASTER_DATA_COLLATION } from '../master-data-collation';

// Spec: docs/modules/engage.md#clients-sites-and-contacts — clients are Pulse Core master data
// (docs/modules/core.md#managing-master-data). Sites and contacts are their own collections
// (site-model.ts, contact-model.ts). Never exported: other modules use Core's client services.

export interface ClientRecord {
  _id: Types.ObjectId;
  /** Not unique: a matching name needs "Save anyway" (checked by the service). */
  name: string;
  /** Digits only, 9, 12 or 14; null when not given. Company data, not sensitive. */
  tin: string | null;
  billingAddress: string | null;
  vatTreatment: VatTreatment;
  priceDisplay: PriceDisplay;
  /** Whole days from 0 to 365; null means the Fiscal default credit term applies. */
  creditTermsDays: number | null;
  industry: string | null;
  /** The owning Account Manager (an employee); null when none is set. */
  accountManagerEmployeeId: Types.ObjectId | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  deletedAt: Date | null;
}

/** Null, or a whole number of days from 0 to 365 (client credit terms, supplier payment terms). */
export const termsDaysField = {
  type: Number,
  default: null,
  min: 0,
  max: TERMS_DAYS_MAX,
  validate: {
    validator: (value: number | null) => value === null || Number.isInteger(value),
    message: 'Terms are a whole number of days.',
  },
};

/** Null, or a TIN of 9, 12 or 14 digits (clients and suppliers). */
export const tinField = {
  type: String,
  default: null,
  match: [TIN_PATTERN, TIN_HELP] as [RegExp, string],
};

const clientSchema = new Schema<ClientRecord>({
  name: { type: String, required: true, trim: true, maxlength: MASTER_NAME_MAX_LENGTH },
  tin: tinField,
  billingAddress: { type: String, default: null, trim: true, maxlength: ADDRESS_MAX_LENGTH },
  vatTreatment: {
    type: String,
    required: true,
    enum: VAT_TREATMENTS,
    default: DEFAULT_VAT_TREATMENT,
  },
  priceDisplay: {
    type: String,
    required: true,
    enum: PRICE_DISPLAYS,
    default: DEFAULT_PRICE_DISPLAY,
  },
  creditTermsDays: termsDaysField,
  industry: { type: String, default: null, trim: true, maxlength: INDUSTRY_MAX_LENGTH },
  accountManagerEmployeeId: { type: Schema.Types.ObjectId, default: null },
  notes: { type: String, default: null, trim: true, maxlength: NOTES_MAX_LENGTH },
});

/** The case-insensitive, not unique, `{ name }` index, for the duplicate name check. */
export const CLIENT_NAME_INDEX = 'name_1_ci';

// Not unique: two clients may share a name once confirmed. The index serves the duplicate name
// check, which counts retired clients too (query it with MASTER_DATA_COLLATION).
clientSchema.index({ name: 1 }, { name: CLIENT_NAME_INDEX, collation: MASTER_DATA_COLLATION });

// Retiring a client soft-deletes it.
clientSchema.plugin(baseSchemaPlugin, { softDelete: true });

export const ClientModel = defineModel('Client', clientSchema, 'clients');
