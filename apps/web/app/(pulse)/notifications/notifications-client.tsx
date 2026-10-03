'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@pulse/ui/components/button';
import { FormAlert } from '@/components/form-alert';
import { SegmentedControl } from '@pulse/ui/components/segmented-control';
import { markAllNotificationsReadAction } from '@/lib/actions/notifications';
import {
  announceNotificationsChanged,
  type NotificationItem,
  NotificationRow,
  useOpenNotification,
} from '@/components/notification-list';

// The interactive parts of the /notifications page: the All / Unread switch, Mark all as read and
// the rows (which mark a notification read before opening its link).

type Show = 'all' | 'unread';

export function NotificationsFilter({ value }: { value: Show }) {
  const router = useRouter();
  return (
    <SegmentedControl<Show>
      label="Show"
      track="page"
      value={value}
      options={[
        { value: 'all', label: 'All' },
        { value: 'unread', label: 'Unread' },
      ]}
      onValueChange={(next) =>
        router.push(next === 'unread' ? '/notifications?show=unread' : '/notifications')
      }
    />
  );
}

export function MarkAllReadButton({ disabled }: { disabled: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function markAll() {
    setPending(true);
    setError(null);
    try {
      const result = await markAllNotificationsReadAction(null, {});
      if (!result.ok) setError(result.formError ?? 'Couldn’t mark them read. Try again.');
    } catch {
      setError('Couldn’t mark them read. Try again.');
    } finally {
      setPending(false);
      announceNotificationsChanged();
      router.refresh();
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <Button variant="tinted" disabled={disabled} loading={pending} onClick={() => void markAll()}>
        Mark all as read
      </Button>
      <FormAlert message={error} />
    </div>
  );
}

export function NotificationsPageList({
  items,
  reference,
}: {
  items: NotificationItem[];
  reference: Date;
}) {
  const router = useRouter();
  // Opened in a new tab: this list stays, so show the row as read.
  const open = useOpenNotification({ onMarked: () => router.refresh() });
  return (
    <ul className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
      {items.map((item) => (
        <li key={item.id}>
          <NotificationRow
            item={item}
            reference={reference}
            onOpen={(target, event) => void open(target, event)}
            className="md:px-5"
          />
        </li>
      ))}
    </ul>
  );
}
