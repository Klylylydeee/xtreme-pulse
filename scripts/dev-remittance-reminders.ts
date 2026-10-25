import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import nextEnv from '@next/env';

// `pnpm dev:remittance-reminders [--date YYYY-MM-DD]`.
// Spec: docs/modules/talent.md#employer-contributions-and-remittances-build-step-211 ("The reminder
// job"; decision 393 in docs/BUILD_PLAN.md, docs/ARCHITECTURE.md#background-jobs,
// docs/TESTING.md#remittance-tests)
//
// Runs the remittance reminder job (`talent.remittanceReminders`) once, as of today in Manila or
// the given Manila date (at 8:00 AM, like the schedule). It is safe to run again: each agency
// month's reminder of each kind goes to each HR user once. Development only: it refuses in
// production before connecting to the database.
//
// It prints only the date and the counts. Never an amount, a name or an ID.

const USAGE = [
  'Usage: pnpm dev:remittance-reminders [--date YYYY-MM-DD]',
  '',
  'Runs the remittance reminder job once. Development only.',
  '',
  '  --date <YYYY-MM-DD>  the Manila day to run it for (default: today)',
  '  --help               show this message',
].join('\n');

function fail(message: string): void {
  console.error(`pnpm dev:remittance-reminders failed: ${message}`);
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
  const { runRemittanceReminders } = await import('@pulse/talent/server');

  const date = values.date?.trim();
  if (date !== undefined && !isBusinessDate(date)) {
    fail(`"${date}" isn't a date. Use YYYY-MM-DD, like 2026-11-25.`);
    return;
  }
  // 8:00 AM Manila on the given day, like the schedule.
  const at = date ? new Date(startOfBusinessDate(date).getTime() + 8 * 60 * 60 * 1000) : now();

  try {
    await connectDb();
    const result = await runRemittanceReminders(at);
    console.log(`Date: ${result.date}`);
    console.log(`Remittance months checked: ${result.months}`);
    console.log(`Agency months not paid: ${result.unpaid}`);
    console.log(`Reminders due today: ${result.remindersDue}`);
    console.log(`Notifications sent: ${result.notified}`);
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown error';
    fail(redactConnectionString(message));
  } finally {
    await disconnectDb();
  }
}

void main();
