import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nextEnv from '@next/env';

// `pnpm seed:admin`. Spec: docs/modules/core.md#bootstrap-system-administrator-account
//
// 1. Loads Core's base data (allowed email domains, departments, positions, company settings
//    placeholders, products), inserting only what is missing. Later phases add their loaders here.
// 2. Creates the bootstrap System Administrator from SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD,
//    unless a System Administrator already exists.
//
// Safe to run again. It never prints the password or its hash (SECURITY.md#secrets).

// Same environment as the web app and worker: .env.local at the repo root. Variables already set
// in the process environment win over the file.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
nextEnv.loadEnvConfig(repoRoot, process.env.NODE_ENV !== 'production', {
  info: () => undefined,
  error: console.error,
});

// docs/DEPLOYMENT.md#environment-variables
const DEFAULT_ADMIN_EMAIL = 'sysadmin@xtreme-works.com';

async function main(): Promise<void> {
  // Imported after the environment is loaded.
  const { connectDb, disconnectDb, redactConnectionString } = await import('@pulse/db');
  const { coreSeedLoaders, createBootstrapAdministrator, hasSystemAdministrator, SeedInputError } =
    await import('@pulse/core/server/seed');

  const loaders = [...coreSeedLoaders];

  try {
    await connectDb();

    for (const loader of loaders) {
      const { added, skipped, filled } = await loader.run();
      const extra = filled ? `, filled ${filled} missing field${filled === 1 ? '' : 's'}` : '';
      console.log(`${loader.name}: added ${added}, kept ${skipped}${extra}`);
    }

    if (await hasSystemAdministrator()) {
      console.log('System Administrator: one already exists, so none was created.');
    } else {
      const email = process.env.SEED_ADMIN_EMAIL?.trim() || DEFAULT_ADMIN_EMAIL;
      const password = process.env.SEED_ADMIN_PASSWORD ?? '';
      const result = await createBootstrapAdministrator({ email, password });
      console.log(
        result.status === 'created'
          ? `System Administrator: created ${result.email}. Sign in and change the password, then remove SEED_ADMIN_PASSWORD from the environment.`
          : 'System Administrator: one already exists, so none was created.',
      );
    }
  } catch (error) {
    const message =
      error instanceof SeedInputError
        ? error.message
        : error instanceof Error
          ? `${error.name}: ${error.message}`
          : 'Unknown error';
    console.error(`pnpm seed:admin failed: ${redactConnectionString(message)}`);
    process.exitCode = 1;
  } finally {
    await disconnectDb();
  }
}

void main();
