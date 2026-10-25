// Automatic JSX runtime even when a runner (tsx in the worker) reads another package's tsconfig.
/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { Document, Page, StyleSheet, Text, View } from '@react-pdf/renderer';
import { formatDateTime, formatPeso, sumCentavos } from '@pulse/core';
import {
  formatCell,
  PDF_FONT_FAMILY,
  pdfColors,
  renderPdf,
  type Report,
} from '@pulse/core/server/exports';

// Spec: docs/modules/talent.md#employer-contributions-and-remittances-build-step-211 ("Exports":
// "PDF: A4 landscape, one table, the totals row, then 'Due <date>' and the payment status";
// decision 387 in docs/BUILD_PLAN.md) — a remittance report as a react-pdf document, rendered with
// Core's `renderPdf` in Inter on light paper, from the same `Report` description the Excel file is
// built from (`buildReportWorkbook`). Core's `renderReportPdf` prints portrait with no lines after
// the table, so the report is laid out here with Core's fonts, colors and cell formatting (no
// Core change; HANDOFF). Pure: no database. The caller saves the bytes with `saveGeneratedFile`.

export interface RemittancePdfInput<Row> {
  report: Report<Row>;
  /** The employer's details, one line each, under the title. */
  headerLines: readonly string[];
  /** Printed after the table: the due date and payment status, notes and warnings. */
  notes: readonly string[];
  /** Columns of `kind: 'text'` printed right-aligned (amounts written as text). */
  rightAligned?: ReadonlySet<number>;
}

function styles() {
  const color = pdfColors();
  return StyleSheet.create({
    page: {
      paddingVertical: 32,
      paddingHorizontal: 32,
      fontFamily: PDF_FONT_FAMILY,
      fontSize: 8,
      color: color.text,
    },
    title: { fontSize: 15, fontWeight: 700 },
    header: { fontSize: 9, color: color.secondary, marginTop: 3 },
    generated: { fontSize: 8, color: color.secondary, marginTop: 3, marginBottom: 12 },
    row: {
      flexDirection: 'row',
      borderBottomWidth: 0.5,
      borderBottomColor: color.separator,
      paddingVertical: 3,
    },
    headerRow: { backgroundColor: color.fill, fontWeight: 700 },
    totalRow: { fontWeight: 700, borderBottomWidth: 0 },
    cell: { paddingHorizontal: 3 },
    notes: { marginTop: 12, gap: 3 },
    note: { fontSize: 9 },
    footer: {
      position: 'absolute',
      bottom: 16,
      left: 32,
      right: 32,
      fontSize: 7,
      color: color.secondary,
      textAlign: 'right',
    },
  });
}

/** The totals row: each `peso` column with `total`, "Total" in the first; null when none totals. */
function totalsOf<Row>(report: Report<Row>): string[] | null {
  if (!report.columns.some((column) => column.kind === 'peso' && column.total)) return null;
  return report.columns.map((column, index) => {
    if (column.kind === 'peso' && column.total) {
      return formatPeso(sumCentavos(report.rows.map((row) => column.value(row))));
    }
    return index === 0 ? 'Total' : '';
  });
}

export function RemittancePdf<Row>({
  report,
  headerLines,
  notes,
  rightAligned = new Set(),
}: RemittancePdfInput<Row>) {
  const s = styles();
  const flex = report.columns.map((column) => column.width ?? 1);
  const align = report.columns.map((column, index) =>
    column.kind === 'peso' || column.kind === 'integer' || rightAligned.has(index)
      ? 'right'
      : 'left',
  );
  const cells = (values: string[]) =>
    values.map((value, index) => (
      <Text key={index} style={[s.cell, { flex: flex[index], textAlign: align[index] }]}>
        {value}
      </Text>
    ));
  const totals = totalsOf(report);
  return (
    <Document title={report.title}>
      <Page size="A4" orientation="landscape" style={s.page}>
        <Text style={s.title}>{report.title}</Text>
        {headerLines.map((line, index) => (
          <Text key={index} style={s.header}>
            {line}
          </Text>
        ))}
        <Text style={s.generated}>Generated {formatDateTime(report.generatedAt)}</Text>
        <View style={[s.row, s.headerRow]} fixed>
          {cells(report.columns.map((column) => column.header))}
        </View>
        {report.rows.map((row, index) => (
          <View key={index} style={s.row} wrap={false}>
            {cells(report.columns.map((column) => formatCell(column, row)))}
          </View>
        ))}
        {totals ? <View style={[s.row, s.totalRow]}>{cells(totals)}</View> : null}
        <View style={s.notes}>
          {notes.map((note, index) => (
            <Text key={index} style={s.note}>
              {note}
            </Text>
          ))}
        </View>
        <Text
          style={s.footer}
          fixed
          render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`}
        />
      </Page>
    </Document>
  );
}

/** Renders a remittance report to PDF bytes. */
export function renderRemittancePdf<Row>(input: RemittancePdfInput<Row>): Promise<Uint8Array> {
  return renderPdf(<RemittancePdf {...input} />);
}
