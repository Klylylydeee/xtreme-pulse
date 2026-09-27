import type { ReactNode } from 'react';
import { cn } from '../lib/utils';
import { IconTile } from './icon-tile';

/**
 * A designed empty state: an icon tile, one line of explanation and one action
 * (DESIGN_SYSTEM.md › Bolder identity, Feedback & motion).
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon: ReactNode;
  title: string;
  description: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <section
      data-slot="empty-state"
      className={cn(
        'flex flex-col items-center gap-4 rounded-card bg-surface px-6 py-12 text-center shadow-card',
        className,
      )}
    >
      <IconTile className="size-14 rounded-xl [&_svg]:size-7">{icon}</IconTile>
      <div className="flex max-w-md flex-col gap-1">
        <h2 className="text-title-3">{title}</h2>
        <p className="text-subheadline text-text-secondary">{description}</p>
      </div>
      {action}
    </section>
  );
}
