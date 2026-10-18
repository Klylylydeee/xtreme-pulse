import Link from 'next/link';
import {
  ArrowUpRight,
  CalendarClock,
  CircleAlert,
  CircleCheck,
  Hourglass,
  Lock,
  type LucideIcon,
  RotateCcw,
} from 'lucide-react';
import { formatDate } from '@pulse/core';
import { type TimesheetApprovalView, timesheetBannerText } from '@pulse/talent';
import { cn } from '@pulse/ui/lib/utils';
import { SubmittedLateBadge } from './badges';

// Spec: docs/modules/talent.md#timesheet-approval-the-dtr-and-the-offset-balance-build-step-27
// ("Screens") and docs/DESIGN_SYSTEM.md#layout--components ("Timesheets on a phone": Submission,
// approval and the DTR) — the status banner under the title, above the Today card: an inset
// `surface` row with an icon and words. "Submitted Sep 26 · Waiting for supervisor" with the
// approvers' names, "Waiting for HR", "Returned by <name> on <date>" with the remarks quoted under
// it (`warning-text`), "Approved by <name> on <date> · Locked" (`success-text`), and "Not
// submitted · Due Sep 26" ("Overdue" in `destructive-text`). Each has its icon and words, so colour
// is never the only signal. "Submitted late" is a text badge. An approver of the pending step gets
// "Waiting for your approval · Open in Approvals" (`/approvals?request=<id>`); nothing is decided
// here. Before the cut-off ends (`open`) there is no banner.

interface BannerStyle {
  Icon: LucideIcon;
  /** The icon's and main line's colour. */
  tone: string;
}

function styleOf(approval: TimesheetApprovalView): BannerStyle {
  const { banner } = approval;
  switch (banner.kind) {
    case 'returned':
      return { Icon: RotateCcw, tone: 'text-warning-text' };
    case 'approved':
      return { Icon: CircleCheck, tone: 'text-success-text' };
    case 'notSubmitted':
      return banner.overdue
        ? { Icon: CircleAlert, tone: 'text-destructive-text' }
        : { Icon: CalendarClock, tone: 'text-text-primary' };
    default:
      return { Icon: Hourglass, tone: 'text-text-primary' };
  }
}

export function StatusBanner({
  approval,
  own,
}: {
  approval: TimesheetApprovalView;
  /** The employee's own timesheet: the due line speaks to them. */
  own: boolean;
}) {
  const { banner, approverLink } = approval;
  const text = timesheetBannerText(banner);
  if (!text && !approverLink) return null;
  const { Icon, tone } = styleOf(approval);
  const late = 'submittedLate' in banner && banner.submittedLate;

  return (
    <section
      aria-label="Timesheet status"
      className="flex flex-col gap-3 rounded-card bg-surface px-4 py-3 shadow-card"
    >
      {text ? (
        <div className="flex items-start gap-3">
          <Icon
            aria-hidden="true"
            className={cn('mt-0.5 size-5 shrink-0', tone)}
            strokeWidth={1.75}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <p className={cn('text-subheadline font-semibold break-words', tone)}>{text}</p>
            {banner.kind === 'pendingSupervisor' && banner.approverNames.length > 0 ? (
              <p className="text-footnote text-text-secondary break-words">
                {banner.approverNames.length === 1 ? 'Approver: ' : 'Approvers: '}
                {banner.approverNames.join(', ')}
              </p>
            ) : null}
            {banner.kind === 'returned' && banner.remarks ? (
              <blockquote className="border-l-2 border-warning pl-3 text-subheadline break-words whitespace-pre-line">
                <span className="sr-only">Remarks: </span>“{banner.remarks}”
              </blockquote>
            ) : null}
            {banner.kind === 'returned' && own ? (
              <p className="text-footnote text-text-secondary">
                Fix what the remarks ask for, then resubmit.
              </p>
            ) : null}
            {banner.kind === 'notSubmitted' && own ? (
              <p className="text-footnote text-text-secondary">
                {banner.overdue
                  ? `It was due ${formatDate(banner.deadline)}. Submit it now.`
                  : `Submit it by the end of ${formatDate(banner.deadline)}.`}
              </p>
            ) : null}
            {banner.kind === 'approved' ? (
              <p className="flex items-center gap-1.5 text-footnote text-text-secondary">
                <Lock aria-hidden="true" className="size-3.5 shrink-0" />
                Entries and reimbursements can’t change.
              </p>
            ) : null}
            {late ? (
              <span className="flex">
                <SubmittedLateBadge />
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
      {approverLink ? (
        <Link
          href={approverLink.href}
          className={cn(
            'flex min-h-11 items-center justify-between gap-3 rounded-lg bg-accent-subtle px-3 py-2',
            'text-subheadline font-semibold text-accent transition-colors duration-fast hover:bg-accent-subtle/70',
          )}
        >
          <span>
            Waiting for your approval<span aria-hidden="true"> · </span>
            <span className="sr-only">. </span>Open in Approvals
          </span>
          <ArrowUpRight aria-hidden="true" className="size-4 shrink-0" />
        </Link>
      ) : null}
    </section>
  );
}
