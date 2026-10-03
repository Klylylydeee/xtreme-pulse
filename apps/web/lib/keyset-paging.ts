// Newer / Older paging over keyset cursors (the audit log and notifications, newest first). The
// services only page forward (`nextCursor`), so the URL keeps the current cursor in `cursor` and the
// cursors of the pages before it in `prev`, dot-separated, to step back to. Cursors are opaque to
// the browser; the service refuses one it didn't make.

export type SearchParams = Record<string, string | string[] | undefined>;

/** A cursor as the services encode it (base64url). */
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
/** How many earlier pages the URL remembers; going back past them returns to the first page. */
const TRAIL_MAX = 50;

/** The first value of a search param. */
export function firstParam(params: SearchParams, name: string): string | undefined {
  const value = params[name];
  return Array.isArray(value) ? value[0] : value;
}

export interface PagingState {
  /** The current page's cursor; null on the first page. */
  cursor: string | null;
  /** The cursors of the pages before this one, oldest first (null is the first page). */
  trail: (string | null)[];
  /** The URL held a cursor this app couldn't have made. */
  invalid: boolean;
}

/** Reads `cursor` and `prev` from the search params. */
export function readPaging(params: SearchParams): PagingState {
  const cursor = firstParam(params, 'cursor') ?? '';
  const prev = firstParam(params, 'prev') ?? '';
  if (!cursor) return { cursor: null, trail: [], invalid: false };
  const trail = prev ? prev.split('.') : [];
  const valid = [cursor, ...trail].every((value) => value === '_' || CURSOR_PATTERN.test(value));
  if (!valid || cursor === '_') return { cursor: null, trail: [], invalid: true };
  // `_` stands for the first page in the trail.
  return {
    cursor,
    trail: trail.map((value) => (value === '_' ? null : value)),
    invalid: false,
  };
}

function hrefWith(
  pathname: string,
  params: SearchParams,
  cursor: string | null,
  trail: (string | null)[],
): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (name === 'cursor' || name === 'prev' || value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) if (item) query.append(name, item);
  }
  if (cursor) {
    query.set('cursor', cursor);
    const kept = trail.slice(-TRAIL_MAX);
    if (kept.length) query.set('prev', kept.map((value) => value ?? '_').join('.'));
  }
  const text = query.toString();
  return text ? `${pathname}?${text}` : pathname;
}

/** The links to the newer and older pages (null when there is none). */
export function pagingLinks(
  pathname: string,
  params: SearchParams,
  paging: PagingState,
  nextCursor: string | null,
): { newer: string | null; older: string | null } {
  const onFirstPage = paging.cursor === null;
  const newer = onFirstPage
    ? null
    : hrefWith(pathname, params, paging.trail.at(-1) ?? null, paging.trail.slice(0, -1));
  const older = nextCursor
    ? hrefWith(pathname, params, nextCursor, [...paging.trail, paging.cursor])
    : null;
  return { newer, older };
}

/** The same page with no cursor: the first page, keeping the other params. */
export function firstPageHref(pathname: string, params: SearchParams): string {
  return hrefWith(pathname, params, null, []);
}
