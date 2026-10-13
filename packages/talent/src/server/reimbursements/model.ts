import { Schema, type Types } from 'mongoose';
import { baseSchemaPlugin, defineModel } from '@pulse/db';
import {
  MERCHANT_MAX_LENGTH,
  RECEIPT_NUMBER_MAX_LENGTH,
  REIMBURSEMENT_DESCRIPTION_MAX_LENGTH,
  ROUTE_MAX_LENGTH,
} from '../../reimbursements/inputs';

// Spec: docs/DATA_MODEL.md#collection-ownership (`reimbursements`, build step 2.5) and
// docs/modules/talent.md#reimbursements-build-step-25 ("Reimbursement lines"; decisions 238 and
// 239 in docs/BUILD_PLAN.md) — the employee's own reimbursement lines, each on the timesheet it
// was added on (`employeeId` and `timesheetId` never change). Soft delete only, which releases the
// line's receipt claim in the same transaction; every save checks `version`. Not encrypted:
// nothing here is sensitive. No project field until Phase 4.

export interface ReimbursementDocument {
  _id: Types.ObjectId;
  employeeId: Types.ObjectId;
  timesheetId: Types.ObjectId;
  /** 00:00 Manila on the receipt date, stored in UTC. */
  receiptDate: Date;
  typeKey: string;
  merchant: string;
  /** The canonical 14 digits. */
  merchantTin: string;
  /** As typed. */
  receiptNumber: string;
  amountCentavos: number;
  receiptFileId: Types.ObjectId;
  clientId: Types.ObjectId | null;
  pickUp: string | null;
  dropOff: string | null;
  description: string | null;
  /** The line's live entry in `receiptClaims`. */
  receiptClaimId: Types.ObjectId;
  version: number;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
}

const text = (max: number, required = false) => ({
  type: String,
  ...(required ? { required: true } : { default: null }),
  trim: true,
  minlength: 1,
  maxlength: max,
});

const reimbursementSchema = new Schema<ReimbursementDocument>({
  employeeId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  timesheetId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  receiptDate: { type: Date, required: true },
  typeKey: { type: String, required: true, trim: true, minlength: 1, maxlength: 40 },
  merchant: text(MERCHANT_MAX_LENGTH, true),
  merchantTin: { type: String, required: true, match: /^\d{14}$/ },
  receiptNumber: text(RECEIPT_NUMBER_MAX_LENGTH, true),
  amountCentavos: {
    type: Number,
    required: true,
    min: 1,
    validate: { validator: Number.isSafeInteger, message: 'The amount must be whole centavos.' },
  },
  receiptFileId: { type: Schema.Types.ObjectId, required: true },
  clientId: { type: Schema.Types.ObjectId, default: null },
  pickUp: text(ROUTE_MAX_LENGTH),
  dropOff: text(ROUTE_MAX_LENGTH),
  description: text(REIMBURSEMENT_DESCRIPTION_MAX_LENGTH),
  receiptClaimId: { type: Schema.Types.ObjectId, required: true },
  version: { type: Number, required: true, min: 1 },
});

reimbursementSchema.index({ employeeId: 1, receiptDate: 1 });
reimbursementSchema.index({ timesheetId: 1 });

reimbursementSchema.plugin(baseSchemaPlugin, { softDelete: true });

export const ReimbursementModel = defineModel(
  'Reimbursement',
  reimbursementSchema,
  'reimbursements',
);
