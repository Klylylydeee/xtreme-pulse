import type { ReactNode } from 'react';
import { CalendarDays, Clock, Info, PenLine, type LucideIcon } from 'lucide-react';
import { cn } from '@pulse/ui/lib/utils';

// Spec: docs/DESIGN_SYSTEM.md#layout--components ("Timesheets on a phone") — the timesheet's text
// badges. Each one names its state in words, with an icon beside it, so colour is never the only
// signal: "Manual" in `warning-text`, "No time out", "Not claimed", and the day's kind.

const TONES = {
  /** A manual time, and an entry with no time out. */
  warning: 'bg-bg-grouped text-warning-text',
  /** Not claimed, and other neutral notes. */
  neutral: 'bg-bg-grouped text-text-secondary',
  /** A rest day or holiday label. */
  accent: 'bg-accent-subtle text-accent',
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
