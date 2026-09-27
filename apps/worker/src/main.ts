import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nextEnv from '@next/env';

// The BullMQ worker process (docs/adr/0009-background-jobs-bullmq.md): runs background and
// scheduled jobs next to the web app. `pnpm dev` starts it with the app. In production it runs as
// its own long-running process (`pnpm --filter @pulse/worker start`).
// docs/DEPLOYMENT.md#production lists the worker process as a hosting requirement.

// Same environment as the web app: .env.local at the repo root (see apps/web/next.config.ts).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
nextEnv.loadEnvConfig(repoRoot, process.env.NODE_ENV !== 'production', {
  info: () => undefined,
  error: console.error,
});

const log = {
  info: (message: string) => console.log(`[worker] ${message}`),
  error: (message: string) => console.error(`[worker] ${message}`),
};

async function main(): Promise<void> {
  // Imported after the environment is loaded.
  const { describeJobError, isJobsConfigured } = await import('@pulse/core/server');
  const { startJobWorker } = await import('@pulse/core/server/worker');
  const { connectDb, disconnectDb, isDatabaseConfigured, redactConnectionString } =
    await import('@pulse/db');
  const { jobHandlers, jobSchedules } = await import('./jobs');

  if (!isJobsConfigured()) {
    log.error(
      'REDIS_URL is not set, so background jobs are off. Add it to .env.local at the repo root and restart pnpm dev.',
    );
    process.exitCode = 1;
    return;
  }

  // Most jobs read or write records. Connect once, up front, so a bad MONGODB_URI shows now.
  if (isDatabaseConfigured()) {
    try {
      await connectDb();
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown error';
      log.error(
        `Can't reach MongoDB, jobs that use it will fail: ${redactConnectionString(message)}`,
      );
    }
  } else {
    log.error('MONGODB_URI is not set, so jobs that use the database will fail.');
  }

  const production = process.env.NODE_ENV === 'production';
  let worker;
  try {
    worker = await startJobWorker({
      handlers: jobHandlers({ production }),
      schedules: jobSchedules({ production }),
      logger: log,
    });
  } catch (error) {
    log.error(`Couldn't start: ${describeJobError(error)}`);
    // startJobWorker has closed its Redis clients. Exit with code 1 once the database is closed,
    // or after a few seconds if something still holds the process open.
    setTimeout(() => process.exit(1), 5_000).unref();
    await disconnectDb().catch(() => undefined);
    process.exit(1);
  }

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal}: finishing running jobs, then stopping`);
    await worker.close();
    await disconnectDb();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
}

void main();
