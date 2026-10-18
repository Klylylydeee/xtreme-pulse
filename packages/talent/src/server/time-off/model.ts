import { Schema, type Types } from 'mongoose';
import { baseSchemaPlugin, defineModel } from '@pulse/db';
import { guardWrites, hasOnlyKeys } from '@pulse/core/server';
import {
  TIME_OFF_CANCEL_REASON_MAX_LENGTH,
  TIME_OFF_KINDS,
  TIME_OFF_PORTIONS,
  TIME_OFF_REASON_MAX_LENGTH,
  TIME_OFF_REMARKS_MAX_LENGTH,
  TIME_OFF_STATUSES,
  type TimeOffKind,
  type TimeOffPortion,
  type TimeOffStatus,
} from '../../time-off/kinds';

// Spec: docs/DATA_MODEL.md#collection-ownership (`timeOffRequests`, build step 2.8) and
// docs/modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28 ("Time off
// requests"; decisions 309–314 in docs/BUILD_PLAN.md).
//
// - One request is leave or offset time off, numbered `LV-YYYY-NNNN` or `OFS-YYYY-NNNN` at filing.
// - Never deleted or replaced: the one allowed write after the insert is an operator update ($set,
//   $inc) with the `version` check. `rejected` and `cancelled` are final; `approved` changes only
//   to `cancelled` (before the first day) or through the holidays-changed listener's new split.
// - Not encrypted: only the attachment file is sensitive (category `medical`, through the file
//   route's `talent.timeOffRequest` check).
// - Written only by Talent's time off service (./service.ts), its approval hook (./approval.ts)
//   and the listener's reconcile (./reconcile.ts). The balance services read it by its documented
//   fields (server/leave/holdings.ts).
//
// `timeOffFilingLocks` holds one tiny document per employee that every filing, resend and approval
// touches first in its transaction, so two of one employee's transactions always conflict and one
// retries with the other's request visible: the overlap check is serialized per employee
// (*Assumption*, HANDOFF: the lock collection is an implementation detail of that rule).

export interface TimeOffRequestDocument {
  _id: Types.ObjectId;
  number: string;
  employeeId: Types.ObjectId;
  requesterUserId: Types.ObjectId;
  kind: TimeOffKind;
  /** Leave: the type's key in `talent.leaveSettings`; null for offset. */
  leaveTypeKey: string | null;
  /** 00:00 Manila on the first and last days. */
  startDate: Date;
  endDate: Date;
  portion: TimeOffPortion;
  /** `part` only (`HH:MM`), else null. */
  fromTime: string | null;
  toTime: string | null;
  /** Leave: the chargeable half days. Null for offset. */
  chargeableHalfDays: number | null;
  /** Leave of a `credited` type: the paid and unpaid half days (a preview while pending). */
  paidHalfDays: number | null;
  unpaidHalfDays: number | null;
  /** Offset: the scheduled minutes covered. Null for leave. */
  minutes: number | null;
  reason: string | null;
  attachmentFileId: Types.ObjectId | null;
  status: TimeOffStatus;
  /** The current Core approval request. */
  approvalRequestId: Types.ObjectId | null;
  submittedAt: Date;
  decidedAt: Date | null;
  decidedBy: Types.ObjectId | null;
  remarks: string | null;
  cancelledAt: Date | null;
  cancelledBy: Types.ObjectId | null;
  cancelReason: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
}

const wholeOrNull = {
  validator: (value: number | null) => value === null || Number.isSafeInteger(value),
  message: 'Time off is counted in whole half days or whole minutes.',
};

const timeOffRequestSchema = new Schema<TimeOffRequestDocument>({
  number: { type: String, required: true, immutable: true },
  employeeId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  requesterUserId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  kind: { type: String, enum: TIME_OFF_KINDS, required: true, immutable: true },
  leaveTypeKey: { type: String, default: null, trim: true, maxlength: 40 },
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  portion: { type: String, enum: TIME_OFF_PORTIONS, required: true },
  fromTime: { type: String, default: null, match: /^\d{2}:\d{2}$/ },
  toTime: { type: String, default: null, match: /^\d{2}:\d{2}$/ },
  chargeableHalfDays: { type: Number, default: null, min: 0, validate: wholeOrNull },
  paidHalfDays: { type: Number, default: null, min: 0, validate: wholeOrNull },
  unpaidHalfDays: { type: Number, default: null, min: 0, validate: wholeOrNull },
  minutes: { type: Number, default: null, min: 0, validate: wholeOrNull },
  reason: { type: String, default: null, trim: true, maxlength: TIME_OFF_REASON_MAX_LENGTH },
  attachmentFileId: { type: Schema.Types.ObjectId, default: null },
  status: { type: String, enum: TIME_OFF_STATUSES, required: true },
  approvalRequestId: { type: Schema.Types.ObjectId, default: null },
  submittedAt: { type: Date, required: true },
  decidedAt: { type: Date, default: null },
  decidedBy: { type: Schema.Types.ObjectId, default: null },
  remarks: { type: String, default: null, trim: true, maxlength: TIME_OFF_REMARKS_MAX_LENGTH },
  cancelledAt: { type: Date, default: null },
  cancelledBy: { type: Schema.Types.ObjectId, default: null },
  cancelReason: {
    type: String,
    default: null,
    trim: true,
    maxlength: TIME_OFF_CANCEL_REASON_MAX_LENGTH,
  },
  version: { type: Number, required: true, min: 1 },
});

timeOffRequestSchema.index({ number: 1 }, { unique: true });
timeOffRequestSchema.index({ employeeId: 1, startDate: 1 });
timeOffRequestSchema.index({ employeeId: 1, status: 1 });
timeOffRequestSchema.index({ status: 1, startDate: 1 });

const ALLOWED_OPERATORS = new Set(['$set', '$inc']);

guardWrites(timeOffRequestSchema, {
  message:
    'Time off requests are never deleted or replaced. Change one through the time off service instead.',
  allowUpdate: (update, query) =>
    hasOnlyKeys(update, ALLOWED_OPERATORS) &&
    Object.keys(update).length > 0 &&
    query.getOptions().overwrite !== true,
});

// Never deleted, so no soft delete either.
timeOffRequestSchema.plugin(baseSchemaPlugin, { softDelete: false });

export const TimeOffRequestModel = defineModel(
  'TimeOffRequest',
  timeOffRequestSchema,
  'timeOffRequests',
);

// ---------------------------------------------------------------------------------------------
// The per-employee filing lock

export interface TimeOffFilingLockDocument {
  _id: Types.ObjectId;
  employeeId: Types.ObjectId;
  /** Raised by every filing, resend and approval of the employee's time off. */
  touches: number;
}

const timeOffFilingLockSchema = new Schema<TimeOffFilingLockDocument>({
  employeeId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  touches: { type: Number, required: true, default: 0, min: 0 },
});
timeOffFilingLockSchema.index({ employeeId: 1 }, { unique: true });

guardWrites(timeOffFilingLockSchema, {
  message: 'A time off filing lock only changes by its touch.',
  allowUpdate: (update) => hasOnlyKeys(update, new Set(['$inc', '$set', '$setOnInsert'])),
});

timeOffFilingLockSchema.plugin(baseSchemaPlugin, { softDelete: false });

export const TimeOffFilingLockModel = defineModel(
  'TimeOffFilingLock',
  timeOffFilingLockSchema,
  'timeOffFilingLocks',
);
