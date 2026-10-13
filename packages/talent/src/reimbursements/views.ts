import type { BusinessDate } from '@pulse/core';
import type { OverLimit } from './limits';
import type { ReimbursementLimit } from './schemas';

// Spec: docs/modules/talent.md#reimbursements-build-step-25 ("No duplicates", "Check a receipt",
// "Screens"; decisions 241–245, 250 and 252 in docs/BUILD_PLAN.md) — what the reimbursement and
// receipt services send to the pages, and their fixed messages. Types and names only, safe in the
// browser. Amounts are whole centavos; the page formats them with `formatPeso`.

/** A reimbursement line's audit record type and file owner type. */
export const REIMBURSEMENT_TYPE = 'talent.reimbursement';
/** Petty cash vouchers' claim type in the register (from build step 5.11). */
export const PETTY_CASH_VOUCHER_CLAIM_TYPE = 'fiscal.pettyCashVoucher';
/** The claim types of the `receiptClaims` register. */
export const RECEIPT_CLAIM_TYPES = [REIMBURSEMENT_TYPE, PETTY_CASH_VOUCHER_CLAIM_TYPE] as const;
export type ReceiptClaimType = (typeof RECEIPT_CLAIM_TYPES)[number];

/** A duplicate claimed by anyone else (a voucher included). Never names the other claimant. */
export const RECEIPT_ALREADY_CLAIMED =
  'This receipt has already been claimed. Each receipt can be claimed once. Ask HR if you think this is wrong.';
/** A duplicate of the employee's own earlier line: `<date>` formatted, `<type>` the type name. */
export function ownReceiptClaimMessage(date: string, typeName: string): string {
  return `You already claimed this receipt on ${date} (${typeName}).`;
}
/** The stale-save refusal. */
export const STALE_REIMBURSEMENT_MESSAGE =
  'Someone else changed this reimbursement. Reload to see it.';
/** A line that isn't the employee's own, or is gone. */
export const REIMBURSEMENT_NOT_FOUND = 'This reimbursement can’t be found. Reload to see it.';
/** A save with no receipt photo or file. */
export const RECEIPT_REQUIRED = 'Take a photo of the receipt or choose a file.';
/** The client field's footer. */
export const CLIENT_TRACKING_NOTE =
  'For tracking only. Reimbursements are never billed to the client.';
/** The receipt picker's label. */
export const RECEIPT_PICKER_LABEL = 'Take a photo or choose a file';
/** The empty segment. */
export const NO_REIMBURSEMENTS = 'No reimbursements yet';
/** "Check a receipt" with no live claim. */
export const RECEIPT_NOT_CLAIMED = 'Nobody has claimed this receipt.';

/** A canonical 14-digit merchant TIN as `000-000-000-00000`. Anything else is returned as is. */
export function formatMerchantTin(canonical: string): string {
  return /^\d{14}$/.test(canonical)
    ? `${canonical.slice(0, 3)}-${canonical.slice(3, 6)}-${canonical.slice(6, 9)}-${canonical.slice(9)}`
    : canonical;
}

/** "Receipts dated <from> – <to>" on the sheet. */
export function filingWindowNote(from: string, to: string): string {
  return `Receipts dated ${from} – ${to}`;
}

/** A type the sheet offers (from the version in effect today). */
export interface ReimbursementTypeOption {
  key: string;
  name: string;
  /** An inactive type can't be chosen for a new line, or changed to. */
  active: boolean;
  requiresRoute: boolean;
  requiresDescription: boolean;
  requiresClient: boolean;
  limit: ReimbursementLimit | null;
}

/** The receipt of a line: open it through the file route. */
export interface ReimbursementReceiptView {
  /** `/files/<id>`. */
  url: string;
  /** `/files/<id>?inline=1`, for the thumbnail (an image only). */
  inlineUrl: string;
  /** A PDF shows a PDF icon instead of a thumbnail. */
  isPdf: boolean;
}

/** One reimbursement line. */
export interface ReimbursementLineView {
  id: string;
  receiptDate: BusinessDate;
  typeKey: string;
  /** The type's name in the version in effect on the receipt date (the key when it's missing). */
  typeName: string;
  merchant: string;
  /** The canonical 14 digits; show with `formatMerchantTin`. */
  merchantTin: string;
  /** As typed. */
  receiptNumber: string;
  amountCentavos: number;
  /** A retired client shows as "Removed client". */
  client: { id: string; name: string } | null;
  pickUp: string | null;
  dropOff: string | null;
  description: string | null;
  receipt: ReimbursementReceiptView;
  /** Highlighted ("Over limit"), never refused. */
  overLimit: OverLimit | null;
  /** Sent back with every save; a stale one is refused. */
  version: number;
}

/** The lines of one receipt date. */
export interface ReimbursementDayGroup {
  receiptDate: BusinessDate;
  lines: ReimbursementLineView[];
}

/** The Reimbursements segment of a timesheet. */
export interface ReimbursementsSectionView {
  /** Grouped by receipt date, newest first; within a day, newest first. */
  groups: ReimbursementDayGroup[];
  /** The footer: "Reimbursements ₱1,234.50 · 3 receipts". */
  totalCentavos: number;
  count: number;
  /** "Add reimbursement": the own open timesheet within the filing window. */
  canAdd: boolean;
  /** The own open timesheet: each line opens the sheet to edit; otherwise read-only. */
  canEdit: boolean;
  /**
   * Own timesheet only: the receipt dates this timesheet takes ("Receipts dated <from> – <to>").
   * Null on another person's timesheet, or when no day is open for receipts.
   */
  window: { from: BusinessDate; to: BusinessDate } | null;
  /** Own timesheet only: the types of the version in effect today. */
  types?: ReimbursementTypeOption[];
}

/** What a line save returns. */
export interface ReimbursementSaveResult {
  id: string;
  version: number;
  /** The saved line is over its limit (it still saved). */
  overLimit: OverLimit | null;
}

/** "Check a receipt": the live claim of a receipt, for Talent Read. */
export type ReceiptCheckView =
  | {
      kind: 'reimbursement';
      merchantTin: string;
      receiptKey: string;
      claimant: { employeeId: string; name: string; employeeNumber: string };
      receiptDate: BusinessDate;
      typeKey: string;
      typeName: string;
      amountCentavos: number;
      /** `/talent/timesheets/<employeeId>?cutOff=<period start>`. */
      timesheetHref: string;
      claimedAt: Date;
    }
  | {
      /** From build step 5.11: shown as "Petty cash voucher". */
      kind: 'pettyCashVoucher';
      merchantTin: string;
      receiptKey: string;
      claimedAt: Date;
    };
