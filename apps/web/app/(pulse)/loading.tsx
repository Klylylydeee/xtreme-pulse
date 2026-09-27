import { Skeleton } from '@pulse/ui/components/skeleton';

/** The loading state for every signed-in page: skeletons in the shape of a page. */
export default function PulseLoading() {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-6">
      <span className="sr-only">Loading…</span>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-10 w-56 max-w-full md:h-12" />
        <Skeleton className="h-5 w-72 max-w-full" />
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <Skeleton className="h-32 rounded-card" />
        <Skeleton className="h-32 rounded-card" />
        <Skeleton className="h-32 rounded-card" />
      </div>
      <Skeleton className="h-64 rounded-card" />
    </div>
  );
}
