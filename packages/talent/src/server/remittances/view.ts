import { connectDb } from '@pulse/db';
import { type Centavos, formatPeso } from '@pulse/core';
import { decryptSensitive, recordAudit } from '@pulse/core/server';
import {
  isRemittanceAgency,
  isRemittanceMonth,
  maskedIdText,
  REMITTANCE_DIFFERS_LABEL,
  type RemittanceAgency,
  remittanceAuditLabel,
  remittanceMissingIdText,
  type RemittanceMonth,
  type RemittanceRow,
  type RemittanceTotals,
  remittanceUnverifiedIdText,
} from '../../remittance';
import { assertCanSeeRemittances, type TalentActor } from '../policy';
import { bir1601cItemLines } from './exports';
import {
  REMITTANCE_PAYMENT_AMOUNT_SELECT,
  REMITTANCE_REPORT_RECORD_TYPE,
  REMITTANCE_REPORT_SNAPSHOT_SELECT,
  type RemittancePaymentDocument,
  RemittancePaymentModel,
  type RemittanceReportDocument,
  RemittanceReportModel,
} from './model';
import { decryptRows, decryptTotals } from './snapshot';

// Spec: docs/modules/talent.md#employer-contributions-and-remittances-build-step-211 ("Who may see
// and what": "Show amounts"; decision 395 in docs/BUILD_PLAN.md) and SECURITY.md#sensitive-data
// ("Remittances") — "Show amounts" on a report: Talent Read and HR, Accounting or the System
// Administrator. A `reveal` on `talent.remittanceReport` (field `amounts`, labelled `<agency> ·
// <YYYY-MM>`) is written and committed before anything is decrypted, on every press; if it can't
// be written, nothing is sent. The rows then show each ID's last 4 digits only (full IDs appear
// only in the exports), and no date of birth. The amounts last one page view.

export const REMITTANCE_AMOUNTS_FIELD = 'amounts';

/** One person's row after "Show amounts": the amounts, the ID's last 4 digits, the flags. */
export interface RemittanceAmountRow extends Omit<
  RemittanceRow,
  'idNumber' | 'dateOfBirth' | 'sex'
> {
  /** "Payee1, Test Made". */
  name: string;
  /** "••••5432", or null when not on file. */
  maskedId: string | null;
  /** The flags and new hire or separated status in words. */
  notes: string[];
}

export interface RemittanceAmountsView {
  /** The report's version the amounts belong to; the page drops them when it changes. */
  version: number;
  totals: RemittanceTotals;
  rows: RemittanceAmountRow[];
  /** BIR 1601-C only: items 14–25 with their labels (else empty). */
  birItems: { item: string; description: string; amountCentavos: Centavos }[];
  /** "Item 22 differs from the runs' taxable compensation by ₱X", or null. */
  item22Difference: string | null;
  /** Each payment entry's amount (voids have none). */
  payments: { id: string; amountCentavos: Centavos }[];
}

function rowNotes(agency: RemittanceAgency, row: RemittanceRow): string[] {
  const notes: string[] = [];
  if (row.status === 'newHire') notes.push('New hire');
  if (row.status === 'separated') notes.push('Separated');
  if (row.flags.differsFromSchedule) notes.push(REMITTANCE_DIFFERS_LABEL);
  if (row.flags.missingId) notes.push(remittanceMissingIdText(agency));
  if (row.flags.unverifiedId) notes.push(remittanceUnverifiedIdText(agency));
  return notes;
}

/** A row for the page: the ID's last 4 digits, no date of birth or sex. */
function amountRowOf(agency: RemittanceAgency, row: RemittanceRow): RemittanceAmountRow {
  const { idNumber, ...rest } = row;
  const page: Partial<RemittanceRow> = { ...rest };
  delete page.dateOfBirth;
  delete page.sex;
  return {
    ...(page as Omit<RemittanceRow, 'idNumber' | 'dateOfBirth' | 'sex'>),
    name: `${row.lastName}, ${row.firstName}${row.middleName ? ` ${row.middleName}` : ''}`,
    maskedId: maskedIdText(idNumber),
    notes: rowNotes(agency, row),
  };
}

/**
 * "Show amounts" on `agency`'s report for `month` (see the header). Null when there is no report.
 */
export async function showRemittanceAmounts(
  actor: TalentActor,
  input: { agency: unknown; month: unknown },
): Promise<RemittanceAmountsView | null> {
  assertCanSeeRemittances(actor);
  const { agency, month } = input;
  if (!isRemittanceAgency(agency) || !isRemittanceMonth(month)) return null;
  await connectDb();
  const report = await RemittanceReportModel.findOne({ agency, month }, { version: 1 }).lean<
    Pick<RemittanceReportDocument, '_id' | 'version'>
  >();
  if (!report) return null;
  await recordAudit({
    actorId: actor.id,
    actorEmail: actor.email,
    module: 'talent',
    action: 'reveal',
    record: {
      type: REMITTANCE_REPORT_RECORD_TYPE,
      id: report._id,
      label: remittanceAuditLabel(agency, month as RemittanceMonth),
    },
    before: null,
    after: null,
    fields: [REMITTANCE_AMOUNTS_FIELD],
  });
  const [full, payments] = await Promise.all([
    RemittanceReportModel.findById(report._id)
      .select(REMITTANCE_REPORT_SNAPSHOT_SELECT)
      .lean<RemittanceReportDocument>(),
    RemittancePaymentModel.find({ reportId: report._id }, { voided: 1 })
      .select(REMITTANCE_PAYMENT_AMOUNT_SELECT)
      .lean<Pick<RemittancePaymentDocument, '_id' | 'voided' | 'amountCentavos'>[]>(),
  ]);
  if (!full) return null;
  const [rows, totals] = await Promise.all([decryptRows(full.rows), decryptTotals(full.totals)]);
  const amounts: { id: string; amountCentavos: Centavos }[] = [];
  for (const payment of payments) {
    if (payment.voided || payment.amountCentavos === undefined) continue;
    const value = await decryptSensitive(payment.amountCentavos);
    if (typeof value !== 'number') throw new Error('A stored remittance amount is not centavos.');
    amounts.push({ id: payment._id.toHexString(), amountCentavos: value });
  }
  const items = totals.bir;
  return {
    version: full.version,
    totals,
    rows: rows.map((row) => amountRowOf(agency, row)),
    birItems: items ? bir1601cItemLines(items) : [],
    item22Difference:
      items && items.item22DifferenceCentavos !== 0
        ? `Item 22 differs from the runs’ taxable compensation by ${formatPeso(items.item22DifferenceCentavos)}.`
        : null,
    payments: amounts,
  };
}
