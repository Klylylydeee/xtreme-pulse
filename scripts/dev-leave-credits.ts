import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import nextEnv from '@next/env';

// `pnpm dev:leave-credits [--date YYYY-MM-DD]`.
// Spec: docs/modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28
// ("Crediting"; decision 304 in docs/BUILD_PLAN.md, docs/ARCHITECTURE.md#background-jobs)
//
// Runs the leave credit job (`talent.leaveCredits`) once, as of today in Manila or the given Manila
// date (at 12:30 AM, like the schedule). It is safe to run again: each employee gets each type's
// regularization credit, carry-over and annual credit once per year. Nothing is written while
// `talent.leaveSettings.goLiveDate` is unset. Development only: it refuses in production before
// connecting to the database.
//
// It prints only the date and the counts. Never names, balances or record details.

const USAGE = [
  'Usage: pnpm dev:leave-credits [--date YYYY-MM-DD]',
  '',
  'Runs the leave credit job once. Development only.',
  '',
  '  --date <YYYY-MM-DD>  the Manila day to run it for (default: today)',
  '  --help               show this message',
].join('\n');

function fail(message: string): void {
  console.error(`pnpm dev:leave-credits failed: ${message}`);
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
  const { runLeaveCredits } = await import('@pulse/talent/server');

  const date = values.date?.trim();
  if (date !== undefined && !isBusinessDate(date)) {
    fail(`"${date}" isn't a date. Use YYYY-MM-DD, like 2027-01-01.`);
    return;
  }
  // 12:30 AM Manila on the given day, like the schedule.
  const at = date ? new Date(startOfBusinessDate(date).getTime() + 30 * 60 * 1000) : now();

  try {
    await connectDb();
    const result = await runLeaveCredits(at);
    console.log(`Date: ${result.date}`);
    if (result.goLiveDate === null) {
      console.log('Go-live date: not set, so nothing was written');
    } else {
      console.log(`Go-live date: ${result.goLiveDate}`);
    }
    console.log(`Regular employees considered: ${result.employees}`);
    console.log(`Entries written: ${result.written}`);
    console.log(`Entries already written: ${result.existing}`);
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown error';
    fail(redactConnectionString(message));
  } finally {
    await disconnectDb();
  }
}

void main();
