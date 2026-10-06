import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nextEnv from '@next/env';

// `pnpm recover:admin`. Spec: SECURITY.md#system-administrator and
// docs/RUNBOOK.md#the-only-system-administrator-is-disabled
//
// When no System Administrator is active, re-enables the bootstrap system account with
// SEED_ADMIN_PASSWORD as a temporary password, sets mustChangePassword, ends its old sessions and
// writes an audit entry with no actor. It refuses to run while any System Administrator is active.
//
// It never prints the password or its hash (SECURITY.md#secrets).

// Same environment as the web app and worker: .env.local at the repo root. Variables already set
// in the process environment win over the file.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
nextEnv.loadEnvConfig(repoRoot, process.env.NODE_ENV !== 'production', {
  info: () => undefined,
  error: console.error,
});

async function main(): Promise<void> {
  // Imported after the environment is loaded.
  const { connectDb, disconnectDb, redactConnectionString } = await import('@pulse/db');
  const { recoverSystemAdministrator, SeedInputError } = await import('@pulse/core/server/seed');

  try {
    await connectDb();
    const result = await recoverSystemAdministrator({
      password: process.env.SEED_ADMIN_PASSWORD ?? '',
    });
    console.log(
      `System Administrator: re-enabled ${result.email}. Sign in, change the password, then remove SEED_ADMIN_PASSWORD from the environment.`,
    );
  } catch (error) {
    const message =
      error instanceof SeedInputError
        ? error.message
        : error instanceof Error
          ? `${error.name}: ${error.message}`
          : 'Unknown error';
    console.error(`pnpm recover:admin failed: ${redactConnectionString(message)}`);
    process.exitCode = 1;
  } finally {
    await disconnectDb();
  }
}

void main();
