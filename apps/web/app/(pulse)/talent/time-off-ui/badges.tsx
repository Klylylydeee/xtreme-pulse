import { Ban, CircleCheck, CircleX, Hourglass, type LucideIcon, RotateCcw } from 'lucide-react';
import { TIME_OFF_STATUS_LABELS, type TimeOffStatus } from '@pulse/talent';
import { TimesheetBadge } from '../timesheet-ui/badges';

// Spec: docs/DESIGN_SYSTEM.md#layout--components ("Time off on a phone": request rows) — a time
// off request's status as a text badge with its icon, so color is never the only signal: waiting
// (neutral), approved (`success-text`), returned (`warning-text`), rejected (`destructive-text`),
// cancelled (neutral). Built on the timesheet's badge.

const STATUS_STYLE: Record<
  TimeOffStatus,
  { tone: 'neutral' | 'success' | 'warning' | 'destructive'; Icon: LucideIcon }
> = {
  pending: { tone: 'neutral', Icon: Hourglass },
  approved: { tone: 'success', Icon: CircleCheck },
  returned: { tone: 'warning', Icon: RotateCcw },
  rejected: { tone: 'destructive', Icon: CircleX },
  cancelled: { tone: 'neutral', Icon: Ban },
};

/** "Waiting for approval", "Approved", "Returned", "Rejected", "Cancelled". */
export function TimeOffStatusBadge({ status }: { status: TimeOffStatus }) {
  const { tone, Icon } = STATUS_STYLE[status];
  return (
    <TimesheetBadge tone={tone} Icon={Icon}>
      {TIME_OFF_STATUS_LABELS[status]}
    </TimesheetBadge>
  );
}
