// Browser builds resolve `@pulse/db` to this file (the "browser" export condition). Importing
// `server-only` here makes Next fail the build if a Client Component imports the database package,
// so the connection code can never reach the browser.
// Node (Server Components, Route Handlers, scripts run with tsx) resolves `src/index.ts` instead.
import 'server-only';

export {};
