import type { ReactNode } from 'react';
import {
  CircleAlert,
  CircleCheck,
  Clock,
  FilePen,
  History,
  PencilLine,
  TriangleAlert,
  Undo2,
} from 'lucide-react';
import {
  PAYROLL_MANUAL_BADGE,
  PAYROLL_NEGATIVE_NET_LABEL,
  PAYROLL_PROVISIONAL_BADGE,
  PAYROLL_SETTLES_BADGE,
  type PayrollRunStatus,
} from '@pulse/talent';
import type { PayrollRunFlagRow, PayrollRunPersonRow } from '@pulse/talent/server';

// Spec: docs/DESIGN_SYSTEM.md#layout--components ("Payroll runs on a phone": badges with text and
// an icon, "Timesheet not approved · basic pay only" and "Net pay below zero" in `warning-text`,
// "Settles earlier cut-offs" neutral; "Payroll review and payslips on a phone" (step 2.10): the
// statuses "Draft", "Waiting for Board approval", "Returned" in `warning-text` with an icon and
// "Finalized" in `success-text` with an icon; each flag's badge with text and an icon, and
// "Acknowledged" once acknowledged; "Manual" in `accent-subtle` with `accent` text) — a run's and
// a person's marks. The text names each state, so color is never the only signal.

type Tone = 'warning' | 'neutral' | 'success' | 'accent';

const TONES: Record<Tone, string> = {
  warning: 'bg-bg-grouped text-warning-text',
  neutral: 'bg-bg-grouped text-text-secondary',
  success: 'bg-bg-grouped text-success-text',
  accent: 'bg-accent-subtle text-accent',
};

const iconClass = 'size-3.5 shrink-0';

function Mark({ tone, icon, children }: { tone: Tone; icon: ReactNode; children: ReactNode }) {
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1 rounded-md px-2 py-0.5 text-footnote font-medium ${TONES[tone]}`}
    >
      {icon}
      <span className="min-w-0 break-words">{children}</span>
    </span>
  );
}

/** A run's status as a text badge with an icon. */
export function RunStatusBadge({ status, label }: { status: PayrollRunStatus; label: string }) {
  switch (status) {
    case 'returned':
      return (
        <Mark tone="warning" icon={<Undo2 aria-hidden="true" className={iconClass} />}>
          {label}
        </Mark>
      );
    case 'finalized':
      return (
        <Mark tone="success" icon={<CircleCheck aria-hidden="true" className={iconClass} />}>
          {label}
        </Mark>
      );
    case 'pendingApproval':
      return (
        <Mark tone="accent" icon={<Clock aria-hidden="true" className={iconClass} />}>
          {label}
        </Mark>
      );
    default:
      return (
        <Mark tone="neutral" icon={<FilePen aria-hidden="true" className={iconClass} />}>
          {label}
        </Mark>
      );
  }
}

/** "Manual": a person or entry with manual entries. */
export function ManualBadge() {
  return (
    <Mark tone="accent" icon={<PencilLine aria-hidden="true" className={iconClass} />}>
      {PAYROLL_MANUAL_BADGE}
    </Mark>
  );
}

/** One review flag: its text, then "Acknowledged: <reason>" once HR has acknowledged it. */
export function FlagMark({ flag }: { flag: PayrollRunFlagRow }) {
  if (flag.acknowledgement && !flag.unresolved) {
    return (
      <Mark tone="neutral" icon={<CircleCheck aria-hidden="true" className={iconClass} />}>
        {`${flag.text} · ${flag.acknowledgement.text}`}
      </Mark>
    );
  }
  return (
    <Mark
      tone="warning"
      icon={
        flag.kind === 'netPayBelowZero' ? (
          <CircleAlert aria-hidden="true" className={iconClass} strokeWidth={2} />
        ) : (
          <TriangleAlert aria-hidden="true" className={iconClass} strokeWidth={2} />
        )
      }
    >
      {flag.text}
    </Mark>
  );
}

type MarkedPerson = Pick<
  PayrollRunPersonRow,
  'provisional' | 'settles' | 'negativeNet' | 'flags' | 'manualEntryCount'
>;

/**
 * Step 2.9's marks a run computed before step 2.10 still shows (no stored flags): the provisional
 * and negative net pay marks, unless the matching flag is on the line.
 */
function legacyMarks(person: MarkedPerson) {
  const kinds = new Set(person.flags.map((flag) => flag.kind));
  return {
    provisional: person.provisional && !kinds.has('timesheetNotApproved'),
    negativeNet: person.negativeNet && !kinds.has('netPayBelowZero'),
  };
}

/** The person's marks, or nothing when there are none. */
export function PersonMarks({ person }: { person: MarkedPerson }) {
  const legacy = legacyMarks(person);
  if (
    person.flags.length === 0 &&
    !legacy.provisional &&
    !legacy.negativeNet &&
    !person.settles &&
    person.manualEntryCount === 0
  ) {
    return null;
  }
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
      {person.flags.map((flag) => (
        <FlagMark key={flag.kind} flag={flag} />
      ))}
      {legacy.provisional ? (
        <Mark
          tone="warning"
          icon={<TriangleAlert aria-hidden="true" className={iconClass} strokeWidth={2} />}
        >
          {PAYROLL_PROVISIONAL_BADGE}
        </Mark>
      ) : null}
      {legacy.negativeNet ? (
        <Mark
          tone="warning"
          icon={<CircleAlert aria-hidden="true" className={iconClass} strokeWidth={2} />}
        >
          {PAYROLL_NEGATIVE_NET_LABEL}
        </Mark>
      ) : null}
      {person.manualEntryCount > 0 ? <ManualBadge /> : null}
      {person.settles ? (
        <Mark tone="neutral" icon={<History aria-hidden="true" className={iconClass} />}>
          {PAYROLL_SETTLES_BADGE}
        </Mark>
      ) : null}
    </span>
  );
}

/** The marks in words, for a row's accessible name. */
export function personMarksText(person: MarkedPerson): string[] {
  const legacy = legacyMarks(person);
  return [
    ...person.flags.map((flag) =>
      flag.acknowledgement && !flag.unresolved
        ? `${flag.text}, ${flag.acknowledgement.text}`
        : flag.text,
    ),
    legacy.provisional ? PAYROLL_PROVISIONAL_BADGE : null,
    legacy.negativeNet ? PAYROLL_NEGATIVE_NET_LABEL : null,
    person.manualEntryCount > 0 ? PAYROLL_MANUAL_BADGE : null,
    person.settles ? PAYROLL_SETTLES_BADGE : null,
  ].filter((text): text is string => text !== null);
}
