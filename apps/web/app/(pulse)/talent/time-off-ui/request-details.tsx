import { useId } from 'react';
import Link from 'next/link';
import {
  CircleCheck,
  CircleX,
  ExternalLink,
  Hourglass,
  ListChecks,
  type LucideIcon,
  Pencil,
  RotateCcw,
  TriangleAlert,
  XCircle,
} from 'lucide-react';
import { formatDate, formatDateTime } from '@pulse/core';
import {
  formatDayCount,
  formatOffsetHours,
  formatShortDay,
  OWN_TIME_OFF_HREF,
  TIME_OFF_KIND_LABELS,
  timeOffWhenText,
  withoutPayText,
} from '@pulse/talent';
import type { TimeOffRequestPageView } from '@pulse/talent/server';
import { buttonVariants } from '@pulse/ui/components/button';
import { cn } from '@pulse/ui/lib/utils';
import { RecordCard, Row } from '../record-ui';
import { TimeOffStatusBadge } from './badges';
import { DAY_EXCLUSION_LABELS, requestAmountText } from './format';

// Spec: docs/modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28
// ("Screens": `/talent/time-off-requests/<id>`) and docs/DESIGN_SYSTEM.md#layout--components
// ("Time off on a phone": the request page) — one request, read-only, in inset grouped cards: who
// and what (the type's name, or "Leave" for a confidential type the viewer may not see, or "Offset
// time off"), the days and the split, "Open attachment" (a link, never a preview of the medical
// file, and only when the server says the viewer may open it; every open is audit-logged), the
// reason, the status, then its days one by one and the approval history as a list, newest first.
// An approver of the pending step sees "Waiting for your approval · Open in Approvals"; nothing is
// decided here. The employee's own returned or cancellable request links back to the own page's
// sheets (`#resend-<id>`, `#cancel-<id>`). A hidden type's split, reason and attachment never
// reach the page (the service leaves them out), so the days show no paid or unpaid mark then.

type ApprovalDetail = TimeOffRequestPageView['approvals'][number];
type Approver = ApprovalDetail['steps'][number]['approvers'][number];

const DECISION_STYLE: Record<
  NonNullable<Approver['decision']>['decision'],
  { label: string; tone: string; Icon: LucideIcon }
> = {
  approve: { label: 'Approved', tone: 'text-success-text', Icon: CircleCheck },
  return: { label: 'Returned', tone: 'text-warning-text', Icon: RotateCcw },
  reject: { label: 'Rejected', tone: 'text-destructive-text', Icon: CircleX },
};

function ApprovalRound({ approval, index }: { approval: ApprovalDetail; index: number }) {
  const decided = approval.steps.flatMap((step) =>
    step.approvers.filter((approver) => approver.decision),
  );
  const waiting =
    approval.status === 'pending'
      ? approval.steps
          .filter((step) => step.status === 'pending')
          .flatMap((step) => step.approvers.map((approver) => approver.name))
      : [];
  return (
    <li className="flex flex-col gap-1.5 px-4 py-3">
      <p className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="text-subheadline font-semibold">
          {index === 0 ? 'Sent' : 'Sent earlier'}
        </span>
        <span className="text-footnote text-text-secondary numeric">
          {formatDateTime(approval.submittedAt)}
        </span>
      </p>
      {decided.map((approver) => {
        const decision = approver.decision;
        if (!decision) return null;
        const style = DECISION_STYLE[decision.decision];
        return (
          <div key={`${approver.userId}-${decision.decision}`} className="flex flex-col gap-0.5">
            <p className="flex flex-wrap items-center gap-x-1.5 text-footnote">
              <span className={cn('inline-flex items-center gap-1 font-semibold', style.tone)}>
                <style.Icon aria-hidden="true" className="size-4 shrink-0" strokeWidth={2} />
                {style.label}
              </span>
              <span>by {approver.name}</span>
              <span className="text-text-secondary numeric">
                · {formatDateTime(decision.decidedAt)}
              </span>
            </p>
            {decision.remarks ? (
              <p className="text-footnote text-text-secondary">“{decision.remarks}”</p>
            ) : null}
          </div>
        );
      })}
      {waiting.length > 0 ? (
        <p className="flex items-start gap-1.5 text-footnote text-text-secondary">
          <Hourglass aria-hidden="true" className="mt-px size-4 shrink-0" strokeWidth={2} />
          <span>Waiting for {waiting.join(', ')}</span>
        </p>
      ) : null}
    </li>
  );
}

export function TimeOffRequestDetails({ view }: { view: TimeOffRequestPageView }) {
  const { request } = view;
  const daysId = useId();
  const historyId = useId();
  const amount = requestAmountText(request);
  const unpaid = request.unpaidHalfDays ?? 0;
  const splitKnown = request.kind === 'leave' && request.paidHalfDays !== null;
  return (
    <div className="flex w-full max-w-2xl min-w-0 flex-col gap-5">
      {view.approverLink ? (
        <div className="flex flex-col gap-3 rounded-card bg-surface px-4 py-3 shadow-card sm:flex-row sm:items-center">
          <p className="flex min-w-0 flex-1 items-center gap-2 text-subheadline font-semibold">
            <Hourglass aria-hidden="true" className="size-5 shrink-0 text-accent" />
            Waiting for your approval
          </p>
          <Link
            href={view.approverLink.href}
            className={cn(buttonVariants({ variant: 'primary' }), 'w-full sm:w-auto')}
          >
            <ListChecks aria-hidden="true" className="size-4.5" strokeWidth={1.75} />
            Open in Approvals
          </Link>
        </div>
      ) : null}

      <RecordCard>
        {view.own ? null : (
          <Row term="Employee">
            {view.employee.name}
            <span className="text-text-secondary numeric"> · {view.employee.employeeNumber}</span>
          </Row>
        )}
        <Row term={request.kind === 'offset' ? 'Kind' : 'Type'}>
          {request.kind === 'offset' ? TIME_OFF_KIND_LABELS.offset : view.typeName}
        </Row>
        <Row term="Status">
          <span className="flex flex-wrap items-center gap-1.5">
            <TimeOffStatusBadge status={request.status} />
          </span>
        </Row>
        <Row term="When">
          <span className="numeric">{timeOffWhenText(request)}</span>
        </Row>
        {amount ? (
          <Row term={request.kind === 'offset' ? 'Offset hours' : 'Days charged'}>
            <span className="numeric">{amount}</span>
          </Row>
        ) : null}
        {splitKnown ? (
          <Row term="Pay">
            {unpaid > 0 ? (
              <span className="inline-flex items-start gap-1.5 font-medium text-warning-text numeric">
                <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                {formatDayCount(request.paidHalfDays ?? 0)} paid, {withoutPayText(unpaid)}
              </span>
            ) : (
              <span className="numeric">Paid</span>
            )}
          </Row>
        ) : null}
        {request.reason ? <Row term="Reason">{request.reason}</Row> : null}
        {request.submittedAt ? (
          <Row term="Sent">
            <span className="numeric">{formatDateTime(request.submittedAt)}</span>
          </Row>
        ) : null}
        {request.remarks ? <Row term="Remarks">“{request.remarks}”</Row> : null}
        {request.cancelledAt ? (
          <Row term="Cancelled">
            <span className="numeric">{formatDate(request.cancelledAt)}</span>
            {request.cancelReason ? ` · ${request.cancelReason}` : null}
          </Row>
        ) : null}
      </RecordCard>

      {view.attachmentHref || (view.own && (request.canEditAndResend || request.canCancel)) ? (
        <div className="flex flex-wrap gap-2">
          {view.attachmentHref ? (
            <a
              href={view.attachmentHref}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ variant: 'secondary' })}
            >
              <ExternalLink aria-hidden="true" className="size-4" />
              Open attachment
              <span className="sr-only">, opens in a new tab</span>
            </a>
          ) : null}
          {view.own && request.canEditAndResend ? (
            <Link
              href={`${OWN_TIME_OFF_HREF}#resend-${request.id}`}
              className={buttonVariants({ variant: 'tinted' })}
            >
              <Pencil aria-hidden="true" className="size-4" />
              Edit and send again
            </Link>
          ) : null}
          {view.own && request.canCancel ? (
            <Link
              href={`${OWN_TIME_OFF_HREF}#cancel-${request.id}`}
              className={cn(buttonVariants({ variant: 'secondary' }), 'text-destructive-text')}
            >
              <XCircle aria-hidden="true" className="size-4" />
              {request.status === 'returned' ? 'Cancel' : 'Cancel request'}
            </Link>
          ) : null}
        </div>
      ) : null}

      {view.days.length > 0 ? (
        <section aria-labelledby={daysId} className="flex flex-col gap-2">
          <h2 id={daysId} className="pl-4 text-footnote font-semibold text-text-secondary">
            Days
          </h2>
          <ul className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
            {view.days.map((day) => {
              const note = day.excluded
                ? `${DAY_EXCLUSION_LABELS[day.excluded]}, not charged`
                : request.kind === 'offset'
                  ? formatOffsetHours(day.minutes)
                  : !splitKnown
                    ? formatDayCount(day.halfDays)
                    : day.unpaidHalfDays > 0
                      ? day.paidHalfDays > 0
                        ? `${formatDayCount(day.paidHalfDays)} paid, ${withoutPayText(day.unpaidHalfDays)}`
                        : withoutPayText(day.unpaidHalfDays)
                      : `${formatDayCount(day.halfDays)}, paid`;
              const warn = splitKnown && !day.excluded && day.unpaidHalfDays > 0;
              return (
                <li
                  key={day.date}
                  className="flex min-h-11 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-4 py-2.5"
                >
                  <span className="text-subheadline numeric">{formatShortDay(day.date)}</span>
                  <span
                    className={cn(
                      'text-footnote numeric',
                      warn
                        ? 'font-medium text-warning-text'
                        : day.excluded
                          ? 'text-text-secondary'
                          : undefined,
                    )}
                  >
                    {note}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {view.approvals.length > 0 ? (
        <section aria-labelledby={historyId} className="flex flex-col gap-2">
          <h2 id={historyId} className="pl-4 text-footnote font-semibold text-text-secondary">
            Approval history
          </h2>
          <ol className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
            {view.approvals.map((approval, index) => (
              <ApprovalRound key={approval.id} approval={approval} index={index} />
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}
