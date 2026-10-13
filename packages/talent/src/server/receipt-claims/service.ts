import type { ClientSession, Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { ActionError, formatDate, TIN_HELP } from '@pulse/core';
import { getEmployeeIdentity } from '@pulse/core/server';
import { type CheckReceiptInput, checkReceiptSchema } from '../../reimbursements/inputs';
import {
  canonicalMerchantTin,
  RECEIPT_NUMBER_NO_KEY_MESSAGE,
  receiptKey,
} from '../../reimbursements/receipt-key';
import { reimbursementTypeOf } from '../../reimbursements/schemas';
import {
  ownReceiptClaimMessage,
  RECEIPT_ALREADY_CLAIMED,
  REIMBURSEMENT_TYPE,
  type ReceiptCheckView,
  type ReceiptClaimType,
} from '../../reimbursements/views';
import { inputError } from '../input';
import { payrollSettingVersionOn } from '../payroll-settings/settings';
import { assertCanReadEmployeeRecords, type TalentActor } from '../policy';
import { type ReimbursementDocument, ReimbursementModel } from '../reimbursements/model';
import { dayOf, isDuplicateKey, objectIdOf } from '../shared';
import { type TimesheetDocument, TimesheetModel } from '../timesheets/model';
import { type ReceiptClaimDocument, ReceiptClaimModel } from './model';

// Spec: docs/modules/talent.md#reimbursements-build-step-25 ("No duplicates", "Check a receipt")
// and docs/ARCHITECTURE.md#cross-module-integration (decisions 241–245 in docs/BUILD_PLAN.md) —
// Talent's register of claimed receipts. Pulse Fiscal's petty cash vouchers call the same two
// services from step 5.11 (claim type `fiscal.pettyCashVoucher`), so a receipt is claimed once
// across reimbursements and vouchers.
//
// - `claimReceipt` and `releaseReceiptClaim` run in the caller's transaction (a session is
//   required) and write nothing else: no audit entry of their own, since the caller's record
//   snapshot holds the TIN and number.
// - Atomic: the unique index on the canonical TIN and the receipt key among live claims makes the
//   second of two saves at once fail (a write conflict the caller's transaction retries, after
//   which the check below sees the winner; or a duplicate key error, refused the same way).
// - The refusal never names the other claimant. The employee's own earlier line reads "You
//   already claimed this receipt on <date> (<type>)."

/** The two halves of the duplicate key, normalized. */
export interface ReceiptKeyParts {
  /** The canonical 14 digits. */
  merchantTin: string;
  receiptKey: string;
}

/** The register's key of a receipt as typed; refuses a bad TIN or a number with no key. */
export function receiptKeyPartsOf(merchantTin: string, receiptNumber: string): ReceiptKeyParts {
  const tin = canonicalMerchantTin(merchantTin);
  if (!tin) throw new ActionError(TIN_HELP, { field: 'merchantTin' });
  const key = receiptKey(receiptNumber);
  if (!key) throw new ActionError(RECEIPT_NUMBER_NO_KEY_MESSAGE, { field: 'receiptNumber' });
  return { merchantTin: tin, receiptKey: key };
}

export interface ClaimReceiptInput {
  /** As typed (dashes and spaces fine) or already canonical. */
  merchantTin: string;
  /** As typed. */
  receiptNumber: string;
  claimType: ReceiptClaimType;
  /** The claiming record's id: the reimbursement line, or the voucher. */
  claimId: Types.ObjectId | string;
  /** The employee, for a reimbursement; null for a voucher. */
  employeeId: Types.ObjectId | string | null;
}

export interface ReceiptClaimOptions {
  /** The caller's transaction. Required: the claim commits or rolls back with the record. */
  session: ClientSession;
  /** The user saving the record; null for the system. */
  actorId: Types.ObjectId | string | null;
}

export interface ReceiptClaim extends ReceiptKeyParts {
  /** The register entry's id (a reimbursement line stores it as `receiptClaimId`). */
  id: string;
}

function idOf(value: Types.ObjectId | string | null, what: string): Types.ObjectId | null {
  if (value === null) return null;
  const id = objectIdOf(value);
  if (!id) throw new Error(`${what} is not a valid id.`);
  return id;
}

function assertSession(session: ClientSession | undefined): asserts session is ClientSession {
  if (!session?.inTransaction()) {
    throw new Error('Receipt claims are written only in the caller’s transaction.');
  }
}

/** The live claim of a receipt, if any. */
async function liveClaimOf(
  parts: ReceiptKeyParts,
  session?: ClientSession,
): Promise<ReceiptClaimDocument | null> {
  return ReceiptClaimModel.findOne({
    merchantTin: parts.merchantTin,
    receiptKey: parts.receiptKey,
  })
    .session(session ?? null)
    .lean<ReceiptClaimDocument>();
}

/** The type's name in the version in effect on `day`, or the key when it isn't there. */
async function typeNameOn(
  typeKey: string,
  receiptDate: Date,
  session?: ClientSession,
): Promise<string> {
  const version = await payrollSettingVersionOn('talent.reimbursementSettings', receiptDate, {
    session,
  });
  return reimbursementTypeOf(version?.value, typeKey)?.name ?? typeKey;
}

/** The refusal of a receipt `existing` already claims, for the claim `input` asks for. */
async function duplicateRefusal(
  existing: ReceiptClaimDocument,
  employeeId: Types.ObjectId | null,
  session?: ClientSession,
): Promise<ActionError> {
  if (
    employeeId &&
    existing.claimType === REIMBURSEMENT_TYPE &&
    existing.employeeId?.equals(employeeId)
  ) {
    const line = await ReimbursementModel.findOne(
      { _id: existing.claimId, employeeId },
      { receiptDate: 1, typeKey: 1 },
    )
      .session(session ?? null)
      .lean<Pick<ReimbursementDocument, '_id' | 'receiptDate' | 'typeKey'>>();
    if (line) {
      const typeName = await typeNameOn(line.typeKey, line.receiptDate, session);
      return new ActionError(ownReceiptClaimMessage(formatDate(line.receiptDate), typeName), {
        field: 'receiptNumber',
      });
    }
  }
  return new ActionError(RECEIPT_ALREADY_CLAIMED, { field: 'receiptNumber' });
}

/**
 * Refuses a receipt that is already claimed, before any file is saved: the same check
 * `claimReceipt` makes, with the same messages, outside a transaction. `exceptClaimId` is a
 * claim the caller is about to release (an edit that changes the receipt).
 */
export async function assertReceiptNotClaimed(
  parts: ReceiptKeyParts,
  employeeId: Types.ObjectId | string | null,
  { exceptClaimId = null }: { exceptClaimId?: Types.ObjectId | null } = {},
): Promise<void> {
  await connectDb();
  const existing = await liveClaimOf(parts);
  if (!existing || (exceptClaimId && existing._id.equals(exceptClaimId))) return;
  throw await duplicateRefusal(existing, idOf(employeeId, 'The employee id'));
}

/**
 * Claims a receipt in the register, in the caller's transaction. Throws {@link ActionError} on
 * `receiptNumber` when the receipt is already claimed (by anyone, a voucher included): "You
 * already claimed this receipt on <date> (<type>)." for the same employee's earlier line, and
 * otherwise a message that never names the claimant. A bad TIN or a number with no key is
 * refused too. Exactly one of two claims of one receipt at once saves.
 */
export async function claimReceipt(
  input: ClaimReceiptInput,
  { session, actorId }: ReceiptClaimOptions,
): Promise<ReceiptClaim> {
  assertSession(session);
  const parts = receiptKeyPartsOf(input.merchantTin, input.receiptNumber);
  const claimId = idOf(input.claimId, 'The claim id');
  const employeeId = idOf(input.employeeId, 'The employee id');
  const actor = idOf(actorId, 'The actor id');

  const existing = await liveClaimOf(parts, session);
  if (existing) throw await duplicateRefusal(existing, employeeId, session);

  const claim = new ReceiptClaimModel({
    ...parts,
    claimType: input.claimType,
    claimId,
    employeeId,
    createdBy: actor,
    updatedBy: actor,
  });
  try {
    await claim.save({ session });
  } catch (error) {
    // A claim committed by another transaction since this one's snapshot. The transaction is
    // aborted, so nothing more can be read in it: refuse without naming anyone.
    if (isDuplicateKey(error)) {
      throw new ActionError(RECEIPT_ALREADY_CLAIMED, { field: 'receiptNumber' });
    }
    throw error;
  }
  return { id: claim._id.toHexString(), ...parts };
}

export interface ReleaseReceiptClaimInput {
  claimType: ReceiptClaimType;
  /** The claiming record's id. */
  claimId: Types.ObjectId | string;
}

/**
 * Releases the live claim of a record (`claimType` and `claimId`), in the caller's transaction,
 * so the receipt can be claimed again: a soft delete. True when a claim was released; false when
 * the record had none.
 */
export async function releaseReceiptClaim(
  input: ReleaseReceiptClaimInput,
  { session, actorId }: ReceiptClaimOptions,
): Promise<boolean> {
  assertSession(session);
  const claimId = idOf(input.claimId, 'The claim id');
  const actor = idOf(actorId, 'The actor id');
  const result = await ReceiptClaimModel.updateOne(
    { claimType: input.claimType, claimId, deletedAt: null },
    { $set: { deletedAt: new Date(), updatedBy: actor } },
    { session },
  );
  return result.modifiedCount > 0;
}

// ---------------------------------------------------------------------------------------------
// "Check a receipt"

/**
 * "Check a receipt" on `/talent`: the live claim of a merchant TIN and receipt number, with the
 * claimant's name and employee number, the receipt date, type and amount, and a link to the
 * timesheet; a voucher's claim shows as a petty cash voucher (step 5.11). Null when nobody has
 * claimed it. Talent Read only; anyone else gets {@link AccessDeniedError}. Not audit-logged:
 * nothing here is sensitive.
 */
export async function checkReceipt(
  actor: TalentActor,
  input: CheckReceiptInput,
): Promise<ReceiptCheckView | null> {
  assertCanReadEmployeeRecords(actor);
  const parsed = checkReceiptSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const parts = receiptKeyPartsOf(parsed.data.merchantTin, parsed.data.receiptNumber);
  await connectDb();
  const claim = await liveClaimOf(parts);
  if (!claim) return null;
  if (claim.claimType !== REIMBURSEMENT_TYPE) {
    return { kind: 'pettyCashVoucher', ...parts, claimedAt: claim.createdAt };
  }
  const line = await ReimbursementModel.findOne({
    _id: claim.claimId,
  }).lean<ReimbursementDocument>();
  if (!line) return null;
  const [identity, timesheet, typeName] = await Promise.all([
    getEmployeeIdentity(actor, line.employeeId.toHexString(), { separated: true }),
    TimesheetModel.findById(line.timesheetId, {
      periodStart: 1,
    }).lean<Pick<TimesheetDocument, '_id' | 'periodStart'>>(),
    typeNameOn(line.typeKey, line.receiptDate),
  ]);
  if (!identity) return null;
  const employeeId = line.employeeId.toHexString();
  return {
    kind: 'reimbursement',
    ...parts,
    claimant: {
      employeeId,
      name: `${identity.firstName} ${identity.lastName}`,
      employeeNumber: identity.employeeNumber,
    },
    receiptDate: dayOf(line.receiptDate),
    typeKey: line.typeKey,
    typeName,
    amountCentavos: line.amountCentavos,
    timesheetHref: timesheet
      ? `/talent/timesheets/${employeeId}?cutOff=${dayOf(timesheet.periodStart)}`
      : `/talent/timesheets/${employeeId}`,
    claimedAt: claim.createdAt,
  };
}
