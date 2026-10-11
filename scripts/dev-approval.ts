import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import nextEnv from '@next/env';

// `pnpm dev:approval --requester <email> --step supervisors|board|all:<email,email>|self`.
// Spec: docs/modules/core.md#approvals (development script)
//
// Submits a `dev.sample` approval request from the requester: to their supervisors, to any one
// Board member, to all of the listed users, or to a step whose only approver is the requester
// (which goes to the System Administrator). Development only: it refuses in production before
// connecting to the database.
//
// It prints only the request id, its status, whether it went to the System Administrator, and the
// recipients' names and emails. Never secrets or sensitive fields (SECURITY.md#secrets).

const USAGE = [
  'Usage: pnpm dev:approval --requester <email> --step supervisors|board|all:<email,email>|self',
  '',
  'Submits a sample approval request (type dev.sample). Development only.',
  '',
  '  --requester <email>  the user who submits the request',
  '  --step <option>      supervisors: the requester’s supervisors',
  '                       board: any one Board member',
  '                       all:<email,email>: every listed user',
  '                       self: only the requester (goes to the System Administrator)',
  '  --help               show this message',
].join('\n');

function fail(message: string): void {
  console.error(`pnpm dev:approval failed: ${message}`);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    fail('it runs in development only and refuses when NODE_ENV is production.');
    return;
  }

  let values: { requester?: string; step?: string; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        requester: { type: 'string' },
        step: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
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

  const requester = values.requester?.trim() ?? '';
  const step = values.step?.trim() ?? '';
  if (!requester || !step) {
    console.error(!requester ? 'Missing --requester <email>.' : 'Missing --step <option>.');
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  // Same environment as the web app and worker: .env.local at the repo root. Variables already set
  // in the process environment win over the file.
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  nextEnv.loadEnvConfig(repoRoot, true, { info: () => undefined, error: console.error });

  // Imported after the environment is loaded.
  const { connectDb, disconnectDb, redactConnectionString } = await import('@pulse/db');
  const { ActionError } = await import('@pulse/core');
  const {
    DEV_SAMPLE_STEP_HELP,
    parseDevSampleStep,
    registerCoreApprovalTypes,
    submitDevSampleApproval,
  } = await import('@pulse/core/server');

  // Check the step before connecting, so a typo fails fast.
  try {
    parseDevSampleStep(step);
  } catch (error) {
    fail(error instanceof ActionError ? error.message : DEV_SAMPLE_STEP_HELP);
    return;
  }

  try {
    await connectDb();
    registerCoreApprovalTypes();
    const result = await submitDevSampleApproval({ requesterEmail: requester, step });
    console.log(`Request: ${result.requestId}`);
    console.log(`Status: ${result.status}`);
    console.log(
      `Routed to the System Administrator: ${result.routedToSystemAdministrator ? 'yes' : 'no'}`,
    );
    if (result.recipients.length === 0) {
      console.log('Recipients: none');
    } else {
      console.log('Recipients:');
      for (const recipient of result.recipients) {
        console.log(`  ${recipient.name} <${recipient.email}>`);
      }
    }
  } catch (error) {
    const message =
      error instanceof ActionError
        ? error.message
        : error instanceof Error
          ? `${error.name}: ${error.message}`
          : 'Unknown error';
    fail(redactConnectionString(message));
  } finally {
    await disconnectDb();
  }
}

void main();
