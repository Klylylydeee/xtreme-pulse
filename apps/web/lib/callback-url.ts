// Where to go after signing in. Only a path on this site is accepted, so a crafted login link
// can't send the user to another site after they sign in (an open redirect).

const PLACEHOLDER_ORIGIN = 'http://pulse.invalid';
const MAX_LENGTH = 2048;

// Pages that make no sense to return to after signing in.
const NOT_A_DESTINATION = ['/login', '/change-password', '/api/auth'];

// Control characters (tabs and newlines are dropped by URL parsers) and backslashes (read as `/`).
// eslint-disable-next-line no-control-regex -- matching control characters is the point here
const UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f\\]/;

/**
 * True for a path that a browser resolves against this site: one leading `/`, then anything but
 * another `/` or `\` (`//host` and `/\host` are scheme-relative), and no unsafe characters.
 */
function isLocalPath(value: string): boolean {
  return (
    value.startsWith('/') && value[1] !== '/' && value[1] !== '\\' && !UNSAFE_CHARACTERS.test(value)
  );
}

/**
 * `value` as a same-origin relative path (`/fiscal?tab=1`), or `/` when it isn't one. The checks
 * run on the normalized result, since normalizing can turn `/.//evil.com` into `//evil.com`.
 */
export function safeCallbackUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_LENGTH || !isLocalPath(value)) return '/';
  let url: URL;
  try {
    url = new URL(value, PLACEHOLDER_ORIGIN);
  } catch {
    return '/';
  }
  if (url.origin !== PLACEHOLDER_ORIGIN) return '/';

  const result = `${url.pathname}${url.search}${url.hash}`;
  if (!isLocalPath(result)) return '/';
  // The result must also be stable: resolving it again gives the same path on this site.
  const again = new URL(result, PLACEHOLDER_ORIGIN);
  if (
    again.origin !== PLACEHOLDER_ORIGIN ||
    `${again.pathname}${again.search}${again.hash}` !== result
  ) {
    return '/';
  }
  const isExcluded = NOT_A_DESTINATION.some(
    (path) => url.pathname === path || url.pathname.startsWith(`${path}/`),
  );
  return isExcluded ? '/' : result;
}
