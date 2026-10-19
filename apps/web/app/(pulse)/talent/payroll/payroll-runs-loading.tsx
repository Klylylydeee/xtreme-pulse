import { Skeleton } from '@pulse/ui/components/skeleton';

/** The payroll runs list while it loads: the header and a list of runs. */
export function PayrollRunsLoading() {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-6">
      <span className="sr-only">Loading the payroll runs…</span>
      <div aria-hidden="true" className="flex flex-col gap-3">
        <Skeleton className="h-11 w-32 rounded-lg" />
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-10 w-48 max-w-full md:h-12" />
            <Skeleton className="h-5 w-[32rem] max-w-full" />
          </div>
          <Skeleton className="h-11 w-44 rounded-lg" />
        </div>
      </div>
      <div
        aria-hidden="true"
        className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card"
      >
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className="flex min-h-16 items-center gap-3 px-4 py-3">
            <Skeleton className="size-12 shrink-0 rounded-lg" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-44 max-w-full" />
              <Skeleton className="h-3 w-64 max-w-full" />
            </div>
            <Skeleton className="h-6 w-16 rounded-md" />
          </div>
        ))}
      </div>
    </div>
  );
}
