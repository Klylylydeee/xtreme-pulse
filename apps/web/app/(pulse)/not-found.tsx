import Link from 'next/link';
import { SearchX } from 'lucide-react';
import { Button } from '@pulse/ui/components/button';
import { EmptyState } from '@pulse/ui/components/empty-state';
import { ShellPageTitle } from '@/components/shell-page-title';
import { NOT_FOUND_PAGE_TITLE } from '@/lib/navigation';

/**
 * What a signed-in page shows when it calls `notFound()`, such as for a record that doesn't exist:
 * HTTP 404 with the not-found state, inside the shell (docs/DESIGN_SYSTEM.md#feedback--motion).
 * The toolbar and tab read "Page not found". Unknown URLs get app/not-found.tsx, outside the shell.
 */
export default function PulseNotFound() {
  return (
    <>
      <ShellPageTitle title={NOT_FOUND_PAGE_TITLE} />
      <EmptyState
        icon={<SearchX strokeWidth={1.75} />}
        title="Page not found"
        description="It may have been moved or deleted. Check the address, or go back to Home."
        action={
          <Button asChild variant="tinted">
            <Link href="/">Go to Home</Link>
          </Button>
        }
      />
    </>
  );
}
