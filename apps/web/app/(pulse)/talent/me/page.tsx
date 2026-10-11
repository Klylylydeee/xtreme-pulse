import type { Metadata } from 'next';
import { Suspense } from 'react';
import { UserRound } from 'lucide-react';
import type { CurrentUser } from '@pulse/core/server';
import { getOwnRecordView } from '@pulse/talent/server';
import { Avatar } from '@pulse/ui/components/avatar';
import { EmptyState } from '@pulse/ui/components/empty-state';
import { PageHeader } from '@pulse/ui/components/page-header';
import { Skeleton } from '@pulse/ui/components/skeleton';
import { Badge } from '@/components/org-structure';
import { requireCurrentUser } from '@/lib/auth';
import { EmployeeRecordSections } from '../employee-record-sections';

export const metadata: Metadata = { title: 'My record' };

const DESCRIPTION =
  'Your employee record. To change something, ask HR. Each time you reveal a hidden value, it’s recorded.';

// Spec: docs/modules/talent.md#the-employee-record-build-step-21 (decision 170) and
// SECURITY.md#exceptions-to-module-access — the employee's own record, self-service outside
// module access: every signed-in user, no Pulse Talent access needed. It takes no employee id from
// the request: `getOwnRecordView` loads the signed-in user's own employee only. Read-only in step
// 2.1, with Reveal on the employee's own sensitive values (each reveal is audit-logged by the
// reveal action). The bootstrap system account, which has no employee, gets an empty state. The
// guard comes first, before anything that can suspend; loading errors go to the (pulse) error
// boundary. Nothing here is logged or cached.
export default async function MyRecordPage() {
  const user = await requireCurrentUser();
  return (
    <>
      <PageHeader title="My record" description={DESCRIPTION} />
      <Suspense fallback={<MyRecordLoading />}>
        <MyRecord user={user} />
      </Suspense>
    </>
  );
}

async function MyRecord({ user }: { user: CurrentUser }) {
  const view = await getOwnRecordView(user);
  if (!view) {
    return (
      <EmptyState
        icon={<UserRound strokeWidth={1.75} />}
        title="No employee record"
        description="This account isn’t linked to an employee, so there’s no record to show."
      />
    );
  }
  const { identity } = view;
  return (
    <div className="flex w-full max-w-2xl flex-col gap-5">
      <div className="flex items-center gap-3">
        <Avatar firstName={identity.firstName} lastName={identity.lastName} size="lg" />
        <div className="flex min-w-0 flex-col gap-1">
          {/* An h2, so the sections' h3 titles sit under it (in the inspector the panel title is the h2). */}
          <h2 className="text-headline break-words">
            {identity.firstName} {identity.lastName}
          </h2>
          <span className="flex flex-wrap items-center gap-2 text-footnote text-text-secondary">
            <span className="numeric">{identity.employeeNumber}</span>
            {identity.position ? <span>· {identity.position.name}</span> : null}
            <Badge tone="accent">{identity.employmentStatus}</Badge>
          </span>
        </div>
      </div>
      <EmployeeRecordSections view={view} />
    </div>
  );
}

function MyRecordLoading() {
  return (
    <div role="status" aria-live="polite" className="flex w-full max-w-2xl flex-col gap-5">
      <span className="sr-only">Loading your record…</span>
      <div className="flex items-center gap-3">
        <Skeleton className="size-12 rounded-full" />
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-4 w-48 max-w-full" />
          <Skeleton className="h-3 w-32" />
        </div>
      </div>
      {Array.from({ length: 4 }, (_, index) => (
        <div
          key={index}
          aria-hidden="true"
          className="flex flex-col gap-3 rounded-card bg-surface p-4 shadow-card"
        >
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ))}
    </div>
  );
}
