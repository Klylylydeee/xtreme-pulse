import { Skeleton } from '@pulse/ui/components/skeleton';

/**
 * The directory while it loads (the page's `<Suspense>` fallback): the header, the filters and
 * rows in the list's shape (an avatar, the name and the details).
 */
export function DirectoryLoading() {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-6">
      <span className="sr-only">Loading the directory…</span>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-10 w-48 max-w-full md:h-12" />
        <Skeleton className="h-5 w-96 max-w-full" />
      </div>
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <Skeleton className="h-11 w-full rounded-lg sm:w-72" />
        <Skeleton className="h-11 w-full rounded-lg sm:w-64" />
      </div>
      <Skeleton className="h-4 w-24" />
      <div
        aria-hidden="true"
        className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card"
      >
        {Array.from({ length: 8 }, (_, index) => (
          <div key={index} className="flex min-h-16 items-center gap-3 px-4 py-3 md:px-5">
            <Skeleton className="size-11 rounded-full" />
            <div className="flex flex-1 flex-col gap-2 md:flex-row md:items-center md:gap-6">
              <Skeleton className="h-4 w-2/5 md:w-40" />
              <Skeleton className="h-3 w-1/3 md:w-20" />
              <Skeleton className="hidden h-3 w-32 md:block" />
              <Skeleton className="hidden h-3 w-32 md:block" />
              <Skeleton className="hidden h-3 w-44 md:block" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
