import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { buttonVariants } from '@pulse/ui/components/button';

/**
 * Newer / Older links for a newest-first list paged by cursor (lib/keyset-paging.ts). There is no
 * page count: the lists only grow, and counting them would cost a full scan. Hidden when there is
 * only one page.
 */
export function KeysetPager({
  newer,
  older,
  label,
}: {
  newer: string | null;
  older: string | null;
  /** The navigation's accessible name, e.g. "Audit log pages". */
  label: string;
}) {
  if (!newer && !older) return null;
  // aria-disabled dims the missing one (buttonVariants styles it).
  const link = buttonVariants({ variant: 'secondary' });
  return (
    <nav aria-label={label} className="flex items-center justify-between gap-3">
      {newer ? (
        <Link href={newer} className={link}>
          <ChevronLeft aria-hidden="true" className="size-4.5" />
          Newer
        </Link>
      ) : (
        <span aria-disabled="true" className={link}>
          <ChevronLeft aria-hidden="true" className="size-4.5" />
          Newer
        </span>
      )}
      {older ? (
        <Link href={older} className={link}>
          Older
          <ChevronRight aria-hidden="true" className="size-4.5" />
        </Link>
      ) : (
        <span aria-disabled="true" className={link}>
          Older
          <ChevronRight aria-hidden="true" className="size-4.5" />
        </span>
      )}
    </nav>
  );
}
