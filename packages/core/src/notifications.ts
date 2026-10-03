// In-app notifications (docs/modules/core.md#notifications): the limits and the link rule. Pure
// code, safe in the browser. The service is server-only (`notify` and friends in
// `@pulse/core/server`).

/** The longest title a notification keeps; a longer one is cut. */
export const NOTIFICATION_TITLE_MAX_LENGTH = 200;
/** The longest body a notification keeps; a longer one is cut. */
export const NOTIFICATION_BODY_MAX_LENGTH = 1000;
/** The longest link. */
export const NOTIFICATION_HREF_MAX_LENGTH = 2048;
/** The most notifications one page of the list returns. */
export const NOTIFICATION_PAGE_MAX = 50;

/** An event name: `<module>.<name>`, for example `core.holidayDeclared`. */
export const NOTIFICATION_EVENT_PATTERN = /^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*$/;

/**
 * True for a link inside the app: a path that starts with a single `/`, with no `//` or `\`
 * anywhere, and no spaces or control characters. A full URL, a protocol-relative `//host` link,
 * or `/\host` (which browsers read as `//host`) is refused, so a notification never links
 * off-site.
 */
export function isInternalHref(href: unknown): href is string {
  if (typeof href !== 'string') return false;
  if (href.length === 0 || href.length > NOTIFICATION_HREF_MAX_LENGTH) return false;
  if (!href.startsWith('/')) return false;
  if (href.includes('//') || href.includes('\\')) return false;
  // Whitespace and control characters: browsers strip some of them, which can turn `/\t/host`
  // into `//host`.
  // eslint-disable-next-line no-control-regex -- control characters are what this refuses
  if (/[\s\u0000-\u001f\u007f]/.test(href)) return false;
  return true;
}
