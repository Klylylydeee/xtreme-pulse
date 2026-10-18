import { Skeleton } from '@pulse/ui/components/skeleton';

/** The time off page's skeleton: the header, the balance cards and the request rows. */
export function TimeOffLoading({ label = 'Loading time off…' }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="flex w-full max-w-2xl flex-col gap-5">
      <span className="sr-only">{label}</span>
      <div aria-hidden="true" className="flex flex-col gap-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <div aria-hidden="true" className="flex gap-3 overflow-hidden sm:grid sm:grid-cols-3">
        {[0, 1, 2].map((card) => (
          <div
            key={card}
            className="flex w-44 shrink-0 flex-col gap-3 rounded-card bg-surface p-4 shadow-card sm:w-auto"
          >
            <div className="flex items-center gap-2.5">
              <Skeleton className="size-9 rounded-lg" />
              <Skeleton className="h-4 w-16" />
            </div>
            <Skeleton className="h-10 w-24" />
          </div>
        ))}
      </div>
      <div
        aria-hidden="true"
        className="flex flex-col divide-y divide-separator rounded-card bg-surface shadow-card"
      >
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="flex min-h-18 items-center gap-3 px-4 py-3">
            <Skeleton className="size-12 rounded-lg" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-40 max-w-full" />
              <Skeleton className="h-3 w-56 max-w-full" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
