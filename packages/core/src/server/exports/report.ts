import { assertCentavos, type Centavos, formatPeso, sumCentavos } from '../../money';
import { DISPLAY_LOCALE } from '../../locale';
import { type BusinessDate, formatDate, formatDateTime } from '../../dates';

// One description of a tabular report, rendered to Excel (excel.ts) or PDF (pdf.tsx). Every value
// is formatted with the shared helpers: money with `formatPeso` from integer centavos (never a
// float), dates on Manila time.

export type ReportColumn<Row> = {
  header: string;
  /** Relative width (Excel characters; PDF flex share). */
  width?: number;
} & (
  | { kind: 'text'; value: (row: Row) => string }
  | { kind: 'integer'; value: (row: Row) => number }
  /** An amount in integer centavos. `total` adds it up in a total row. */
  | { kind: 'peso'; value: (row: Row) => Centavos; total?: boolean }
  /** A business date (`YYYY-MM-DD`) or an instant, shown as a Manila date. */
  | { kind: 'date'; value: (row: Row) => BusinessDate | Date }
);

export interface Report<Row> {
  title: string;
  subtitle?: string;
  /** When the report was produced; shown on Manila time. */
  generatedAt: Date;
  columns: readonly ReportColumn<Row>[];
  rows: readonly Row[];
}

export type CellAlign = 'left' | 'right';

export function columnAlign(column: ReportColumn<never>): CellAlign {
  return column.kind === 'peso' || column.kind === 'integer' ? 'right' : 'left';
}

/** A cell as display text. */
export function formatCell<Row>(column: ReportColumn<Row>, row: Row): string {
  switch (column.kind) {
    case 'text':
      return column.value(row);
    case 'integer': {
      const value = column.value(row);
      if (!Number.isSafeInteger(value)) throw new Error(`"${column.header}" needs whole numbers.`);
      return value.toLocaleString(DISPLAY_LOCALE);
    }
    case 'peso':
      return formatPeso(assertCentavos(column.value(row)));
    case 'date':
      return formatDate(column.value(row));
  }
}

/** The total row's cells (text), or null when no column asks for a total. */
export function totalCells<Row>(report: Report<Row>): string[] | null {
  if (!report.columns.some((column) => column.kind === 'peso' && column.total)) return null;
  return report.columns.map((column, index) => {
    if (column.kind === 'peso' && column.total) {
      return formatPeso(sumCentavos(report.rows.map((row) => column.value(row))));
    }
    return index === 0 ? 'Total' : '';
  });
}

/** "Generated Sep 26, 2026, 4:05 PM" on Manila time. */
export function generatedLine(report: Pick<Report<unknown>, 'generatedAt'>): string {
  return `Generated ${formatDateTime(report.generatedAt)}`;
}
