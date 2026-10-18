import type { ReactNode } from 'react';
import {
  CalendarDays,
  CalendarHeart,
  CalendarX2,
  CircleCheck,
  Clock,
  Hourglass,
  Info,
  type LucideIcon,
  PenLine,
  RotateCcw,
  TriangleAlert,
  UserCheck,
} from 'lucide-react';
import {
  DTR_DAY_STATUS_LABELS,
  DTR_PREVIEW_LABEL,
  type DtrDayStatus,
  type DtrTimeOffBadgeInput,
  dtrTimeOffLabel,
  SUBMITTED_LATE_LABEL,
  type TimesheetStatus,
} from '@pulse/talent';
import { cn } from '@pulse/ui/lib/utils';

// Spec: docs/DESIGN_SYSTEM.md#layout--components ("Timesheets on a phone") — the timesheet's text
// badges. Each one names its state in words, with an icon beside it, so colour is never the only
// signal: "Manual" in `warning-text`, "No time out", "Not claimed", the day's kind, and (build
// step 2.5) a reimbursement's "Over limit"; from build step 2.7, "Submitted late", a timesheet's status
// on My team, and the DTR's day statuses and "Not approved yet"; from build step 2.8, the DTR's
// time off ("On leave (paid) · VL", "Half day VL (paid)", "Offset (paid) 4.0 h", and "Leave
// without pay" in `warning-text` with an icon).

const TONES = {
  /** A manual time, and an entry with no time out. */
  warning: 'bg-bg-grouped text-warning-text',
  /** Not claimed, and other neutral notes. */
  neutral: 'bg-bg-grouped text-text-secondary',
  /** A rest day or holiday label. */
  accent: 'bg-accent-subtle text-accent',
  /** Approved, Present (build step 2.7). */
  success: 'bg-bg-grouped text-success-text',
  /** Overdue, Absent (build step 2.7). */
  destructive: 'bg-bg-grouped text-destructive-text',
} as const;

export function TimesheetBadge({
  tone = 'neutral',
  Icon,
  className,
  children,
}: {
  tone?: keyof typeof TONES;
  Icon?: LucideIcon;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-caption font-medium whitespace-nowrap',
        TONES[tone],
        className,
      )}
    >
      {Icon ? <Icon aria-hidden="true" className="size-3.5 shrink-0" strokeWidth={2} /> : null}
      {children}
    </span>
  );
}

/** "Manual": a time typed by hand, or a clocked one changed. */
export function ManualBadge() {
  return (
    <TimesheetBadge tone="warning" Icon={PenLine}>
      Manual
    </TimesheetBadge>
  );
}

/** "No time out": an open entry, which counts nothing yet. */
export function NoTimeOutBadge() {
  return (
    <TimesheetBadge tone="warning" Icon={Clock}>
      No time out
    </TimesheetBadge>
  );
}

/** "Not claimed": extra hours in an entry without the extra-hours mark. */
export function NotClaimedBadge({ hours }: { hours?: string }) {
  return (
    <TimesheetBadge tone="neutral" Icon={Info}>
      {hours ? `Not claimed ${hours}` : 'Not claimed'}
    </TimesheetBadge>
  );
}

/** A rest day or holiday label: "Rest day", "Regular holiday on a rest day". */
export function DayKindBadge({ children }: { children: ReactNode }) {
  return (
    <TimesheetBadge tone="accent" Icon={CalendarDays}>
      {children}
    </TimesheetBadge>
  );
}

/** "Over limit": a reimbursement line over its type's limit (highlighted, never refused). */
export function OverLimitBadge() {
  return (
    <TimesheetBadge tone="warning" Icon={TriangleAlert}>
      Over limit
    </TimesheetBadge>
  );
}

/** "Submitted late": submitted on a day after the deadline (build step 2.7). */
export function SubmittedLateBadge() {
  return (
    <TimesheetBadge tone="warning" Icon={Clock}>
      {SUBMITTED_LATE_LABEL}
    </TimesheetBadge>
  );
}

/**
 * A timesheet's status as text, with its icon (My team): `label` is the status as it reads today
 * ("Not submitted", "Overdue", "Waiting for HR", …), and `overdue` the server's flag for the
 * destructive tone. Null status: no timesheet yet.
 */
export function TimesheetStatusBadge({
  status,
  label,
  overdue,
}: {
  status: TimesheetStatus | null;
  label: string;
  overdue: boolean;
}) {
  if (status === 'approved') {
    return (
      <TimesheetBadge tone="success" Icon={CircleCheck}>
        {label}
      </TimesheetBadge>
    );
  }
  if (status === 'returned') {
    return (
      <TimesheetBadge tone="warning" Icon={RotateCcw}>
        {label}
      </TimesheetBadge>
    );
  }
  if (status === 'pendingSupervisor' || status === 'pendingHr') {
    return (
      <TimesheetBadge tone="neutral" Icon={Hourglass}>
        {label}
      </TimesheetBadge>
    );
  }
  return (
    <TimesheetBadge tone={overdue ? 'destructive' : 'neutral'} Icon={TriangleAlert}>
      {label}
    </TimesheetBadge>
  );
}

const DTR_STATUS_STYLE: Record<DtrDayStatus, { tone: keyof typeof TONES; Icon: LucideIcon }> = {
  holiday: { tone: 'accent', Icon: CalendarDays },
  restDay: { tone: 'accent', Icon: CalendarDays },
  onLeavePaid: { tone: 'neutral', Icon: CalendarHeart },
  offsetPaid: { tone: 'neutral', Icon: CalendarHeart },
  leaveWithoutPay: { tone: 'warning', Icon: TriangleAlert },
  present: { tone: 'success', Icon: UserCheck },
  absentUnpaid: { tone: 'destructive', Icon: CalendarX2 },
};

/** A DTR day's status: "Present", "Absent (unpaid)", "Rest day", "Holiday", … */
export function DtrStatusBadge({ status }: { status: DtrDayStatus }) {
  const { tone, Icon } = DTR_STATUS_STYLE[status];
  return (
    <TimesheetBadge tone={tone} Icon={Icon}>
      {DTR_DAY_STATUS_LABELS[status]}
    </TimesheetBadge>
  );
}

/** "Not approved yet": a DTR day whose timesheet isn't approved (a preview). */
export function PreviewBadge() {
  return (
    <TimesheetBadge tone="neutral" Icon={Info}>
      {DTR_PREVIEW_LABEL}
    </TimesheetBadge>
  );
}

/**
 * One part of a DTR day's approved time off (step 2.8): "On leave (paid) · VL", "Half day VL
 * (paid)", "Offset (paid) 4.0 h", "Leave without pay" (in `warning-text`). A confidential type
 * reads "Leave" to anyone but the employee, HR and the System Administrator (the server's
 * `shortName`).
 */
export function DtrTimeOffBadge({ part }: { part: DtrTimeOffBadgeInput }) {
  const { tone, Icon } = DTR_STATUS_STYLE[part.status];
  return (
    <TimesheetBadge tone={tone} Icon={Icon}>
      {dtrTimeOffLabel(part)}
    </TimesheetBadge>
  );
}
