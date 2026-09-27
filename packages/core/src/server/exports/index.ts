// PDF and Excel export helpers (build step 0.7), server-only. Import them from
// `@pulse/core/server/exports`; they are kept out of `@pulse/core/server` so pages that don't
// export anything never load the PDF and Excel libraries.

export { buildReportWorkbook, XLSX_CONTENT_TYPE } from './excel';
export {
  PDF_CONTENT_TYPE,
  PDF_FONT_FAMILY,
  pdfColors,
  registerPdfFonts,
  renderPdf,
  renderReportPdf,
  ReportPdf,
} from './pdf';
export { formatCell, type Report, type ReportColumn } from './report';
