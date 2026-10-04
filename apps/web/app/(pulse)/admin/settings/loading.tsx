import { Skeleton } from '@pulse/ui/components/skeleton';

function SectionSkeleton({ rows }: { rows: number }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 px-4">
        <Skeleton className="h-6 w-44" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="flex flex-col gap-2 px-4 py-3">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-11 w-full rounded-lg" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** The company settings page while it loads: the header and each section's card. */
export default function CompanySettingsLoading() {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-6">
      <span className="sr-only">Loading company settings…</span>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-10 w-64 max-w-full md:h-12" />
        <Skeleton className="h-5 w-96 max-w-full" />
      </div>
      <div className="flex max-w-3xl flex-col gap-10">
        <SectionSkeleton rows={5} />
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2 px-4">
            <Skeleton className="h-6 w-20" />
            <Skeleton className="h-4 w-72 max-w-full" />
          </div>
          <div className="flex items-center gap-4 rounded-card bg-surface p-4 shadow-card">
            <Skeleton className="size-24 shrink-0 rounded-card" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-56 max-w-full" />
            </div>
          </div>
        </div>
        <SectionSkeleton rows={3} />
      </div>
    </div>
  );
}
