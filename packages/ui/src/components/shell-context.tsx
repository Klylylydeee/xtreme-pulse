'use client';

import { createContext, useContext, type RefObject } from 'react';

/** Lets a page's large title tell the top toolbar when it has scrolled under the toolbar. */
export type ShellContextValue = {
  toolbarRef: RefObject<HTMLElement | null>;
  setTitleInToolbar: (inToolbar: boolean) => void;
};

export const ShellContext = createContext<ShellContextValue | null>(null);

export function useShell(): ShellContextValue | null {
  return useContext(ShellContext);
}
