import Link from 'next/link';
import { Button } from '@pulse/ui/components/button';
import { EmptyState } from '@pulse/ui/components/empty-state';
import { PageHeader } from '@pulse/ui/components/page-header';
import { getNavEntry } from '@/lib/navigation';

/** The placeholder screen for a section of the app that isn't built yet. */
export function ModulePlaceholder({ href }: { href: string }) {
  const { title, description, Icon } = getNavEntry(href);
  return (
    <>
      <PageHeader title={title} description={description} />
      <EmptyState
        icon={<Icon strokeWidth={1.75} />}
        title={`${title} isn’t built yet`}
        description="Its screens will appear here as it is built."
        action={
          <Button asChild variant="tinted">
            <Link href="/">Go to Home</Link>
          </Button>
        }
      />
    </>
  );
}
