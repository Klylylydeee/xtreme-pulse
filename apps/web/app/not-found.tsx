import type { Metadata } from 'next';
import Link from 'next/link';
import { SearchX } from 'lucide-react';
import { Button } from '@pulse/ui/components/button';
import { EmptyState } from '@pulse/ui/components/empty-state';

export const metadata: Metadata = { title: 'Page not found' };

/**
 * The page for an unknown URL: a real HTTP 404, outside the shell, as a centred empty state
 * (docs/DESIGN_SYSTEM.md#feedback--motion). It reads nothing, so it gives nothing away to someone
 * signed out. A signed-in page that calls `notFound()` gets (pulse)/not-found.tsx, inside the shell.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-bg px-4 py-12">
      <EmptyState
        className="w-full max-w-lg"
        icon={<SearchX strokeWidth={1.75} />}
        title="Page not found"
        description="It may have been moved or deleted. Check the address, or go back to Home."
        action={
          <Button asChild variant="tinted">
            <Link href="/">Go to Home</Link>
          </Button>
        }
      />
    </main>
  );
}
