import { Schema, type Types } from 'mongoose';
import { baseSchemaPlugin, defineModel } from '@pulse/db';
import {
  ADDRESS_MAX_LENGTH,
  CONTACT_EMAIL_MAX_LENGTH,
  CONTACT_MOBILE_MAX_LENGTH,
  CONTACT_POSITION_MAX_LENGTH,
  DEFAULT_SUPPLIER_TYPE,
  MASTER_NAME_MAX_LENGTH,
  NOTES_MAX_LENGTH,
  PERSON_NAME_MAX_LENGTH,
  SUPPLIER_CONTACTS_MAX,
  SUPPLIER_TYPES,
  type SupplierType,
} from '../../master-data';
import { termsDaysField, tinField } from '../clients/model';
import { MASTER_DATA_COLLATION } from '../master-data-collation';

// Spec: docs/modules/supply.md#suppliers — suppliers are Pulse Core master data
// (docs/modules/core.md#managing-master-data). Their contacts are kept on the supplier (at most
// 20, no primary flag), not in a collection.

export interface SupplierContact {
  name: string;
  position: string | null;
  /** Lowercased. */
  email: string | null;
  /** Stored as typed (checked leniently as a Philippine mobile). */
  mobile: string | null;
}

export interface SupplierRecord {
  _id: Types.ObjectId;
  /** Unique ignoring case, retired suppliers included. */
  name: string;
  /** Digits only, 9, 12 or 14; null when not given. Company data, not sensitive. */
  tin: string | null;
  address: string | null;
  /** Whole days from 0 to 365; null when not set. */
  paymentTermsDays: number | null;
  contacts: SupplierContact[];
  /** The products supplied. A product retired later stays here (shown "Retired"). */
  brandIds: Types.ObjectId[];
  supplierType: SupplierType;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  deletedAt: Date | null;
}

const supplierContactSchema = new Schema<SupplierContact>(
  {
    name: { type: String, required: true, trim: true, maxlength: PERSON_NAME_MAX_LENGTH },
    position: { type: String, default: null, trim: true, maxlength: CONTACT_POSITION_MAX_LENGTH },
    email: {
      type: String,
      default: null,
      trim: true,
      lowercase: true,
      maxlength: CONTACT_EMAIL_MAX_LENGTH,
    },
    mobile: { type: String, default: null, trim: true, maxlength: CONTACT_MOBILE_MAX_LENGTH },
  },
  { _id: false },
);

const supplierSchema = new Schema<SupplierRecord>({
  name: { type: String, required: true, trim: true, maxlength: MASTER_NAME_MAX_LENGTH },
  tin: tinField,
  address: { type: String, default: null, trim: true, maxlength: ADDRESS_MAX_LENGTH },
  paymentTermsDays: termsDaysField,
  contacts: {
    type: [supplierContactSchema],
    default: [],
    validate: {
      validator: (contacts: SupplierContact[]) => contacts.length <= SUPPLIER_CONTACTS_MAX,
      message: `A supplier has at most ${SUPPLIER_CONTACTS_MAX} contacts.`,
    },
  },
  brandIds: { type: [Schema.Types.ObjectId], default: [] },
  supplierType: {
    type: String,
    required: true,
    enum: SUPPLIER_TYPES,
    default: DEFAULT_SUPPLIER_TYPE,
  },
  notes: { type: String, default: null, trim: true, maxlength: NOTES_MAX_LENGTH },
});

/** The unique, case-insensitive `{ name }` index. */
export const SUPPLIER_NAME_INDEX = 'name_1_ci';

// Retired suppliers are included, so a retired supplier's name isn't reused.
supplierSchema.index(
  { name: 1 },
  { unique: true, name: SUPPLIER_NAME_INDEX, collation: MASTER_DATA_COLLATION },
);

// Retiring a supplier soft-deletes it.
supplierSchema.plugin(baseSchemaPlugin, { softDelete: true });

export const SupplierModel = defineModel('Supplier', supplierSchema, 'suppliers');
