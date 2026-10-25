import { type ClientSession, Types } from 'mongoose';
import { z } from 'zod';
import { connectDb, withTransaction } from '@pulse/db';
import {
  ActionError,
  businessDateField,
  type BusinessDate,
  businessToday,
  type Centavos,
  formatDate,
  formatPeso,
} from '@pulse/core';
import {
  encryptSensitive,
  recordAudit,
  reloadActorAccess,
  snapshotForAudit,
} from '@pulse/core/server';
import {
  firstDayOfMonth,
  isRemittanceAgency,
  isRemittanceMonth,
  REMITTANCE_REPORT_CHANGED_MESSAGE,
  type RemittanceAgency,
  remittanceAmountWarning,
  remittanceAuditLabel,
  type RemittanceMonth,
} from '../../remittance';
import { inputError } from '../input';
import { assertCanRecordRemittancePayments, type TalentActor } from '../policy';
import { instantOf, isDuplicateKey, objectIdOf } from '../shared';
import {
  REMITTANCE_NOTE_MAX_LENGTH,
  REMITTANCE_PAYMENT_RECORD_TYPE,
  REMITTANCE_REASON_MAX_LENGTH,
  REMITTANCE_REFERENCE_MAX_LENGTH,
  REMITTANCE_REPORT_RECORD_TYPE,
  type RemittancePaymentDocument,
  RemittancePaymentModel,
  type RemittanceReportDocument,
  RemittanceReportModel,
} from './model';
import { REMITTANCE_NOT_FOUND, REMITTANCE_REPORT_MISSING } from './service';
import { decryptTotals } from './snapshot';

// Spec: docs/modules/talent.md#employer-contributions-and-remittances-build-step-211 ("Payments",
// "The Fiscal disbursement placeholder"; decisions 391, 392 and 394 in docs/BUILD_PLAN.md),
// SECURITY.md#sensitive-data and SECURITY.md#audit-logging ("Remittances").
//
// - Talent Write and HR, Accounting or the System Administrator, checked here and again in the
//   transaction against the account as it is then.
// - "Record payment" on a `generated` report: the paid date (a Manila day, not in the future, on
//   or after the first of the remittance month), the reference (1–60, plain), the amount (₱0.01 or
//   more, encrypted) and an optional note (up to 300, plain). An amount that isn't the report's
//   amount due answers a warning instead of saving, until "Save anyway". Writing the warning sends
//   the amount due, so a `reveal` on the report (field `amountDue`) is written and committed first
//   (*Assumption*, HANDOFF). Then in one transaction the payment is inserted with the report's
//   `version`, the report moves `generated` → `paid` filtered on that version, and `create` is
//   written on `talent.remittancePayment`. A report regenerated since the page loaded is refused.
// - "Correct payment" inserts an entry superseding the live one, with a reason, audited `update`;
//   "Void payment" inserts a voided entry with a reason, audited `delete`, and moves the report
//   back to `generated`. A payment recorded again after a void supersedes the void. Entries are
//   never edited or deleted.
// - Each payment stores `fiscalDisbursement: { status: 'notRecorded' }` (step 5.8 records it).
// - No audit entry holds the amount: the payment's encrypted amount shows as hidden.

/** The audit reasons of a recorded payment. */
export const REMITTANCE_PAYMENT_RECORDED_REASON = 'Payment recorded';
export const REMITTANCE_PAYMENT_GONE =
  'This payment was changed since the page loaded. Reload the page.';
export const REMITTANCE_NOT_GENERATED =
  'This report is already paid. Correct or void the payment instead.';
export const REMITTANCE_NOT_PAID = 'This report has no live payment to correct or void.';
/** The reveal field written before the amount warning is sent. */
export const REMITTANCE_AMOUNT_DUE_FIELD = 'amountDue';

const referenceField = z
  .string({ error: 'Enter the reference number.' })
  .trim()
  .min(1, 'Enter the reference number.')
  .max(
    REMITTANCE_REFERENCE_MAX_LENGTH,
    `Use at most ${REMITTANCE_REFERENCE_MAX_LENGTH} characters for the reference number.`,
  );
const noteField = z
  .string()
  .trim()
  .max(
    REMITTANCE_NOTE_MAX_LENGTH,
    `Use at most ${REMITTANCE_NOTE_MAX_LENGTH} characters for the note.`,
  )
  .nullish()
  .transform((value) => (value ? value : null));
const reasonField = z
  .string({ error: 'Enter the reason.' })
  .trim()
  .min(1, 'Enter the reason.')
  .max(
    REMITTANCE_REASON_MAX_LENGTH,
    `Use at most ${REMITTANCE_REASON_MAX_LENGTH} characters for the reason.`,
  );
const amountField = z
  .number({ error: 'Enter the amount paid.' })
  .int('Enter the amount in whole centavos.')
  .min(1, 'Enter an amount of ₱0.01 or more.')
  .max(Number.MAX_SAFE_INTEGER, 'The amount is too large.');

const paymentFieldsSchema = z.object({
  paidOn: businessDateField('Enter the paid date.'),
  referenceNumber: referenceField,
  amountCentavos: amountField,
  note: noteField,
});

export interface RemittancePaymentInput {
  agency: unknown;
  month: unknown;
  /** The report's version the page shows. */
  version: unknown;
  paidOn: unknown;
  referenceNumber: unknown;
  amountCentavos: unknown;
  note?: unknown;
  /** "Save anyway": saves an amount other than the amount due. */
  confirmAmount?: unknown;
}

export interface CorrectRemittancePaymentInput extends RemittancePaymentInput {
  /** The live payment the page shows. */
  paymentId: unknown;
  reason: unknown;
}

export interface VoidRemittancePaymentInput {
  agency: unknown;
  month: unknown;
  paymentId: unknown;
  reason: unknown;
}

/** A saved payment, or the amount warning (nothing saved). */
export type RemittancePaymentResult =
  | { status: 'saved'; paymentId: string; reportId: string }
  | { status: 'amountDiffers'; message: string };

type ReportRow = Omit<RemittanceReportDocument, 'rows'> & { totals?: unknown };

function agencyAndMonth(input: { agency: unknown; month: unknown }): {
  agency: RemittanceAgency;
  month: RemittanceMonth;
} {
  if (!isRemittanceAgency(input.agency) || !isRemittanceMonth(input.month)) {
    throw new ActionError(REMITTANCE_NOT_FOUND);
  }
  return { agency: input.agency, month: input.month };
}

/** The payment's fields checked: the paid date in range, the reference, amount and note. */
function parsedFields(input: RemittancePaymentInput, month: RemittanceMonth) {
  const parsed = paymentFieldsSchema.safeParse({
    paidOn: input.paidOn,
    referenceNumber: input.referenceNumber,
    amountCentavos: input.amountCentavos,
    note: input.note,
  });
  if (!parsed.success) throw inputError(parsed.error.issues);
  const { paidOn } = parsed.data;
  if (paidOn > businessToday()) {
    throw new ActionError('The paid date can’t be in the future.', { field: 'paidOn' });
  }
  if (paidOn < firstDayOfMonth(month)) {
    throw new ActionError(
      `The paid date must be on or after ${formatDate(firstDayOfMonth(month))}, the first day of the remittance month.`,
      { field: 'paidOn' },
    );
  }
  return parsed.data;
}

/** Throws unless `reason` is 1–300 characters; answers it trimmed. */
function parsedReason(reason: unknown): string {
  const parsed = reasonField.safeParse(reason);
  if (!parsed.success) {
    throw inputError(parsed.error.issues.map((issue) => ({ ...issue, path: ['reason'] })));
  }
  return parsed.data;
}

async function loadReport(
  agency: RemittanceAgency,
  month: RemittanceMonth,
): Promise<ReportRow | null> {
  await connectDb();
  return RemittanceReportModel.findOne({ agency, month }).select('+totals').lean<ReportRow>();
}

/**
 * The amount warning when `amount` isn't the report's amount due and "Save anyway" wasn't
 * pressed, or null. Writes and commits a `reveal` (field `amountDue`) before it decrypts.
 */
async function amountWarning(
  actor: TalentActor,
  report: ReportRow,
  amount: Centavos,
  confirmed: boolean,
): Promise<string | null> {
  if (confirmed) return null;
  await recordAudit({
    actorId: actor.id,
    actorEmail: actor.email,
    module: 'talent',
    action: 'reveal',
    record: {
      type: REMITTANCE_REPORT_RECORD_TYPE,
      id: report._id,
      label: remittanceAuditLabel(report.agency, report.month),
    },
    before: null,
    after: null,
    fields: [REMITTANCE_AMOUNT_DUE_FIELD],
  });
  const totals = await decryptTotals(report.totals);
  if (totals.amountDueCentavos === amount) return null;
  return remittanceAmountWarning(formatPeso(amount), formatPeso(totals.amountDueCentavos));
}

/** The latest entry of a report's chain (in `session`), or null. */
async function latestEntry(
  reportId: Types.ObjectId,
  session: ClientSession,
): Promise<Pick<RemittancePaymentDocument, '_id' | 'voided'> | null> {
  return RemittancePaymentModel.findOne({ reportId }, { voided: 1 })
    .sort({ createdAt: -1, _id: -1 })
    .session(session)
    .lean<Pick<RemittancePaymentDocument, '_id' | 'voided'>>();
}

const paymentLabel = (agency: RemittanceAgency, month: RemittanceMonth) =>
  remittanceAuditLabel(agency, month);

/** Inserts one entry in `session` and answers it. */
async function insertEntry(
  fields: Omit<Partial<RemittancePaymentDocument>, 'amountCentavos'> & { amountCentavos?: unknown },
  session: ClientSession,
): Promise<RemittancePaymentDocument> {
  const created = new RemittancePaymentModel(fields);
  await created.save({ session });
  return created.toObject() as RemittancePaymentDocument;
}

/** "Record payment" (see the header). */
export async function recordRemittancePayment(
  actor: TalentActor,
  input: RemittancePaymentInput,
): Promise<RemittancePaymentResult> {
  assertCanRecordRemittancePayments(actor);
  const { agency, month } = agencyAndMonth(input);
  const fields = parsedFields(input, month);
  const version = Number(input.version);
  const report = await loadReport(agency, month);
  if (!report) throw new ActionError(REMITTANCE_REPORT_MISSING);
  if (report.status !== 'generated') throw new ActionError(REMITTANCE_NOT_GENERATED);
  if (!Number.isSafeInteger(version) || report.version !== version) {
    throw new ActionError(REMITTANCE_REPORT_CHANGED_MESSAGE);
  }
  const warning = await amountWarning(
    actor,
    report,
    fields.amountCentavos,
    input.confirmAmount === true,
  );
  if (warning) return { status: 'amountDiffers', message: warning };
  const amount = await encryptSensitive(fields.amountCentavos);

  try {
    return await withTransaction(async (session) => {
      const current = await reloadActorAccess({ id: actor.id }, session);
      assertCanRecordRemittancePayments(current);
      const latest = await latestEntry(report._id, session);
      if (latest && !latest.voided) throw new ActionError(REMITTANCE_NOT_GENERATED);
      const payment = await insertEntry(
        {
          reportId: report._id,
          agency,
          month,
          reportVersion: version,
          paidOn: instantOf(fields.paidOn),
          referenceNumber: fields.referenceNumber,
          amountCentavos: amount,
          note: fields.note,
          supersedesId: latest?._id ?? null,
          voided: false,
          reason: null,
          fiscalDisbursement: { status: 'notRecorded' },
          createdBy: objectIdOf(current.id),
        },
        session,
      );
      const marked = await RemittanceReportModel.updateOne(
        { _id: report._id, status: 'generated', version },
        { $set: { status: 'paid', paymentId: payment._id, updatedBy: objectIdOf(current.id) } },
        { session },
      );
      if (marked.modifiedCount !== 1) throw new ActionError(REMITTANCE_REPORT_CHANGED_MESSAGE);
      await recordAudit(
        {
          actorId: current.id,
          actorEmail: current.email,
          module: 'talent',
          action: 'create',
          record: {
            type: REMITTANCE_PAYMENT_RECORD_TYPE,
            id: payment._id,
            label: paymentLabel(agency, month),
          },
          before: null,
          after: snapshotForAudit(RemittancePaymentModel, payment),
        },
        { session },
      );
      return {
        status: 'saved' as const,
        paymentId: payment._id.toHexString(),
        reportId: report._id.toHexString(),
      };
    });
  } catch (error) {
    // Another payment for the report committed first.
    if (isDuplicateKey(error)) throw new ActionError(REMITTANCE_REPORT_CHANGED_MESSAGE);
    throw error;
  }
}

/** The live payment of a paid report, checked to be `paymentId`. */
function assertLive(report: ReportRow, paymentId: unknown): Types.ObjectId {
  if (report.status !== 'paid' || !report.paymentId) throw new ActionError(REMITTANCE_NOT_PAID);
  const id = objectIdOf(paymentId);
  if (!id || !id.equals(report.paymentId)) throw new ActionError(REMITTANCE_PAYMENT_GONE);
  return id;
}

/** "Correct payment": an entry superseding the live one, with a reason (audited `update`). */
export async function correctRemittancePayment(
  actor: TalentActor,
  input: CorrectRemittancePaymentInput,
): Promise<RemittancePaymentResult> {
  assertCanRecordRemittancePayments(actor);
  const { agency, month } = agencyAndMonth(input);
  const fields = parsedFields(input, month);
  const reason = parsedReason(input.reason);
  const report = await loadReport(agency, month);
  if (!report) throw new ActionError(REMITTANCE_REPORT_MISSING);
  const liveId = assertLive(report, input.paymentId);
  const warning = await amountWarning(
    actor,
    report,
    fields.amountCentavos,
    input.confirmAmount === true,
  );
  if (warning) return { status: 'amountDiffers', message: warning };
  const amount = await encryptSensitive(fields.amountCentavos);

  try {
    return await withTransaction(async (session) => {
      const current = await reloadActorAccess({ id: actor.id }, session);
      assertCanRecordRemittancePayments(current);
      const live = await RemittancePaymentModel.findById(liveId)
        .select('+amountCentavos')
        .session(session)
        .lean<RemittancePaymentDocument>();
      if (!live || live.voided) throw new ActionError(REMITTANCE_PAYMENT_GONE);
      const entry = await insertEntry(
        {
          reportId: report._id,
          agency,
          month,
          reportVersion: report.version,
          paidOn: instantOf(fields.paidOn),
          referenceNumber: fields.referenceNumber,
          amountCentavos: amount,
          note: fields.note,
          supersedesId: liveId,
          voided: false,
          reason,
          fiscalDisbursement: { status: 'notRecorded' },
          createdBy: objectIdOf(current.id),
        },
        session,
      );
      const moved = await RemittanceReportModel.updateOne(
        { _id: report._id, status: 'paid', paymentId: liveId },
        { $set: { paymentId: entry._id, updatedBy: objectIdOf(current.id) } },
        { session },
      );
      if (moved.modifiedCount !== 1) throw new ActionError(REMITTANCE_PAYMENT_GONE);
      await recordAudit(
        {
          actorId: current.id,
          actorEmail: current.email,
          module: 'talent',
          action: 'update',
          record: {
            type: REMITTANCE_PAYMENT_RECORD_TYPE,
            id: entry._id,
            label: paymentLabel(agency, month),
          },
          before: snapshotForAudit(RemittancePaymentModel, live),
          after: snapshotForAudit(RemittancePaymentModel, entry),
          reason,
        },
        { session },
      );
      return {
        status: 'saved' as const,
        paymentId: entry._id.toHexString(),
        reportId: report._id.toHexString(),
      };
    });
  } catch (error) {
    if (isDuplicateKey(error)) throw new ActionError(REMITTANCE_PAYMENT_GONE);
    throw error;
  }
}

/** "Void payment": a voided entry with a reason (audited `delete`); the report is `generated`. */
export async function voidRemittancePayment(
  actor: TalentActor,
  input: VoidRemittancePaymentInput,
): Promise<{ reportId: string; voidId: string }> {
  assertCanRecordRemittancePayments(actor);
  const { agency, month } = agencyAndMonth(input);
  const reason = parsedReason(input.reason);
  const report = await loadReport(agency, month);
  if (!report) throw new ActionError(REMITTANCE_REPORT_MISSING);
  const liveId = assertLive(report, input.paymentId);

  try {
    return await withTransaction(async (session) => {
      const current = await reloadActorAccess({ id: actor.id }, session);
      assertCanRecordRemittancePayments(current);
      const live = await RemittancePaymentModel.findById(liveId)
        .session(session)
        .lean<RemittancePaymentDocument>();
      if (!live || live.voided) throw new ActionError(REMITTANCE_PAYMENT_GONE);
      const entry = await insertEntry(
        {
          reportId: report._id,
          agency,
          month,
          reportVersion: report.version,
          paidOn: live.paidOn,
          referenceNumber: live.referenceNumber,
          note: null,
          supersedesId: liveId,
          voided: true,
          reason,
          fiscalDisbursement: { status: 'notRecorded' },
          createdBy: objectIdOf(current.id),
        },
        session,
      );
      const moved = await RemittanceReportModel.updateOne(
        { _id: report._id, status: 'paid', paymentId: liveId },
        { $set: { status: 'generated', paymentId: null, updatedBy: objectIdOf(current.id) } },
        { session },
      );
      if (moved.modifiedCount !== 1) throw new ActionError(REMITTANCE_PAYMENT_GONE);
      await recordAudit(
        {
          actorId: current.id,
          actorEmail: current.email,
          module: 'talent',
          action: 'delete',
          record: {
            type: REMITTANCE_PAYMENT_RECORD_TYPE,
            id: liveId,
            label: paymentLabel(agency, month),
          },
          before: snapshotForAudit(RemittancePaymentModel, live),
          after: null,
          reason,
        },
        { session },
      );
      return { reportId: report._id.toHexString(), voidId: entry._id.toHexString() };
    });
  } catch (error) {
    if (isDuplicateKey(error)) throw new ActionError(REMITTANCE_PAYMENT_GONE);
    throw error;
  }
}

export type { BusinessDate };
