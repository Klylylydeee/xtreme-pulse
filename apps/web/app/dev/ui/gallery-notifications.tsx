'use client';

import { useState } from 'react';
import { Bell } from 'lucide-react';
import { EmptyState } from '@pulse/ui/components/empty-state';
import { SegmentedControl } from '@pulse/ui/components/segmented-control';
import { TopToolbar } from '@pulse/ui/components/top-toolbar';

const COUNTS = { none: 0, few: 3, many: 120 } as const;

/** The top toolbar's bell with its unread badge, and the inline empty state in its popover. */
export function NotificationBellDemo() {
  const [count, setCount] = useState<keyof typeof COUNTS>('few');
  return (
    <div className="flex flex-col gap-4">
      <SegmentedControl
        label="Unread count"
        track="page"
        value={count}
        onValueChange={setCount}
        options={[
          { value: 'none', label: 'None' },
          { value: 'few', label: '3' },
          { value: 'many', label: '120' },
        ]}
      />
      <div className="overflow-hidden rounded-card shadow-card">
        <TopToolbar
          appName="Xtreme Pulse"
          breadcrumb={{ parent: 'Pulse Core', current: 'Home' }}
          titleInToolbar
          commandBar={null}
          notificationsUnread={COUNTS[count]}
          notifications={
            <div className="flex flex-col">
              <h2 className="px-4 pt-4 pb-2 text-headline">Notifications</h2>
              <EmptyState
                variant="inline"
                headingLevel={3}
                icon={<Bell strokeWidth={1.75} />}
                title="No notifications yet"
                description="Approvals, reminders and updates will show up here."
              />
            </div>
          }
          help={<p className="text-subheadline">Help</p>}
          className="static"
        />
      </div>
      <div className="max-w-sm rounded-card bg-surface shadow-float">
        <EmptyState
          variant="inline"
          headingLevel={3}
          icon={<Bell strokeWidth={1.75} />}
          title="No notifications yet"
          description="Approvals, reminders and updates will show up here."
        />
      </div>
    </div>
  );
}
