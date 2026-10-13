'use client';

import { Car, ChevronRight, FileText, Plus, Receipt, UtensilsCrossed } from 'lucide-react';
import { formatPeso } from '@pulse/core';
import {
  NO_REIMBURSEMENTS,
  type OverLimit,
  type ReimbursementLineView,
  type ReimbursementsSectionView,
} from '@pulse/talent';
import { Button } from '@pulse/ui/components/button';
import { EmptyState } from '@pulse/ui/components/empty-state';
import { IconTile } from '@pulse/ui/components/icon-tile';
import { cn } from '@pulse/ui/lib/utils';
import { OverLimitBadge } from './badges';
import { longDayText } from './format';

// Spec: docs/modules/talent.md#reimbursements-build-step-25 ("Screens") and
// docs/DESIGN_SYSTEM.md#layout--components ("Timesheets on a phone": Reimbursements) — the
// Reimbursements segment's list: the timesheet's lines grouped by receipt date, newest first (the
// server orders them), as a list, never a table. Each row is at least 72px tall: a tinted icon tile
// for the type, the merchant over the type and client on one truncated line, an "Over limit" text
// badge with "₱120.00 over the daily limit", the amount in tabular numerals and the receipt's
// thumbnail (or a PDF icon). A row opens the line's sheet: the edit form on the own open
// timesheet, a read-only detail otherwise. "Add reimbursement" shows only when the server says the
// line may be added (`canAdd`); the server checks again.

/** A type's icon in its tinted tile: the seeded keys get their own, any later type the receipt. */
function TypeIcon({ typeKey }: { typeKey: string }) {
  const props = { className: 'size-5', strokeWidth: 1.75 };
  let icon;
  switch (typeKey) {
    case 'meal':
      icon = <UtensilsCrossed {...props} />;
      break;
    case 'transportation':
      icon = <Car {...props} />;
      break;
    default:
      icon = <Receipt {...props} />;
  }
  return <IconTile className="size-10">{icon}</IconTile>;
}

/** "₱120.00 over the daily limit", or "… over the limit per receipt". */
export function overLimitText(over: OverLimit): string {
  return `${formatPeso(over.excessCentavos)} over the ${over.per === 'day' ? 'daily limit' : 'limit per receipt'}`;
}

/** The receipt's thumbnail (an image through the file route) or a PDF icon. */
export function ReceiptThumbnail({
  line,
  className,
}: {
  line: ReimbursementLineView;
  className?: string;
}) {
  if (line.receipt.isPdf) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          'flex size-10 shrink-0 flex-col items-center justify-center gap-0.5 rounded-md bg-bg-grouped text-text-secondary',
          className,
        )}
      >
        <FileText className="size-3.5" strokeWidth={1.75} />
        <span className="text-caption leading-none font-semibold">PDF</span>
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex size-10 shrink-0 overflow-hidden rounded-md border border-separator bg-bg-grouped',
        className,
      )}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={line.receipt.inlineUrl}
        alt=""
        loading="lazy"
        decoding="async"
        className="size-full object-cover"
      />
    </span>
  );
}

function LineRow({ line, onOpen }: { line: ReimbursementLineView; onOpen: () => void }) {
  const summary = [line.typeName, line.client?.name].filter(Boolean).join(' · ');
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'flex min-h-18 w-full cursor-pointer items-center gap-3 px-4 py-3 text-left',
        'transition-colors duration-fast hover:bg-accent-subtle/40 focus-visible:outline-offset-[-2px]',
      )}
    >
      <TypeIcon typeKey={line.typeKey} />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-subheadline font-medium">{line.merchant}</span>
        <span className="truncate text-footnote text-text-secondary">{summary}</span>
        {line.overLimit ? (
          <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <OverLimitBadge />
            <span className="text-footnote text-warning-text numeric">
              {overLimitText(line.overLimit)}
            </span>
          </span>
        ) : null}
      </span>
      <span className="text-subheadline font-semibold whitespace-nowrap numeric">
        {formatPeso(line.amountCentavos)}
      </span>
      <ReceiptThumbnail line={line} />
      <ChevronRight
        aria-hidden="true"
        className="hidden size-4 shrink-0 text-text-tertiary sm:block"
      />
    </button>
  );
}

export function ReimbursementList({
  section,
  onAdd,
  onOpen,
}: {
  section: ReimbursementsSectionView;
  onAdd: () => void;
  onOpen: (line: ReimbursementLineView) => void;
}) {
  const add = section.canAdd ? (
    <Button variant="tinted" onClick={onAdd} className="w-full sm:w-auto sm:self-start">
      <Plus aria-hidden="true" className="size-4" />
      Add reimbursement
    </Button>
  ) : null;

  if (section.groups.length === 0) {
    return (
      <EmptyState
        icon={<Receipt strokeWidth={1.75} />}
        title={NO_REIMBURSEMENTS}
        description={
          section.canAdd
            ? 'Add a receipt for an expense you paid for work.'
            : 'No receipts were filed on this timesheet.'
        }
        action={add}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {add}
      {section.groups.map((group) => {
        const headingId = `reimbursements-${group.receiptDate}`;
        return (
          <section
            key={group.receiptDate}
            aria-labelledby={headingId}
            className="flex flex-col gap-2"
          >
            <h2 id={headingId} className="px-4 text-footnote font-semibold text-text-secondary">
              {longDayText(group.receiptDate)}
            </h2>
            <ul className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
              {group.lines.map((line) => (
                <li key={line.id}>
                  <LineRow line={line} onOpen={() => onOpen(line)} />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
