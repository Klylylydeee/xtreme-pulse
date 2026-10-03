import type { ReactNode } from 'react';
import { CircleAlert } from 'lucide-react';
import { cn } from '../lib/utils';

const VARIANTS = {
  /** On the page: a card of its own. */
  card: 'gap-4 rounded-card bg-surface px-6 py-12 shadow-card',
  /** Inside something that is already a surface, such as a popover or a sheet: no card. */
  inline: 'gap-3 px-4 py-8',
} as const;

/**
 * A designed error state: what went wrong and what to do next, with one action.
 * Colour is never the only signal, so it pairs the destructive icon with a title. `inline` drops
 * the card for use inside a popover or another surface.
 */
export function ErrorState({
  title,
  description,
  action,
  variant = 'card',
  headingLevel = 2,
  className,
}: {
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
      data-slot="error-state"
      data-variant={variant}
      role="alert"
      className={cn('flex flex-col items-center text-center', VARIANTS[variant], className)}
    >
      <CircleAlert
        aria-hidden="true"
        className={cn('text-destructive-text', inline ? 'size-8' : 'size-10')}
        strokeWidth={1.75}
      />
      <div className="flex max-w-md flex-col gap-1">
        <Heading className={inline ? 'text-headline' : 'text-title-3'}>{title}</Heading>
        <p className="text-subheadline text-text-secondary">{description}</p>
      </div>
      {action}
    </section>
  );
}
