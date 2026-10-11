import { Skeleton } from '@pulse/ui/components/skeleton';

/** Card rows in the chart's shape: a few people on each level. */
const LEVELS = [1, 3, 4] as const;

/**
 * The org chart while it loads (the page's `<Suspense>` fallback): the header, the filters, the
 * zoom controls and a few levels of cards.
 */
export function OrgChartLoading() {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-6">
      <span className="sr-only">Loading the org chart…</span>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-10 w-48 max-w-full md:h-12" />
        <Skeleton className="h-5 w-96 max-w-full" />
      </div>
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <Skeleton className="h-11 w-full rounded-lg sm:w-72" />
        <Skeleton className="h-11 w-full rounded-lg sm:w-64" />
        <div className="flex gap-2 sm:ml-auto">
          <Skeleton className="size-11 rounded-lg" />
          <Skeleton className="size-11 rounded-lg" />
          <Skeleton className="size-11 rounded-lg" />
        </div>
      </div>
      <div
        aria-hidden="true"
        className="flex flex-col items-center gap-10 overflow-hidden rounded-card bg-bg-grouped p-6"
      >
        {LEVELS.map((count, level) => (
          <div key={level} className="flex justify-center gap-4">
            {Array.from({ length: count }, (_, index) => (
              <div
                key={index}
                className="flex w-48 shrink-0 items-center gap-3 rounded-card bg-surface p-3 shadow-card"
              >
                <Skeleton className="size-8 rounded-full" />
                <div className="flex flex-1 flex-col gap-2">
                  <Skeleton className="h-3.5 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
