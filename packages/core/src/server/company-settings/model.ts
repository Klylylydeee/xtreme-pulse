import { Schema, type Types } from 'mongoose';
import { baseSchemaPlugin, defineModel } from '@pulse/db';

// Spec: docs/modules/core.md#company-details-pending-from-the-client — one company settings
// record, filled with marked placeholders (`[Company TIN]`, see isPlaceholder) until the client
// provides the details. Documents and reports read the details from here, never from code. The
// System Administrator edits it in build step 1.4.

/** The one value of `singletonKey`: the unique index keeps the record to one. */
export const COMPANY_SETTINGS_KEY = 'company';

export interface BirRegistration {
  /** The CAS/CBA acknowledgment or permit details. */
  casPermitDetails: string;
  /** The registered invoice number series. */
  invoiceSeries: string;
}

export interface CompanySettingsRecord {
  _id: Types.ObjectId;
  singletonKey: typeof COMPANY_SETTINGS_KEY;
  registeredName: string;
  businessAddress: string;
  tin: string;
  rdoCode: string;
  sssEmployerNumber: string;
  philhealthEmployerNumber: string;
  pagibigEmployerId: string;
  birRegistration: BirRegistration;
  /** The company logo in stored files (docs/ARCHITECTURE.md#file-storage); null until uploaded. */
  logoFileId: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
}

const detail = { type: String, required: true, trim: true, maxlength: 500 };

const companySettingsSchema = new Schema<CompanySettingsRecord>({
  singletonKey: {
    type: String,
    required: true,
    immutable: true,
    enum: [COMPANY_SETTINGS_KEY],
    default: COMPANY_SETTINGS_KEY,
  },
  registeredName: detail,
  businessAddress: detail,
  tin: detail,
  rdoCode: detail,
  sssEmployerNumber: detail,
  philhealthEmployerNumber: detail,
  pagibigEmployerId: detail,
  birRegistration: {
    type: new Schema<BirRegistration>(
      { casPermitDetails: detail, invoiceSeries: detail },
      { _id: false },
    ),
    required: true,
  },
  logoFileId: { type: Schema.Types.ObjectId, default: null },
});

companySettingsSchema.index({ singletonKey: 1 }, { unique: true });

// The one settings record is never deleted.
companySettingsSchema.plugin(baseSchemaPlugin, { softDelete: false });

export const CompanySettingsModel = defineModel(
  'CompanySettings',
  companySettingsSchema,
  'companySettings',
);
