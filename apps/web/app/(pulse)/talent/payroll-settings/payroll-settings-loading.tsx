import { Skeleton } from '@pulse/ui/components/skeleton';

/**
 * Payroll settings while they load (the page's `<Suspense>` fallback): the header, the segmented
 * control, and one setting's status line and figures.
 */
export function PayrollSettingsLoading() {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-6">
      <span className="sr-only">Loading the payroll settings…</span>
      <div aria-hidden="true" className="flex flex-col gap-3">
        <Skeleton className="h-11 w-32 rounded-lg" />
        <Skeleton className="h-10 w-64 max-w-full md:h-12" />
        <Skeleton className="h-5 w-[36rem] max-w-full" />
      </div>
      <Skeleton className="h-16 w-full rounded-card" />
      <Skeleton className="h-12 w-[40rem] max-w-full rounded-lg" />
      <div aria-hidden="true" className="flex flex-col gap-3">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-72 max-w-full" />
        <div className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} className="flex min-h-11 items-center justify-between gap-4 px-4 py-3">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-4 w-24" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
