import { Skeleton } from '@pulse/ui/components/skeleton';

/** The opening balances page while it loads: the header, the go-live line and a list of people. */
export function OpeningBalancesLoading() {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-6">
      <span className="sr-only">Loading the opening balances…</span>
      <div aria-hidden="true" className="flex flex-col gap-3">
        <Skeleton className="h-11 w-32 rounded-lg" />
        <Skeleton className="h-10 w-64 max-w-full md:h-12" />
        <Skeleton className="h-5 w-[36rem] max-w-full" />
      </div>
      <Skeleton className="h-16 w-full rounded-card" />
      <Skeleton className="h-11 w-80 max-w-full rounded-lg" />
      <div
        aria-hidden="true"
        className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card"
      >
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="flex min-h-16 items-center justify-between gap-4 px-4 py-3">
            <div className="flex flex-col gap-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-56 max-w-full" />
            </div>
            <Skeleton className="h-6 w-24 rounded-md" />
          </div>
        ))}
      </div>
    </div>
  );
}
