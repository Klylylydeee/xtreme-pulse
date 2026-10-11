import { Skeleton } from '@pulse/ui/components/skeleton';

/** Skeleton rows in the shape of the Approvals list (cards on phones). */
export function ApprovalRowsSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div
      aria-hidden="true"
      className="flex flex-col gap-2 md:gap-0 md:divide-y md:divide-separator md:overflow-hidden md:rounded-card md:bg-surface md:shadow-card"
    >
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="flex min-h-18 items-start gap-3 rounded-card bg-surface px-4 py-3 shadow-card md:rounded-none md:px-5 md:shadow-none"
        >
          <Skeleton className="size-11 rounded-xl" />
          <div className="flex flex-1 flex-col gap-2 pt-0.5">
            <Skeleton className="h-4 w-3/5" />
            <Skeleton className="h-3 w-2/5" />
            <Skeleton className="h-3 w-1/3" />
          </div>
          <Skeleton className="hidden h-3 w-20 md:block" />
        </div>
      ))}
    </div>
  );
}

/**
 * The Approvals page while it loads (the page's `<Suspense>` fallback): the header, the segments
 * and the rows.
 */
export function ApprovalsLoading() {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-6">
      <span className="sr-only">Loading approvals…</span>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-10 w-48 max-w-full md:h-12" />
        <Skeleton className="h-5 w-40" />
      </div>
      <Skeleton className="h-12 w-full rounded-lg sm:w-80" />
      <ApprovalRowsSkeleton />
    </div>
  );
}
