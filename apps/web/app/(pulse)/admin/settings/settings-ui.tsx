import type { ReactNode } from 'react';
import { CircleCheck } from 'lucide-react';

/**
 * Marks a company detail that still holds its placeholder. The warning dot sits next to a text
 * label, so color is never the only signal (DESIGN_SYSTEM.md › Color).
 */
export function PlaceholderLabel() {
  return (
    <span className="inline-flex items-center gap-1.5 text-footnote font-medium text-warning-text">
      <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-warning" />
      Placeholder
    </span>
  );
}

/**
 * A short success note beside a save button. The live region is always rendered, so the note is
 * announced as it appears.
 */
export function SavedNote({ show, children }: { show: boolean; children: ReactNode }) {
  return (
    <div role="status" aria-live="polite" className="empty:hidden">
      {show ? (
        <p className="flex items-center gap-1.5 text-footnote font-medium text-success-text">
          <CircleCheck aria-hidden="true" strokeWidth={1.75} className="size-4 shrink-0" />
          {children}
        </p>
      ) : null}
    </div>
  );
}

/** The heading and one line of explanation above a settings section. */
export function SectionHeading({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 px-4">
      <h2 id={id} className="text-title-3">
        {title}
      </h2>
      <p className="text-subheadline text-text-secondary">{children}</p>
    </div>
  );
}
