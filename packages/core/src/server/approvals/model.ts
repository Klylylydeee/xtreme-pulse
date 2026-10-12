import { Schema, type Types } from 'mongoose';
import { baseSchemaPlugin, defineModel } from '@pulse/db';
import {
  APPROVAL_DECISIONS,
  APPROVAL_REMARKS_MAX_LENGTH,
  APPROVAL_STATUSES,
  APPROVAL_STEP_KINDS,
  APPROVAL_STEP_RULES,
  APPROVAL_STEP_STATUSES,
  APPROVAL_SUMMARY_MAX_LENGTH,
  APPROVAL_TITLE_MAX_LENGTH,
  type ApprovalDecision,
  type ApprovalStatus,
  type ApprovalStepKind,
  type ApprovalStepRule,
  type ApprovalStepStatus,
} from '../../approvals';
import {
  AUDIT_LABEL_MAX_LENGTH,
  AUDIT_MODULES,
  type AuditModule,
  RECORD_TYPE_MAX_LENGTH,
  RECORD_TYPE_PATTERN,
} from '../../audit';
import { isInternalHref } from '../../notifications';
import { guardWrites } from '../write-guards';

// Spec: docs/modules/core.md#approvals and docs/DATA_MODEL.md#collection-ownership (decision 99 in
// docs/BUILD_PLAN.md) — one approval request per submission. Written only by the approvals engine
// (./service.ts) and never deleted, so no soft delete and no delete path. Private to the engine:
// modules go through `submitApproval()` and their registered hooks, never this model.
//
// - Each step's approvers are fixed at submit (./routing.ts) and never change.
// - `pendingApproverIds` (who may decide now), `approverIds` (everyone who has been asked: the
//   approvers of each step once it became pending) and `decidedFor` (whose part in a step ended,
//   and when: the decider and everyone the decision took the item from) are kept in step with
//   `steps` by the engine, for the lists and `isApproverFor`.
// - `version` goes up on every decision; a decision names the version it saw, so overlapping
//   decisions and stale forms are refused.
// - A partial unique index allows one pending request per record.

/** The pattern of an approval type name: `<module>.<name>`, like `talent.leave` or `dev.sample`. */
export const APPROVAL_TYPE_PATTERN = RECORD_TYPE_PATTERN;

export interface ApprovalApproverRecord {
  userId: Types.ObjectId;
  /** The approver's name as it was at submit. */
  nameSnapshot: string;
  /**
   * True when this approver was added as a System Administrator: every approver of a step routed
   * to the System Administrator, and those filling the requester's place in an all-of step.
   */
  asSystemAdministrator: boolean;
}

/** The e-signature an approve decision was signed with (build step 2.2). */
export interface ApprovalSignatureRecord {
  applicationId: Types.ObjectId;
  signatureId: Types.ObjectId;
  version: number;
}

export interface ApprovalDecisionRecord {
  userId: Types.ObjectId;
  decision: ApprovalDecision;
  remarks: string | null;
  decidedAt: Date;
  /**
   * Set on an approve decision when an e-signature was applied; null otherwise (return, reject,
   * an approver with no signature on file, and decisions made before build step 2.2, which have
   * no field at all).
   */
  signature?: ApprovalSignatureRecord | null;
}

/** An approver's part in a step ended: they decided, or a decision took the item from them. */
export interface ApprovalDecidedForRecord {
  userId: Types.ObjectId;
  decidedAt: Date;
}

export interface ApprovalStepRecord {
  kind: ApprovalStepKind;
  label: string;
  rule: ApprovalStepRule;
  approvers: ApprovalApproverRecord[];
  routedToSystemAdministrator: boolean;
  status: ApprovalStepStatus;
  decisions: ApprovalDecisionRecord[];
}

export interface ApprovalRequestRecord {
  _id: Types.ObjectId;
  /** The registered approval type, `<module>.<name>`. */
  type: string;
  module: AuditModule;
  record: { type: string; id: Types.ObjectId; label: string };
  title: string;
  summary: string | null;
  /** The record's page, a path inside the app. */
  href: string;
  requesterUserId: Types.ObjectId;
  /** Null for the bootstrap system account, which has no employee. */
  requesterEmployeeId: Types.ObjectId | null;
  status: ApprovalStatus;
  /** The index of the pending step; once settled, of the step that settled it. */
  currentStep: number;
  /** The returned or rejected request this one resubmits. */
  previousRequestId: Types.ObjectId | null;
  submittedAt: Date;
  settledAt: Date | null;
  /** Who made the deciding decision; null while pending, or when every step was skipped. */
  settledBy: Types.ObjectId | null;
  version: number;
  steps: ApprovalStepRecord[];
  pendingApproverIds: Types.ObjectId[];
  approverIds: Types.ObjectId[];
  /** The Decided list: one entry per approver per decision that ended their part in a step. */
  decidedFor: ApprovalDecidedForRecord[];
  createdAt: Date;
  updatedAt: Date;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
}

const approverSchema = new Schema<ApprovalApproverRecord>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    nameSnapshot: { type: String, required: true, maxlength: 200 },
    asSystemAdministrator: { type: Boolean, required: true, default: false },
  },
  { _id: false },
);

const signatureSchema = new Schema<ApprovalSignatureRecord>(
  {
    applicationId: { type: Schema.Types.ObjectId, required: true },
    signatureId: { type: Schema.Types.ObjectId, required: true },
    version: { type: Number, required: true, min: 1 },
  },
  { _id: false },
);

const decisionSchema = new Schema<ApprovalDecisionRecord>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    decision: { type: String, required: true, enum: APPROVAL_DECISIONS },
    remarks: { type: String, default: null, maxlength: APPROVAL_REMARKS_MAX_LENGTH },
    decidedAt: { type: Date, required: true },
    signature: { type: signatureSchema, default: null },
  },
  { _id: false },
);

const decidedForSchema = new Schema<ApprovalDecidedForRecord>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    decidedAt: { type: Date, required: true },
  },
  { _id: false },
);

const stepSchema = new Schema<ApprovalStepRecord>(
  {
    kind: { type: String, required: true, enum: APPROVAL_STEP_KINDS },
    label: { type: String, required: true, maxlength: 100 },
    rule: { type: String, required: true, enum: APPROVAL_STEP_RULES },
    approvers: { type: [approverSchema], default: [] },
    routedToSystemAdministrator: { type: Boolean, required: true, default: false },
    status: { type: String, required: true, enum: APPROVAL_STEP_STATUSES },
    decisions: { type: [decisionSchema], default: [] },
  },
  { _id: false },
);

const approvalRequestSchema = new Schema<ApprovalRequestRecord>({
  type: {
    type: String,
    required: true,
    immutable: true,
    maxlength: RECORD_TYPE_MAX_LENGTH,
    match: APPROVAL_TYPE_PATTERN,
  },
  module: { type: String, required: true, immutable: true, enum: AUDIT_MODULES },
  record: {
    type: new Schema(
      {
        type: {
          type: String,
          required: true,
          maxlength: RECORD_TYPE_MAX_LENGTH,
          match: RECORD_TYPE_PATTERN,
        },
        id: { type: Schema.Types.ObjectId, required: true },
        label: { type: String, required: true, maxlength: AUDIT_LABEL_MAX_LENGTH },
      },
      { _id: false },
    ),
    required: true,
    immutable: true,
  },
  title: { type: String, required: true, immutable: true, maxlength: APPROVAL_TITLE_MAX_LENGTH },
  summary: {
    type: String,
    default: null,
    immutable: true,
    maxlength: APPROVAL_SUMMARY_MAX_LENGTH,
  },
  href: {
    type: String,
    required: true,
    immutable: true,
    validate: {
      validator: isInternalHref,
      message: 'A request links to a page inside the app (a path starting with /).',
    },
  },
  requesterUserId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  requesterEmployeeId: { type: Schema.Types.ObjectId, default: null, immutable: true },
  status: { type: String, required: true, enum: APPROVAL_STATUSES },
  currentStep: { type: Number, required: true, min: 0 },
  previousRequestId: { type: Schema.Types.ObjectId, default: null, immutable: true },
  submittedAt: { type: Date, required: true, immutable: true },
  settledAt: { type: Date, default: null },
  settledBy: { type: Schema.Types.ObjectId, default: null },
  version: { type: Number, required: true, default: 0, min: 0 },
  steps: { type: [stepSchema], required: true },
  pendingApproverIds: { type: [Schema.Types.ObjectId], default: [] },
  approverIds: { type: [Schema.Types.ObjectId], default: [] },
  decidedFor: { type: [decidedForSchema], default: [] },
});

// The Waiting list and its badge, the Decided list, a record's history, the requester's own.
approvalRequestSchema.index({ pendingApproverIds: 1, submittedAt: -1 });
// Decided matches on the user's entries and sorts by the latest one, per user (see the service).
approvalRequestSchema.index({ 'decidedFor.userId': 1 });
approvalRequestSchema.index({ 'record.type': 1, 'record.id': 1, submittedAt: -1 });
approvalRequestSchema.index({ requesterUserId: 1, submittedAt: -1 });
// One pending request per record.
approvalRequestSchema.index(
  { 'record.type': 1, 'record.id': 1 },
  { unique: true, partialFilterExpression: { status: 'pending' }, name: 'onePendingPerRecord' },
);

approvalRequestSchema.plugin(baseSchemaPlugin, { softDelete: false });

// Requests are never deleted or replaced. The engine changes one request at a time with
// `updateOne`, always matching on the version it read.
guardWrites(approvalRequestSchema, {
  message: 'Approval requests are never deleted; only the approvals engine changes them.',
  allowUpdate: (_update, query) => {
    const filter = query.getFilter() as { _id?: unknown; version?: unknown };
    return filter._id !== undefined && typeof filter.version === 'number';
  },
});

export const ApprovalRequestModel = defineModel(
  'ApprovalRequest',
  approvalRequestSchema,
  'approvalRequests',
);
