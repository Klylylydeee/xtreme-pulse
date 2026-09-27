import ExcelJS from 'exceljs';
import { columnAlign, formatCell, generatedLine, type Report, totalCells } from './report';

// Excel export (exceljs), per docs/ARCHITECTURE.md#tech-stack. Builds an .xlsx workbook in memory;
// save it with `saveGeneratedFile` (contentType XLSX_CONTENT_TYPE) so it opens through the file
// route like every other file.
//
// Amounts are written as the formatted peso text from `formatPeso` (for example `₱1,234.50`), never
// as floating-point numbers (docs/DATA_MODEL.md#money). Whole-number columns are written as numbers.

export const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' as const;

// Excel limits sheet names to 31 characters and forbids : \ / ? * [ ]
function sheetName(title: string): string {
  const clean = title.replace(/[:\\/?*[\]]/g, ' ').trim();
  return (clean || 'Report').slice(0, 31);
}

/** Builds a one-sheet workbook from a report. */
export async function buildReportWorkbook<Row>(report: Report<Row>): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.created = report.generatedAt;
  const sheet = workbook.addWorksheet(sheetName(report.title));

  sheet.addRow([report.title]).font = { bold: true, size: 14 };
  if (report.subtitle) sheet.addRow([report.subtitle]);
  sheet.addRow([generatedLine(report)]);
  sheet.addRow([]);

  const header = sheet.addRow(report.columns.map((column) => column.header));
  header.font = { bold: true };
  const headerRow = header.number;

  for (const row of report.rows) {
    const values = report.columns.map((column) =>
      column.kind === 'integer' ? column.value(row) : formatCell(column, row),
    );
    sheet.addRow(values);
  }
  const totals = totalCells(report);
  if (totals) sheet.addRow(totals).font = { bold: true };

  report.columns.forEach((column, index) => {
    const excelColumn = sheet.getColumn(index + 1);
    excelColumn.width = column.width ?? Math.max(12, column.header.length + 2);
    excelColumn.eachCell((cell, rowNumber) => {
      if (rowNumber >= headerRow) cell.alignment = { horizontal: columnAlign(column) };
    });
  });
  // Keep the column headers in view while scrolling.
  sheet.views = [{ state: 'frozen', ySplit: headerRow }];

  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}
