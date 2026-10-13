import { Schema, type Types } from 'mongoose';
import { baseSchemaPlugin, defineModel } from '@pulse/db';
import { guardWrites, hasOnlyKeys } from '@pulse/core/server';
import { RECEIPT_CLAIM_TYPES, type ReceiptClaimType } from '../../reimbursements/views';

// Spec: docs/DATA_MODEL.md#collection-ownership (`receiptClaims`, build step 2.5) and
// docs/modules/talent.md#reimbursements-build-step-25 ("No duplicates"; decisions 241–244 in
// docs/BUILD_PLAN.md) — the one register of claimed receipts, shared by reimbursements and (from
// step 5.11) Pulse Fiscal's petty cash vouchers.
//
// - Unique on the canonical merchant TIN and the receipt key among live claims
//   (`deletedAt: null`): of two saves of one receipt at once, exactly one saves.
// - Insert and soft delete only (`guardWrites`): the keys never change. Releasing a claim sets
//   `deletedAt` (with `updatedBy`); a released receipt can be claimed again as a new entry.
// - Written only through Talent's `claimReceipt` and `releaseReceiptClaim`, in the caller's
//   transaction. Plain keys: nothing here is sensitive.

export interface ReceiptClaimDocument {
  _id: Types.ObjectId;
  /** The canonical 14 digits. */
  merchantTin: string;
  /** Capitals, letters and digits only, leading zeros dropped. */
  receiptKey: string;
  claimType: ReceiptClaimType;
  /** The reimbursement line's (or voucher's) id. */
  claimId: Types.ObjectId;
  /** The employee, for a reimbursement; null for a voucher. */
  employeeId: Types.ObjectId | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
}

const receiptClaimSchema = new Schema<ReceiptClaimDocument>({
  merchantTin: { type: String, required: true, immutable: true, match: /^\d{14}$/ },
  receiptKey: { type: String, required: true, immutable: true, match: /^[A-Z0-9]{1,40}$/ },
  claimType: { type: String, enum: RECEIPT_CLAIM_TYPES, required: true, immutable: true },
  claimId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  employeeId: { type: Schema.Types.ObjectId, default: null, immutable: true },
});

/** The unique index's name, for the duplicate key check. */
export const LIVE_RECEIPT_INDEX = 'liveReceipt';
receiptClaimSchema.index(
  { merchantTin: 1, receiptKey: 1 },
  { unique: true, name: LIVE_RECEIPT_INDEX, partialFilterExpression: { deletedAt: null } },
);
receiptClaimSchema.index({ claimType: 1, claimId: 1 });

const RELEASE_KEYS = new Set(['deletedAt', 'updatedBy', 'updatedAt']);
guardWrites(receiptClaimSchema, {
  message: 'A receipt claim is never changed: it is only released.',
  // `releaseReceiptClaim`: `$set` of `deletedAt` (and `updatedBy`; Mongoose adds `updatedAt`).
  allowUpdate: (update) =>
    hasOnlyKeys(update, new Set(['$set', '$setOnInsert'])) &&
    hasOnlyKeys(update.$set ?? {}, RELEASE_KEYS) &&
    update.$set?.deletedAt instanceof Date &&
    hasOnlyKeys(update.$setOnInsert ?? {}, new Set(['createdAt'])),
});

receiptClaimSchema.plugin(baseSchemaPlugin, { softDelete: true });

export const ReceiptClaimModel = defineModel('ReceiptClaim', receiptClaimSchema, 'receiptClaims');
