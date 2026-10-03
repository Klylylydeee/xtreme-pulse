import { Skeleton } from '@pulse/ui/components/skeleton';

/** The audit log while it loads: the header, the filters and the table's rows. */
export default function AuditLogLoading() {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-6">
      <span className="sr-only">Loading the audit log…</span>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-10 w-48 max-w-full md:h-12" />
        <Skeleton className="h-5 w-96 max-w-full" />
      </div>
      <Skeleton className="h-11 w-32 rounded-lg md:hidden" />
      <div className="hidden grid-cols-2 gap-4 rounded-card bg-surface p-5 shadow-card md:grid lg:grid-cols-4">
        {Array.from({ length: 8 }, (_, index) => (
          <div key={index} className="flex flex-col gap-2">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-11 w-full rounded-lg" />
          </div>
        ))}
      </div>
      <div className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
        {Array.from({ length: 8 }, (_, index) => (
          <div key={index} className="flex h-14 items-center gap-6 px-5">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-40" />
            <Skeleton className="hidden h-4 w-24 md:block" />
            <Skeleton className="hidden h-4 w-28 md:block" />
            <Skeleton className="hidden h-4 flex-1 md:block" />
          </div>
        ))}
      </div>
    </div>
  );
}
