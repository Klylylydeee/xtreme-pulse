import { Skeleton } from '@pulse/ui/components/skeleton';

/**
 * The holiday calendar while it loads (the page's `<Suspense>` fallback): the header, the year
 * picker and filter, then a month heading with its rows (stacked rows on phones, a table above).
 */
export function HolidaysLoading() {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-6">
      <span className="sr-only">Loading holidays…</span>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-10 w-48 max-w-full md:h-12" />
          <Skeleton className="h-5 w-80 max-w-full" />
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-4">
        <Skeleton className="h-11 w-full rounded-lg sm:w-40" />
        <Skeleton className="h-11 w-full rounded-lg sm:w-72" />
      </div>
      {Array.from({ length: 2 }, (_, month) => (
        <div key={month} className="flex flex-col gap-2">
          <Skeleton className="h-5 w-28" />
          <div className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card md:hidden">
            {Array.from({ length: 3 }, (_, index) => (
              <div key={index} className="flex min-h-18 items-center gap-3 px-4 py-2.5">
                <Skeleton className="size-11 rounded-xl" />
                <div className="flex flex-1 flex-col gap-2">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              </div>
            ))}
          </div>
          <div className="hidden flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card md:flex">
            <div className="flex h-11 items-center gap-6 px-5">
              {Array.from({ length: 5 }, (_, index) => (
                <Skeleton key={index} className="h-3 flex-1" />
              ))}
            </div>
            {Array.from({ length: 3 }, (_, row) => (
              <div key={row} className="flex h-14 items-center gap-6 px-5">
                {Array.from({ length: 5 }, (_, index) => (
                  <Skeleton key={index} className="h-4 flex-1" />
                ))}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
