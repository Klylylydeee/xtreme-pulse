import { Skeleton } from '@pulse/ui/components/skeleton';

/**
 * The User access page while it loads (the page's `<Suspense>` fallback): the header, the stat
 * tiles, the filters, and the rows (cards on phones).
 */
export function AccessLoading() {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-6">
      <span className="sr-only">Loading user access…</span>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-10 w-48 max-w-full md:h-12" />
        <Skeleton className="h-5 w-96 max-w-full" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }, (_, index) => (
          <div
            key={index}
            className="flex h-36 flex-col gap-3 rounded-card bg-surface p-4 shadow-card md:p-5"
          >
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-9 w-20" />
            <Skeleton className="h-3 w-32" />
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-3">
        <Skeleton className="h-11 w-full rounded-lg sm:w-72" />
        <Skeleton className="h-11 w-full rounded-lg sm:w-56" />
        <Skeleton className="h-11 w-full rounded-lg sm:w-56" />
      </div>
      <div className="flex flex-col gap-2 md:gap-0 md:divide-y md:divide-separator md:overflow-hidden md:rounded-card md:bg-surface md:shadow-card">
        {Array.from({ length: 6 }, (_, index) => (
          <div
            key={index}
            className="flex min-h-18 items-center gap-3 rounded-card bg-surface px-4 py-3 shadow-card md:rounded-none md:shadow-none"
          >
            <Skeleton className="size-11 rounded-full" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-2/5" />
              <Skeleton className="h-3 w-3/5" />
            </div>
            <Skeleton className="hidden h-6 w-32 rounded-md md:block" />
          </div>
        ))}
      </div>
    </div>
  );
}
