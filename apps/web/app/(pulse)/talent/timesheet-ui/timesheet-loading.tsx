import { Skeleton } from '@pulse/ui/components/skeleton';

/** The timesheet's skeleton: the header, the Today and extra-hours cards, and the day rows. */
export function TimesheetLoading({ label = 'Loading the timesheet…' }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="flex w-full max-w-2xl flex-col gap-5">
      <span className="sr-only">{label}</span>
      <div aria-hidden="true" className="flex flex-col gap-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      {[0, 1].map((card) => (
        <div
          key={card}
          aria-hidden="true"
          className="flex flex-col gap-3 rounded-card bg-surface p-4 shadow-card"
        >
          <div className="flex items-center gap-4">
            <Skeleton className="size-16 rounded-full" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-48 max-w-full" />
            </div>
          </div>
          <Skeleton className="h-11 w-full" />
        </div>
      ))}
      <Skeleton aria-hidden="true" className="h-11 w-full" />
      <div
        aria-hidden="true"
        className="flex flex-col divide-y divide-separator rounded-card bg-surface shadow-card"
      >
        {Array.from({ length: 5 }, (_, index) => (
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
