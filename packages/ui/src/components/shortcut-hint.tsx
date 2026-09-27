'use client';

import { useEffect, useRef, type RefObject } from 'react';
import { usePlatformModifier, type PlatformModifier } from '../hooks/use-platform-modifier';
import { cn } from '../lib/utils';

/**
 * A key in a shortcut. `mod` is ⌘ on Apple devices and Ctrl elsewhere
 * (DESIGN_SYSTEM.md › Pro-app layout). Other keys are single characters such as `k` or `s`.
 */
export type ShortcutKey = 'mod' | 'shift' | 'alt' | 'enter' | 'escape' | (string & {});

const MAC_LABELS: Record<string, string> = {
  mod: '⌘',
  shift: '⇧',
  alt: '⌥',
  enter: '↵',
  escape: 'Esc',
};

const OTHER_LABELS: Record<string, string> = {
  mod: 'Ctrl',
  shift: 'Shift',
  alt: 'Alt',
  enter: 'Enter',
  escape: 'Esc',
};

/** The shortcut as shown to the user, e.g. `⌘↵` on a Mac and `Ctrl+Enter` elsewhere. */
export function formatShortcut(keys: readonly ShortcutKey[], modifier: PlatformModifier): string {
  const mac = modifier === '⌘';
  const labels = keys.map((key) => {
    const label = (mac ? MAC_LABELS : OTHER_LABELS)[key];
    return label ?? key.toUpperCase();
  });
  return mac ? labels.join('') : labels.join('+');
}

const ARIA_NAMES: Record<string, string> = {
  shift: 'Shift',
  alt: 'Alt',
  enter: 'Enter',
  escape: 'Escape',
};

/**
 * The `aria-keyshortcuts` value for a shortcut, listing both the Mac and the Windows form,
 * e.g. `Meta+Enter Control+Enter`.
 */
export function ariaKeyShortcuts(keys: readonly ShortcutKey[]): string {
  const name = (key: ShortcutKey, mod: string) =>
    key === 'mod' ? mod : (ARIA_NAMES[key] ?? key.toUpperCase());
  const forms = keys.includes('mod') ? ['Meta', 'Control'] : [''];
  return forms.map((mod) => keys.map((key) => name(key, mod)).join('+')).join(' ');
}

/** Whether a keyboard event matches the shortcut. `mod` accepts ⌘ or Ctrl on any platform. */
export function matchesShortcut(event: KeyboardEvent, keys: readonly ShortcutKey[]): boolean {
  const wants = new Set(keys);
  if (wants.has('mod') !== (event.metaKey || event.ctrlKey)) return false;
  if (wants.has('shift') !== event.shiftKey) return false;
  if (wants.has('alt') !== event.altKey) return false;
  const main = keys.find((key) => !['mod', 'shift', 'alt'].includes(key));
  if (!main) return false;
  if (main === 'enter') return event.key === 'Enter';
  if (main === 'escape') return event.key === 'Escape';
  return event.key.toLowerCase() === main.toLowerCase();
}

/**
 * Submits a form from a keyboard shortcut (e.g. ⌘↵ / Ctrl+Enter), the same way its submit button
 * would: nothing happens while that button is disabled, busy or loading, so a shortcut can't send a
 * second submit mid-flight. Use this instead of calling `form.requestSubmit()` directly.
 */
export function submitFormFromShortcut(form: HTMLFormElement | null | undefined): void {
  if (!form) return;
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (
    button &&
    (button.disabled ||
      button.getAttribute('aria-disabled') === 'true' ||
      button.getAttribute('aria-busy') === 'true')
  ) {
    return;
  }
  form.requestSubmit(button ?? undefined);
}

/**
 * Runs `handler` when the shortcut is pressed: anywhere on the page, or only while focus is inside
 * `scope` when one is given (e.g. a sheet's form). Pass `enabled: false` to pause it.
 */
export function useShortcut(
  keys: readonly ShortcutKey[],
  handler: (event: KeyboardEvent) => void,
  // `scope` must be a stable ref object (from useRef).
  { enabled = true, scope }: { enabled?: boolean; scope?: RefObject<HTMLElement | null> } = {},
): void {
  const handlerRef = useRef(handler);
  const keysKey = keys.join('+');

  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    if (!enabled) return;
    const parts = keysKey.split('+');
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.repeat) return;
      if (!matchesShortcut(event, parts)) return;
      if (scope && !(event.target instanceof Node && scope.current?.contains(event.target))) return;
      event.preventDefault();
      handlerRef.current(event);
    }
    // Scoped shortcuts listen in the capture phase, so they win over page-wide ones.
    const capture = Boolean(scope);
    window.addEventListener('keydown', onKeyDown, capture);
    return () => window.removeEventListener('keydown', onKeyDown, capture);
  }, [enabled, keysKey, scope]);
}

const TONES = {
  /** On a surface, bg or a secondary button. */
  default: 'border border-separator bg-bg-grouped text-text-secondary',
  /** On a filled button (accent or destructive): a translucent tint of the button's text color. */
  'on-fill': 'bg-current/15',
} as const;

/**
 * A key hint such as ⌘↵ / Ctrl+Enter, shown for the user's platform
 * (DESIGN_SYSTEM.md › Shared components). Inside a control it is decorative: put
 * `aria-keyshortcuts` (see `ariaKeyShortcuts`) on the control instead. Set `announce` where the
 * hint is the content itself, such as a list of shortcuts in Help. Hidden until the platform is
 * known, so server and client render the same.
 */
export function ShortcutHint({
  keys,
  tone = 'default',
  announce = false,
  className,
}: {
  keys: readonly ShortcutKey[];
  tone?: keyof typeof TONES;
  announce?: boolean;
  className?: string;
}) {
  const modifier = usePlatformModifier();
  if (!modifier) return null;
  return (
    <kbd
      data-slot="shortcut-hint"
      aria-hidden={announce ? undefined : true}
      className={cn(
        'inline-flex h-5.5 shrink-0 items-center rounded-sm px-1.5 font-sans text-caption font-semibold whitespace-nowrap numeric',
        TONES[tone],
        className,
      )}
    >
      {formatShortcut(keys, modifier)}
    </kbd>
  );
}
