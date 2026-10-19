import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import nextEnv from '@next/env';

// `pnpm dev:payroll-drafts [--date YYYY-MM-DD]`.
// Spec: docs/modules/talent.md#payroll-run-computation-build-step-29
// ("The draft job"; docs/ARCHITECTURE.md#background-jobs)
//
// Runs the draft payroll job (`talent.payrollDraftRuns`) once, as of today in Manila or the given
// Manila date (at 5:00 AM, like the schedule). It is safe to run again: a cut-off gets one run, so
// a second run only recomputes the drafts. Nothing is done while `talent.leaveSettings.goLiveDate`
// is unset. Development only: it refuses in production before connecting to the database.
//
// It prints only the dates, the run number, the reason a draft waited and the count. Never an
// amount, a name or a line.

const USAGE = [
  'Usage: pnpm dev:payroll-drafts [--date YYYY-MM-DD]',
  '',
  'Runs the draft payroll job once. Development only.',
  '',
  '  --date <YYYY-MM-DD>  the Manila day to run it for (default: today)',
  '  --help               show this message',
].join('\n');

const WAITING: Record<'exists' | 'timesheets', string> = {
  exists: 'the cut-off already has a run',
  timesheets: 'waiting for timesheet approvals (the submission deadline has not passed)',
};

function fail(message: string): void {
  console.error(`pnpm dev:payroll-drafts failed: ${message}`);
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
  const { runPayrollDrafts } = await import('@pulse/talent/server');

  const date = values.date?.trim();
  if (date !== undefined && !isBusinessDate(date)) {
    fail(`"${date}" isn't a date. Use YYYY-MM-DD, like 2026-10-11.`);
    return;
  }
  // 5:00 AM Manila on the given day, like the schedule.
  const at = date ? new Date(startOfBusinessDate(date).getTime() + 5 * 60 * 60 * 1000) : now();

  try {
    await connectDb();
    const result = await runPayrollDrafts(at);
    console.log(`Date: ${result.date}`);
    if (result.goLiveDate === null) {
      console.log('Go-live date: not set, so nothing was done');
      return;
    }
    console.log(`Go-live date: ${result.goLiveDate}`);
    console.log(
      `Latest ended cut-off: ${
        result.latestPeriodStart === null
          ? 'none on or after the first payroll cut-off'
          : `starts ${result.latestPeriodStart}`
      }`,
    );
    if (result.created !== null) {
      console.log(`Draft created: ${result.created}`);
    } else if (result.waiting !== null) {
      console.log(`Draft not created: ${WAITING[result.waiting]}`);
    } else {
      console.log('Draft created: none');
    }
    console.log(`Drafts recomputed: ${result.recomputed}`);
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown error';
    fail(redactConnectionString(message));
  } finally {
    await disconnectDb();
  }
}

void main();
