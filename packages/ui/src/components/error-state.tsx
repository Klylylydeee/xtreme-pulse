import type { ReactNode } from 'react';
import { CircleAlert } from 'lucide-react';
import { cn } from '../lib/utils';

/**
 * A designed error state: what went wrong and what to do next, with one action.
 * Colour is never the only signal, so it pairs the destructive icon with a title.
 */
export function ErrorState({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <section
      data-slot="error-state"
      role="alert"
      className={cn(
        'flex flex-col items-center gap-4 rounded-card bg-surface px-6 py-12 text-center shadow-card',
        className,
      )}
    >
      <CircleAlert
        aria-hidden="true"
        className="size-10 text-destructive-text"
        strokeWidth={1.75}
      />
      <div className="flex max-w-md flex-col gap-1">
        <h2 className="text-title-3">{title}</h2>
        <p className="text-subheadline text-text-secondary">{description}</p>
      </div>
      {action}
    </section>
  );
}
