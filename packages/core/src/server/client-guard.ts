// Browser builds resolve `@pulse/core/server` to this file (the "browser" export condition).
// Importing `server-only` here makes Next fail the build if a Client Component imports the
// database-bound helpers. Node (Server Components, Server Actions, scripts run with tsx) resolves
// `src/server/index.ts` instead. Same pattern as @pulse/db.
import 'server-only';

export {};
