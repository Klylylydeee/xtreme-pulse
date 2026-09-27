import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

/**
 * Development-only routes (/dev/*). The `.dev.tsx` extension keeps them out of production builds
 * (see pageExtensions in next.config.ts); this check is a second guard.
 */
export default function DevLayout({ children }: { children: ReactNode }) {
  if (process.env.NODE_ENV === 'production') notFound();
  return children;
}
