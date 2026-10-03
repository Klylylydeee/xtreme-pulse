import type { ReactNode } from 'react';
import { cn } from '../lib/utils';
import { IconTile } from './icon-tile';

const VARIANTS = {
  /** On the page: a card of its own. */
  card: 'gap-4 rounded-card bg-surface px-6 py-12 shadow-card',
  /** Inside something that is already a surface, such as a popover or a sheet: no card. */
  inline: 'gap-3 px-4 py-8',
} as const;

/**
 * A designed empty state: an icon tile, one line of explanation and one action
 * (DESIGN_SYSTEM.md › Bolder identity, Feedback & motion). `inline` drops the card for use inside
 * a popover or another surface.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  variant = 'card',
  headingLevel = 2,
  className,
}: {
  icon: ReactNode;
  title: string;
  description: ReactNode;
  action?: ReactNode;
  variant?: keyof typeof VARIANTS;
  /** The title's heading level, to fit the headings around it. */
  headingLevel?: 2 | 3;
  className?: string;
}) {
  const Heading = headingLevel === 3 ? 'h3' : 'h2';
  const inline = variant === 'inline';
  return (
    <section
      data-slot="empty-state"
      data-variant={variant}
      className={cn('flex flex-col items-center text-center', VARIANTS[variant], className)}
    >
      <IconTile
        className={
          inline ? 'size-12 rounded-xl [&_svg]:size-6' : 'size-14 rounded-xl [&_svg]:size-7'
        }
      >
        {icon}
      </IconTile>
      <div className="flex max-w-md flex-col gap-1">
        <Heading className={inline ? 'text-headline' : 'text-title-3'}>{title}</Heading>
        <p className="text-subheadline text-text-secondary">{description}</p>
      </div>
      {action}
    </section>
  );
}
