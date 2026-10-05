'use client';

import { createContext, useContext, useEffect, useId, useMemo, useState } from 'react';

// A status page's own title for the shell's toolbar and the browser tab. forbidden.tsx and
// not-found.tsx can't export metadata, and the page's metadata (such as "Pulse Talent") still
// applies when its guard calls forbidden(), so the status page says what it is through this.

type StatusTitle = { owner: string; title: string };

type ShellPageTitleContextValue = {
  set: (owner: string, title: string) => void;
  clear: (owner: string) => void;
};

const ShellPageTitleContext = createContext<ShellPageTitleContextValue | null>(null);

/**
 * The shell's side: the title set by a mounted {@link ShellPageTitle}, or null, and the context
 * value to provide.
 */
export function useShellPageTitleState() {
  const [status, setStatus] = useState<StatusTitle | null>(null);
  const value = useMemo<ShellPageTitleContextValue>(
    () => ({
      set: (owner, title) => setStatus({ owner, title }),
      // Only the one that set it clears it, so a page mounting before the last one unmounts keeps
      // its title.
      clear: (owner) => setStatus((current) => (current?.owner === owner ? null : current)),
    }),
    [],
  );
  return { title: status?.title ?? null, value, Provider: ShellPageTitleContext.Provider };
}

/**
 * Renders nothing; while mounted, the shell's toolbar shows `title` alone (no group) and the
 * browser tab reads "`title` · Xtreme Pulse". For status pages inside the shell: "No access"
 * (`NO_ACCESS_PAGE_TITLE`) and "Page not found" (`NOT_FOUND_PAGE_TITLE`) from lib/navigation.ts.
 */
export function ShellPageTitle({ title }: { title: string }) {
  const context = useContext(ShellPageTitleContext);
  const owner = useId();
  useEffect(() => {
    if (!context) return;
    context.set(owner, title);
    return () => context.clear(owner);
  }, [context, owner, title]);
  return null;
}
