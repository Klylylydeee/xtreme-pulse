import { Skeleton } from '@pulse/ui/components/skeleton';
import { NotificationRowsSkeleton } from '@/components/notification-list';

/** The notifications page while it loads: the header, the switch and the list's rows. */
export default function NotificationsLoading() {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-6">
      <span className="sr-only">Loading notifications…</span>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-10 w-56 max-w-full md:h-12" />
          <Skeleton className="h-5 w-32" />
        </div>
        <Skeleton className="h-11 w-40 rounded-lg" />
      </div>
      <Skeleton className="h-12 w-44 rounded-lg" />
      <div className="overflow-hidden rounded-card bg-surface shadow-card">
        <NotificationRowsSkeleton rows={6} />
      </div>
    </div>
  );
}
