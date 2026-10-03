import type { TestProject } from 'vitest/node';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { TEST_DB_PREFIX, databaseNameOf } from './vitest.test-db';

// Starts the throwaway MongoDB replica set the tests run against (docs/TESTING.md), or uses the
// one named by PULSE_TEST_MONGODB_URI, and hands its URI to every test file. Never the
// development database: the fallback URI must name a `xtreme-pulse-test-*` database.

declare module 'vitest' {
  export interface ProvidedContext {
    /** The test replica set's connection string, with the database name every file builds on. */
    pulseTestMongoUri: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const fallback = process.env.PULSE_TEST_MONGODB_URI?.trim();
  if (fallback) {
    const name = databaseNameOf(fallback);
    if (!name?.startsWith(TEST_DB_PREFIX)) {
      throw new Error(
        `PULSE_TEST_MONGODB_URI must name a database starting with "${TEST_DB_PREFIX}"; the tests drop it.`,
      );
    }
    project.provide('pulseTestMongoUri', fallback);
    return async () => undefined;
  }

  // MongoDB publishes no Windows on Arm build: use the x64 one, which Windows runs under
  // emulation, unless MONGOMS_ARCH or MONGOMS_SYSTEM_BINARY says otherwise.
  const forceX64 =
    process.platform === 'win32' &&
    process.arch === 'arm64' &&
    !process.env.MONGOMS_ARCH &&
    !process.env.MONGOMS_SYSTEM_BINARY;
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    ...(forceX64 ? { binary: { arch: 'x64' } } : {}),
  });
  project.provide('pulseTestMongoUri', replSet.getUri(`${TEST_DB_PREFIX}base`));
  return async () => {
    await replSet.stop({ doCleanup: true, force: true });
  };
}
