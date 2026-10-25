import { decryptSensitive, encryptSensitive, type EncryptedValue } from '@pulse/core/server';
import {
  REMITTANCE_ROWS_VERSION,
  type RemittanceRow,
  type RemittanceRowsDocument,
  type RemittanceSnapshot,
  type RemittanceTotals,
} from '../../remittance';
import { dayOf } from '../shared';
import type { RemittanceReportDocument } from './model';

// Spec: docs/DATA_MODEL.md#collection-ownership (`remittanceReports.rows` and `totals`) and
// SECURITY.md#sensitive-data ("Remittances") — a report's snapshot to and from its encrypted
// form: `rows` is one JSON string with `rowsVersion` 1, `totals` another. Only the services that
// export or reveal a report decrypt it, after its audit entry; never log what comes back.

/** Thrown when a stored snapshot can't be read. The message never includes it. */
export class RemittanceSnapshotError extends Error {
  constructor() {
    super('A stored remittance report snapshot is not in a form this version can read.');
    this.name = 'RemittanceSnapshotError';
  }
}

export async function encryptRows(rows: readonly RemittanceRow[]): Promise<EncryptedValue> {
  const document: RemittanceRowsDocument = {
    rowsVersion: REMITTANCE_ROWS_VERSION,
    rows: [...rows],
  };
  return encryptSensitive(JSON.stringify(document));
}

export async function encryptTotals(totals: RemittanceTotals): Promise<EncryptedValue> {
  return encryptSensitive(JSON.stringify(totals));
}

async function decryptJson(value: unknown): Promise<unknown> {
  const text = await decryptSensitive(value);
  if (typeof text !== 'string') throw new RemittanceSnapshotError();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RemittanceSnapshotError();
  }
}

export async function decryptRows(value: unknown): Promise<RemittanceRow[]> {
  const parsed = (await decryptJson(value)) as Partial<RemittanceRowsDocument> | null;
  if (!parsed || parsed.rowsVersion !== REMITTANCE_ROWS_VERSION || !Array.isArray(parsed.rows)) {
    throw new RemittanceSnapshotError();
  }
  return parsed.rows;
}

export async function decryptTotals(value: unknown): Promise<RemittanceTotals> {
  const parsed = (await decryptJson(value)) as RemittanceTotals | null;
  if (!parsed || typeof parsed.amountDueCentavos !== 'number') throw new RemittanceSnapshotError();
  return parsed;
}

/** A stored report with its `rows` and `totals` selected, as the exports render it. */
export async function snapshotOfReport(
  report: Pick<
    RemittanceReportDocument,
    'agency' | 'month' | 'employer' | 'dueDate' | 'goLiveNote' | 'rows' | 'totals'
  >,
): Promise<RemittanceSnapshot> {
  const [rows, totals] = await Promise.all([
    decryptRows(report.rows),
    decryptTotals(report.totals),
  ]);
  return {
    agency: report.agency,
    month: report.month,
    rows,
    totals,
    employer: {
      registeredName: report.employer.registeredName,
      businessAddress: report.employer.businessAddress,
      tin: report.employer.tin,
      rdoCode: report.employer.rdoCode,
      employerNumber: report.employer.employerNumber,
      placeholder: report.employer.placeholder,
    },
    dueDate: dayOf(report.dueDate),
    goLivePeriods: report.goLiveNote,
  };
}
