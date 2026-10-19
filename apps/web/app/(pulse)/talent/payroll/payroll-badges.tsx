import type { ReactNode } from 'react';
import { CircleAlert, History, TriangleAlert } from 'lucide-react';
import {
  PAYROLL_NEGATIVE_NET_LABEL,
  PAYROLL_PROVISIONAL_BADGE,
  PAYROLL_SETTLES_BADGE,
} from '@pulse/talent';
import type { PayrollRunPersonRow } from '@pulse/talent/server';

// Spec: docs/DESIGN_SYSTEM.md#layout--components ("Payroll runs on a phone": badges with text and
// an icon, "Timesheet not approved · basic pay only" and "Net pay below zero" in `warning-text`,
// "Settles earlier cut-offs" neutral) — a person's marks on the run page. The text names each
// state, so color is never the only signal.

function Mark({
  tone,
  icon,
  children,
}: {
  tone: 'warning' | 'neutral';
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <span
      className={
        tone === 'warning'
          ? 'inline-flex items-center gap-1 rounded-md bg-bg-grouped px-2 py-0.5 text-footnote font-medium text-warning-text'
          : 'inline-flex items-center gap-1 rounded-md bg-bg-grouped px-2 py-0.5 text-footnote font-medium text-text-secondary'
      }
    >
      {icon}
      {children}
    </span>
  );
}

/** The person's marks, or nothing when there are none. */
export function PersonMarks({
  person,
}: {
  person: Pick<PayrollRunPersonRow, 'provisional' | 'settles' | 'negativeNet'>;
}) {
  if (!person.provisional && !person.settles && !person.negativeNet) return null;
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {person.provisional ? (
        <Mark
          tone="warning"
          icon={<TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" strokeWidth={2} />}
        >
          {PAYROLL_PROVISIONAL_BADGE}
        </Mark>
      ) : null}
      {person.negativeNet ? (
        <Mark
          tone="warning"
          icon={<CircleAlert aria-hidden="true" className="size-3.5 shrink-0" strokeWidth={2} />}
        >
          {PAYROLL_NEGATIVE_NET_LABEL}
        </Mark>
      ) : null}
      {person.settles ? (
        <Mark
          tone="neutral"
          icon={<History aria-hidden="true" className="size-3.5 shrink-0" strokeWidth={2} />}
        >
          {PAYROLL_SETTLES_BADGE}
        </Mark>
      ) : null}
    </span>
  );
}

/** The marks in words, for a row's accessible name. */
export function personMarksText(
  person: Pick<PayrollRunPersonRow, 'provisional' | 'settles' | 'negativeNet'>,
): string[] {
  return [
    person.provisional ? PAYROLL_PROVISIONAL_BADGE : null,
    person.negativeNet ? PAYROLL_NEGATIVE_NET_LABEL : null,
    person.settles ? PAYROLL_SETTLES_BADGE : null,
  ].filter((text): text is string => text !== null);
}
