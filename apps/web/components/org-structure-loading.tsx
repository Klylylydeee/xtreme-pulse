import { Skeleton } from '@pulse/ui/components/skeleton';

/**
 * The departments and positions pages while they load: the header with its action, the toolbar
 * (count, filters and "Show retired"), and the table's rows, or stacked rows on phones.
 */
export function OrgStructureLoading({
  label,
  columns,
  filter = false,
}: {
  label: string;
  columns: number;
  /** Positions also have a department filter. */
  filter?: boolean;
}) {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-6">
      <span className="sr-only">{label}</span>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-10 w-48 max-w-full md:h-12" />
          <Skeleton className="h-5 w-96 max-w-full" />
        </div>
        <Skeleton className="h-11 w-40 rounded-lg" />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-4">
        {filter ? (
          <Skeleton className="h-11 w-full rounded-lg sm:w-64" />
        ) : (
          <Skeleton className="h-4 w-28" />
        )}
        <Skeleton className="h-8 w-40 rounded-full" />
      </div>
      <div className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card md:hidden">
        {Array.from({ length: 6 }, (_, index) => (
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
          {Array.from({ length: columns }, (_, index) => (
            <Skeleton key={index} className="h-3 flex-1" />
          ))}
        </div>
        {Array.from({ length: 6 }, (_, row) => (
          <div key={row} className="flex h-14 items-center gap-6 px-5">
            {Array.from({ length: columns }, (_, index) => (
              <Skeleton key={index} className="h-4 flex-1" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
