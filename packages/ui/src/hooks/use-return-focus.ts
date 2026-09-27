'use client';

import { useMemo, useRef } from 'react';

/** The element with keyboard focus, if any (not the page body). */
export function focusedElement(): HTMLElement | null {
  const element = typeof document === 'undefined' ? null : document.activeElement;
  return element instanceof HTMLElement && element !== document.body ? element : null;
}

export type ReturnFocus = {
  /**
   * Stores what has focus, or `trigger` when nothing does: Safari doesn't focus a button on mouse
   * click, so `document.activeElement` is the page body there.
   */
  remember: (trigger?: HTMLElement | null) => void;
  /** Stores an element directly, e.g. to hand over another layer's target. */
  set: (element: HTMLElement | null) => void;
  /** The stored element. */
  get: () => HTMLElement | null;
  /** Forgets the stored element without focusing it (e.g. the user moved focus elsewhere). */
  clear: () => void;
  /** Focuses the stored element if it is still on the page, and forgets it. Returns whether it did. */
  restore: () => boolean;
  /** For a Radix layer's `onCloseAutoFocus`: restores focus instead of Radix's default. */
  onCloseAutoFocus: (event: Event) => void;
};

/**
 * Returns focus to what opened a layer that was opened by state (a shortcut, a row, a button that
 * isn't a Radix trigger), so Radix can't do it itself. The returned object is stable.
 */
export function useReturnFocus(): ReturnFocus {
  const target = useRef<HTMLElement | null>(null);
  return useMemo(() => {
    function restore() {
      const element = target.current;
      target.current = null;
      if (!element?.isConnected) return false;
      element.focus();
      return true;
    }
    return {
      remember: (trigger) => {
        target.current = focusedElement() ?? trigger ?? null;
      },
      set: (element) => {
        target.current = element;
      },
      get: () => target.current,
      clear: () => {
        target.current = null;
      },
      restore,
      onCloseAutoFocus: (event) => {
        if (target.current?.isConnected) event.preventDefault();
        restore();
      },
    };
  }, []);
}
