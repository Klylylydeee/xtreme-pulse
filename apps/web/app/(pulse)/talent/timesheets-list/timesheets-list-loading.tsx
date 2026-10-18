import { Skeleton } from '@pulse/ui/components/skeleton';

/**
 * The timesheets list while it loads (the page's `<Suspense>` fallback): the header, the cut-off
 * picker, the five status tiles and rows in the list's shape (the name and details, then the
 * status).
 */
export function TimesheetsListLoading() {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-6">
      <span className="sr-only">Loading the timesheets…</span>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-10 w-48 max-w-full md:h-12" />
        <Skeleton className="h-5 w-96 max-w-full" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-11 w-full rounded-lg sm:w-64" />
      </div>
      <div aria-hidden="true" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {Array.from({ length: 5 }, (_, index) => (
          <div
            key={index}
            className="flex flex-col gap-3 rounded-card bg-surface p-4 shadow-card md:p-5"
          >
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-10 w-16" />
          </div>
        ))}
      </div>
      <Skeleton className="h-4 w-28" />
      <div
        aria-hidden="true"
        className="flex flex-col gap-2 md:gap-0 md:divide-y md:divide-separator md:overflow-hidden md:rounded-card md:bg-surface md:shadow-card"
      >
        {Array.from({ length: 8 }, (_, index) => (
          <div
            key={index}
            className="flex min-h-16 flex-col justify-center gap-2 rounded-card bg-surface px-4 py-3 shadow-card md:flex-row md:items-center md:gap-6 md:rounded-none md:bg-transparent md:px-5 md:shadow-none"
          >
            <div className="flex flex-col gap-2 md:flex-1">
              <Skeleton className="h-4 w-2/5 md:w-40" />
              <Skeleton className="h-3 w-3/5 md:w-56" />
            </div>
            <Skeleton className="h-3 w-1/3 md:w-40" />
          </div>
        ))}
      </div>
    </div>
  );
}
