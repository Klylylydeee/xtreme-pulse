'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Lock } from 'lucide-react';
import { Button } from '@pulse/ui/components/button';
import { EmptyState } from '@pulse/ui/components/empty-state';
import { noAccessTitle } from '@/lib/navigation';

/**
 * The no-access state (docs/DESIGN_SYSTEM.md#feedback--motion), shown inside the shell when a page
 * calls `forbidden()` (HTTP 403). Next passes the forbidden page no props, so the title comes from
 * the URL: "You don’t have access to Pulse Talent" under a module's route, "…to this page" on an
 * admin page.
 */
export function NoAccessState() {
  const pathname = usePathname();
  return (
    <EmptyState
      icon={<Lock strokeWidth={1.75} />}
      title={noAccessTitle(pathname)}
      description="Ask HR or the System Administrator if you need it."
      action={
        <Button asChild variant="tinted">
          <Link href="/">Go to Home</Link>
        </Button>
      }
    />
  );
}
