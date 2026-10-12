import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import nextEnv from '@next/env';

// `pnpm dev:expiry-alerts [--date YYYY-MM-DD]`.
// Spec: docs/modules/talent.md#documents-photo-e-signature-and-certifications-build-step-22
// (decision 189 in docs/BUILD_PLAN.md, docs/TESTING.md#document-e-signature-and-certification-tests)
//
// Runs the 201 document and certification expiry alert job (`talent.expiryAlerts`) once, as of
// today in Manila or the given Manila date (at 8:00 AM, like the schedule). It is safe to run again:
// each alert is sent once per item and expiry date. Development only: it refuses in production
// before connecting to the database.
//
// It prints only the date, the lead days and the counts. Never names, titles or sensitive fields.

const USAGE = [
  'Usage: pnpm dev:expiry-alerts [--date YYYY-MM-DD]',
  '',
  'Runs the 201 document and certification expiry alert job once. Development only.',
  '',
  '  --date <YYYY-MM-DD>  the Manila day to run it for (default: today)',
  '  --help               show this message',
].join('\n');

function fail(message: string): void {
  console.error(`pnpm dev:expiry-alerts failed: ${message}`);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    fail('it runs in development only and refuses when NODE_ENV is production.');
    return;
  }

  let values: { date?: string; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: process.argv.slice(2),
      options: { date: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Invalid arguments.');
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  if (values.help) {
    console.log(USAGE);
    return;
  }

  // Same environment as the web app and worker: .env.local at the repo root.
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  nextEnv.loadEnvConfig(repoRoot, true, { info: () => undefined, error: console.error });

  // Imported after the environment is loaded.
  const { connectDb, disconnectDb, redactConnectionString } = await import('@pulse/db');
  const { isBusinessDate, now, startOfBusinessDate } = await import('@pulse/core');
  const { runExpiryAlerts } = await import('@pulse/talent/server');

  const date = values.date?.trim();
  if (date !== undefined && !isBusinessDate(date)) {
    fail(`"${date}" isn't a date. Use YYYY-MM-DD, like 2026-11-01.`);
    return;
  }
  // 8:00 AM Manila on the given day, like the schedule.
  const at = date ? new Date(startOfBusinessDate(date).getTime() + 8 * 60 * 60 * 1000) : now();

  try {
    await connectDb();
    const result = await runExpiryAlerts(at);
    console.log(`Date: ${result.date}`);
    console.log(
      `Lead days: ${result.documentLeadDays} for 201 documents, ${result.certificationLeadDays} for certifications`,
    );
    console.log(`201 documents expiring or expired: ${result.documents}`);
    console.log(`Certifications expiring or expired: ${result.certifications}`);
    console.log(`Notifications sent: ${result.notified}`);
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown error';
    fail(redactConnectionString(message));
  } finally {
    await disconnectDb();
  }
}

void main();
