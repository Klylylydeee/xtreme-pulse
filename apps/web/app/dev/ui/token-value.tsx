'use client';

import { useSyncExternalStore } from 'react';

const APPEARANCE_QUERIES = [
  '(prefers-color-scheme: dark)',
  '(prefers-reduced-motion: reduce)',
  '(prefers-reduced-transparency: reduce)',
];

function subscribe(onChange: () => void): () => void {
  const lists = APPEARANCE_QUERIES.map((query) => window.matchMedia(query));
  lists.forEach((list) => list.addEventListener('change', onChange));
  return () => lists.forEach((list) => list.removeEventListener('change', onChange));
}

/** Shows the current value of a CSS custom property, updating when the OS appearance changes. */
export function TokenValue({ name }: { name: string }) {
  const value = useSyncExternalStore(
    subscribe,
    () => getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim(),
    () => '',
  );
  return (
    <code className="text-footnote text-text-secondary numeric break-all">{value || '…'}</code>
  );
}

/** Whether the operating system asks for a dark appearance, reduced motion or transparency. */
export function AppearanceStatus() {
  const status = useSyncExternalStore(
    subscribe,
    () =>
      APPEARANCE_QUERIES.map((query) => (window.matchMedia(query).matches ? '1' : '0')).join(''),
    () => '',
  );
  if (!status) return <span>…</span>;
  const [dark, reducedMotion, reducedTransparency] = status.split('');
  return (
    <span>
      {dark === '1' ? 'Dark' : 'Light'} appearance · reduced motion{' '}
      {reducedMotion === '1' ? 'on' : 'off'} · reduced transparency{' '}
      {reducedTransparency === '1' ? 'on' : 'off'}
    </span>
  );
}
