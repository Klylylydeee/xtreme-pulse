import { defineConfig } from 'vitest/config';

// `pnpm test` (docs/TESTING.md#sensitive-data-guard-tests): every `*.test.ts` in the workspace,
// once, against a throwaway MongoDB replica set started by vitest.global-setup.ts.
export default defineConfig({
  // Never load `.env` files: tests must not see the development database or the real master key.
  envDir: false,
  test: {
    include: ['**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/.next/**', 'storage/**'],
    // One file at a time, each in its own process (its own Mongoose, connection and database).
    pool: 'forks',
    fileParallelism: false,
    globalSetup: ['./vitest.global-setup.ts'],
    setupFiles: ['./vitest.setup.ts'],
    // The first run downloads a MongoDB binary, and on Windows on Arm it runs under emulation.
    hookTimeout: 300_000,
    testTimeout: 60_000,
  },
});
