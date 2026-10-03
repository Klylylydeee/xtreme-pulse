// Database naming for the tests (vitest.global-setup.ts, vitest.setup.ts). Every test database
// starts with this prefix, so a test can never open the development database (`xtreme-pulse`).

export const TEST_DB_PREFIX = 'xtreme-pulse-test-';

const URI = /^(mongodb(?:\+srv)?:\/\/[^/?]+)(?:\/([^?]*))?(\?.*)?$/;

/** The database name in a MongoDB connection string, or undefined when it names none. */
export function databaseNameOf(uri: string): string | undefined {
  const name = URI.exec(uri)?.[2];
  return name ? decodeURIComponent(name) : undefined;
}

/** The connection string with its database name replaced. */
export function withDatabaseName(uri: string, name: string): string {
  const match = URI.exec(uri);
  if (!match) throw new Error('The test MongoDB URI is not a mongodb:// connection string.');
  return `${match[1]}/${encodeURIComponent(name)}${match[3] ?? ''}`;
}
