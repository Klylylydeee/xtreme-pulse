// Browser builds resolve `@pulse/talent/server` to this file (the "browser" export condition).
// Importing `server-only` here makes Next fail the build if a Client Component imports Talent's
// models or services. Node (Server Components, Server Actions, tests) resolves
// `src/server/index.ts` instead. Same pattern as @pulse/core/server and @pulse/db.
import 'server-only';

export {};
