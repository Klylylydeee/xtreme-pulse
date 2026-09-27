import { type Centavos, formatDate } from '@pulse/core';
import {
  DEV_DAILY_PING_SCHEDULE,
  DEV_PING_JOB,
  DEV_SAMPLE_EXPORTS_JOB,
  devSampleExportKeys,
  saveGeneratedFile,
  type ScheduleDefinition,
} from '@pulse/core/server';
import {
  buildReportWorkbook,
  PDF_CONTENT_TYPE,
  renderReportPdf,
  type Report,
  XLSX_CONTENT_TYPE,
} from '@pulse/core/server/exports';
import { handleJob, type JobHandler } from '@pulse/core/server/worker';

// Handlers for the development-only jobs behind `/dev/health` (build step 0.7). Registered only
// outside production (see jobs.ts). The sample rows are made up: they are not business records.

interface SampleLine {
  number: string;
  day: string;
  description: string;
  quantity: number;
  amount: Centavos;
}

const SAMPLE_LINES: SampleLine[] = [
  {
    number: 'DEV-2026-0001',
    day: '2026-09-01',
    description: 'Sample line: network switch',
    quantity: 2,
    amount: 4_599_000,
  },
  {
    number: 'DEV-2026-0002',
    day: '2026-09-08',
    description: 'Sample line: structured cabling',
    quantity: 120,
    amount: 1_250_050,
  },
  {
    number: 'DEV-2026-0003',
    day: '2026-09-15',
    description: 'Sample line: on-site configuration',
    quantity: 1,
    amount: 850_025,
  },
];

function sampleReport(day: string): Report<SampleLine> {
  return {
    title: 'Sample report',
    subtitle: `Development sample for ${formatDate(day)}. Not a business record.`,
    generatedAt: new Date(),
    columns: [
      { header: 'Number', kind: 'text', value: (line) => line.number, width: 18 },
      { header: 'Date', kind: 'date', value: (line) => line.day, width: 14 },
      { header: 'Description', kind: 'text', value: (line) => line.description, width: 36 },
      { header: 'Qty', kind: 'integer', value: (line) => line.quantity, width: 8 },
      { header: 'Amount', kind: 'peso', value: (line) => line.amount, total: true, width: 16 },
    ],
    rows: SAMPLE_LINES,
  };
}

const devOwner = { type: 'dev.sample', id: null };

export const devJobHandlers: JobHandler[] = [
  handleJob(DEV_PING_JOB, async ({ failAttempts }, { attempt }) => {
    if (attempt <= failAttempts) {
      throw new Error(`Failing attempt ${attempt} on purpose (failAttempts: ${failAttempts}).`);
    }
    return { ranAt: new Date().toISOString(), attempt };
  }),

  // Idempotent: each file is saved under an idempotency key for the day, so running this twice (a
  // retry, or the page enqueuing it again) returns the files from the first run.
  handleJob(DEV_SAMPLE_EXPORTS_JOB, async ({ day }) => {
    const keys = devSampleExportKeys(day);
    const report = sampleReport(day);
    const [pdf, xlsx] = await Promise.all([
      renderReportPdf(report).then((bytes) =>
        saveGeneratedFile({
          bytes,
          contentType: PDF_CONTENT_TYPE,
          fileName: `Sample report ${day}.pdf`,
          owner: devOwner,
          actorId: null,
          idempotencyKey: keys.pdf,
        }),
      ),
      buildReportWorkbook(report).then((bytes) =>
        saveGeneratedFile({
          bytes,
          contentType: XLSX_CONTENT_TYPE,
          fileName: `Sample report ${day}.xlsx`,
          owner: devOwner,
          actorId: null,
          idempotencyKey: keys.xlsx,
        }),
      ),
    ]);
    return { pdfId: pdf.id, xlsxId: xlsx.id };
  }),
];

export const devJobSchedules: ScheduleDefinition[] = [DEV_DAILY_PING_SCHEDULE];
