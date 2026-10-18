'use client';

import { Children, type ReactNode, useId } from 'react';
import { PencilLine } from 'lucide-react';
import { formatDate } from '@pulse/core';
import { cn } from '@pulse/ui';
import { Button } from '@pulse/ui/components/button';

// The employee record's building blocks (docs/DESIGN_SYSTEM.md#layout--components, "Employee
// record"): inset grouped sections, each a short header with its action, then rounded cards of
// rows. Shared by the record's sections on the `/talent` inspector and `/talent/me`.

const NOT_SET = 'Not set';

/** One section: a header with its Edit action, then its cards. */
export function RecordSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-2">
      <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 pl-4">
        <h3 id={titleId} className="text-footnote font-semibold text-text-secondary">
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * A section header's actions side by side (an Edit and, from step 2.6, a "Mark verified" or
 * "Request change"); renders nothing when every child is empty.
 */
export function SectionActions({ children }: { children: ReactNode }) {
  const items = Children.toArray(children);
  if (items.length === 0) return null;
  if (items.length === 1) return <>{items}</>;
  return <div className="flex flex-wrap items-center justify-end gap-x-1">{items}</div>;
}

/** An inset grouped card of rows (each its own term and value), with optional footer help. */
export function RecordCard({ footer, children }: { footer?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
        {children}
      </div>
      {footer ? <div className="px-4 text-footnote text-text-secondary">{footer}</div> : null}
    </div>
  );
}

/** A term and its value; an empty value reads "Not set" in `text-secondary`. */
export function Row({ term, children }: { term: string; children?: ReactNode }) {
  const empty = children === null || children === undefined || children === '';
  return (
    <dl className="flex flex-col gap-0.5 px-4 py-2.5">
      <dt className="text-footnote text-text-secondary">{term}</dt>
      <dd className={cn('text-subheadline break-words', empty && 'text-text-secondary')}>
        {empty ? NOT_SET : children}
      </dd>
    </dl>
  );
}

export function dateOrNull(value: string | null | undefined): string | null {
  return value ? formatDate(value) : null;
}

/** The section's Edit action. */
export function EditButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button variant="plain" onClick={onClick} aria-label={label}>
      <PencilLine aria-hidden="true" className="size-4.5" />
      Edit
    </Button>
  );
}
