'use client';

import { useCallback, useSyncExternalStore } from 'react';

/** Tailwind's `lg` breakpoint: from here the sidebar and inspector panels sit beside the page. */
export const DESKTOP_QUERY = '(min-width: 64rem)';

/**
 * Whether a CSS media query matches, updating when it changes. `null` during server rendering and
 * hydration, before the browser can be asked.
 */
export function useMediaQuery(query: string): boolean | null {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => null,
  );
}
