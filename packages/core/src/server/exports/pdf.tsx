// Automatic JSX runtime even when a runner (tsx in the worker) reads another package's tsconfig.
/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { ReactElement } from 'react';
import {
  Document,
  type DocumentProps,
  Font,
  Page,
  renderToBuffer,
  StyleSheet,
  Text,
  View,
} from '@react-pdf/renderer';
import { columnAlign, formatCell, generatedLine, type Report, totalCells } from './report';

// PDF generation (@react-pdf/renderer), per docs/ARCHITECTURE.md#tech-stack: payslips, HR
// documents and reports are React components rendered to a PDF in memory. Save the result with
// `saveGeneratedFile` (contentType PDF_CONTENT_TYPE) so it opens through the file route.
//
// Text is set in Inter, the design system's fallback face (DESIGN_SYSTEM.md › Typography); SF Pro
// can't be bundled. Colors come from the light appearance in @pulse/ui's tokens.css, the one place
// they are defined, since paper is light.

export const PDF_CONTENT_TYPE = 'application/pdf' as const;

const require = createRequire(import.meta.url);

/** The font family names documents use. Latin first, then Latin Extended (it has the ₱ sign). */
export const PDF_FONT_FAMILY = ['Inter', 'Inter Extended'];

let fontsRegistered = false;

/** Registers Inter with react-pdf once per process. `renderPdf` calls it. */
export function registerPdfFonts(): void {
  if (fontsRegistered) return;
  const file = (subset: string, weight: number) =>
    require.resolve(`@fontsource/inter/files/inter-${subset}-${weight}-normal.woff`);
  for (const [family, subset] of [
    ['Inter', 'latin'],
    ['Inter Extended', 'latin-ext'],
  ] as const) {
    Font.register({
      family,
      fonts: [
        { src: file(subset, 400), fontWeight: 400 },
        { src: file(subset, 700), fontWeight: 700 },
      ],
    });
  }
  // Keep words whole: react-pdf would otherwise hyphenate document numbers and amounts.
  Font.registerHyphenationCallback((word) => [word]);
  fontsRegistered = true;
}

type PdfColors = { text: string; secondary: string; separator: string; fill: string };
let colors: PdfColors | null = null;

/** The light-appearance colors from tokens.css. */
export function pdfColors(): PdfColors {
  if (colors) return colors;
  const css = readFileSync(require.resolve('@pulse/ui/tokens.css'), 'utf8');
  const light = /:root\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
  const token = (name: string) => {
    const value = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})\\s*;`).exec(light)?.[1];
    if (!value) throw new Error(`The --${name} color token was not found in tokens.css.`);
    return value;
  };
  colors = {
    text: token('text-primary'),
    secondary: token('text-secondary'),
    separator: token('separator'),
    fill: token('bg-grouped'),
  };
  return colors;
}

/** Renders a react-pdf `<Document>` to PDF bytes. */
export async function renderPdf(document: ReactElement<DocumentProps>): Promise<Uint8Array> {
  registerPdfFonts();
  return new Uint8Array(await renderToBuffer(document));
}

function reportStyles() {
  const color = pdfColors();
  return StyleSheet.create({
    page: {
      paddingVertical: 40,
      paddingHorizontal: 40,
      fontFamily: PDF_FONT_FAMILY,
      fontSize: 9,
      color: color.text,
    },
    title: { fontSize: 16, fontWeight: 700 },
    subtitle: { fontSize: 10, color: color.secondary, marginTop: 4 },
    generated: { fontSize: 8, color: color.secondary, marginTop: 4, marginBottom: 16 },
    row: {
      flexDirection: 'row',
      borderBottomWidth: 0.5,
      borderBottomColor: color.separator,
      paddingVertical: 4,
    },
    headerRow: { backgroundColor: color.fill, fontWeight: 700 },
    totalRow: { fontWeight: 700, borderBottomWidth: 0 },
    cell: { paddingHorizontal: 4 },
    footer: {
      position: 'absolute',
      bottom: 20,
      left: 40,
      right: 40,
      fontSize: 8,
      color: color.secondary,
      textAlign: 'right',
    },
  });
}

/** A report as a PDF document: title, Manila generation time, and the table with its totals. */
export function ReportPdf<Row>({ report }: { report: Report<Row> }) {
  const styles = reportStyles();
  const flex = report.columns.map((column) => column.width ?? 1);
  const align = report.columns.map((column) => columnAlign(column));
  const cells = (values: string[]) =>
    values.map((value, index) => (
      <Text key={index} style={[styles.cell, { flex: flex[index], textAlign: align[index] }]}>
        {value}
      </Text>
    ));
  const totals = totalCells(report);

  return (
    <Document title={report.title}>
      <Page size="A4" style={styles.page}>
        <Text style={styles.title}>{report.title}</Text>
        {report.subtitle ? <Text style={styles.subtitle}>{report.subtitle}</Text> : null}
        <Text style={styles.generated}>{generatedLine(report)}</Text>
        <View style={[styles.row, styles.headerRow]} fixed>
          {cells(report.columns.map((column) => column.header))}
        </View>
        {report.rows.map((row, index) => (
          <View key={index} style={styles.row} wrap={false}>
            {cells(report.columns.map((column) => formatCell(column, row)))}
          </View>
        ))}
        {totals ? <View style={[styles.row, styles.totalRow]}>{cells(totals)}</View> : null}
        <Text
          style={styles.footer}
          fixed
          render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`}
        />
      </Page>
    </Document>
  );
}

/** Renders a report to PDF bytes. */
export function renderReportPdf<Row>(report: Report<Row>): Promise<Uint8Array> {
  return renderPdf(<ReportPdf report={report} />);
}
