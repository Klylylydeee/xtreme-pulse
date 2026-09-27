import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvConfig } from '@next/env';
import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';

// .env.local lives at the repo root, not in apps/web, so load it from there.
// forceReload: Next has already loaded (and cached) env from apps/web by the time this runs.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
loadEnvConfig(repoRoot, process.env.NODE_ENV !== 'production', console, true);

export default function nextConfig(phase: string): NextConfig {
  // Development-only routes (/dev/*) use the `.dev.tsx` extension (page.dev.tsx, layout.dev.tsx).
  // Only the dev server recognises it, so production builds never build or serve those routes.
  // `next typegen` (pnpm typecheck) loads the config in the production-build phase; it includes the
  // dev routes too, so its route types match the ones `next dev` writes and type-checks them.
  const includeDevRoutes =
    phase === PHASE_DEVELOPMENT_SERVER || process.argv.slice(2).includes('typegen');

  return {
    // Agent instructions live in the root AGENTS.md and CLAUDE.md; stop `next dev` writing its own copies here.
    agentRules: false,
    // Workspace packages ship TypeScript source.
    transpilePackages: ['@pulse/core', '@pulse/db', '@pulse/ui'],
    experimental: {
      // Uploads reach the storage service through Server Actions. This is only the request
      // ceiling: the upload limit itself is the `core.fileUploads` setting, which can't exceed it.
      // Keep it equal to UPLOAD_REQUEST_LIMIT_BYTES in packages/core/src/server/files/settings.ts.
      serverActions: { bodySizeLimit: '25mb' },
    },
    pageExtensions: includeDevRoutes ? ['dev.tsx', 'tsx', 'ts'] : ['tsx', 'ts'],
    // Production builds type-check without the dev server's route types (.next/dev/types), which
    // list the /dev routes a production build doesn't have.
    typescript: includeDevRoutes ? {} : { tsconfigPath: 'tsconfig.build.json' },
  };
}
