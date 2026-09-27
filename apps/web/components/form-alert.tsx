import { CircleAlert } from 'lucide-react';

/**
 * A form-level error from a Server Action (`formError`), shown above the form. The
 * icon pairs with the text, so color is never the only signal.
 */
export function FormAlert({ message }: { message: string | null | undefined }) {
  // Always rendered (hidden while empty), so a new message is announced as it appears.
  return (
    <div role="alert" className="empty:hidden">
      {message ? (
        <p className="flex items-start gap-2 rounded-card bg-surface px-4 py-3 text-footnote font-medium text-destructive-text shadow-card">
          <CircleAlert aria-hidden="true" className="mt-px size-4 shrink-0" />
          <span>{message}</span>
        </p>
      ) : null}
    </div>
  );
}
