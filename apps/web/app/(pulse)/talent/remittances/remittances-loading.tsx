import { Skeleton } from '@pulse/ui/components/skeleton';

/** The remittances page while it loads: the header and a month of four agencies. */
export function RemittancesLoading() {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-6">
      <span className="sr-only">Loading the remittances…</span>
      <div aria-hidden="true" className="flex flex-col gap-3">
        <Skeleton className="h-11 w-32 rounded-lg" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-10 w-48 max-w-full md:h-12" />
          <Skeleton className="h-5 w-[32rem] max-w-full" />
        </div>
      </div>
      <div aria-hidden="true" className="flex flex-col gap-2">
        <Skeleton className="mx-4 h-4 w-28" />
        <div className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="flex min-h-16 items-center gap-3 px-4 py-3">
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton className="h-4 w-40 max-w-full" />
                <Skeleton className="h-3 w-28 max-w-full" />
              </div>
              <Skeleton className="h-6 w-20 rounded-md" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
