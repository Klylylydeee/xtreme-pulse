import { useId } from 'react';
import Link from 'next/link';
import { CalendarHeart, ChevronRight, Pencil, TriangleAlert, XCircle } from 'lucide-react';
import {
  TIME_OFF_KIND_LABELS,
  timeOffRequestHref,
  type TimeOffRequestView,
  timeOffWhenText,
  withoutPayText,
} from '@pulse/talent';
import { Button } from '@pulse/ui/components/button';
import { EmptyState } from '@pulse/ui/components/empty-state';
import { TimeOffStatusBadge } from './badges';
import { dayOfMonth } from '../timesheet-ui/format';
import { monthShortText, requestAmountText } from './format';

// Spec: docs/DESIGN_SYSTEM.md#layout--components ("Time off on a phone": request rows) and
// docs/modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28 ("Screens") —
// the requests, newest first (the server orders them), as a list, never a table. Each row is at
// least 72px tall: a date tile, the type's short name (or "Leave" for a confidential type the
// viewer may not see, or "Offset time off") and number, the days or hours, and a status badge with
// text. Leave without pay adds "1 day without pay" in `warning-text` with an icon. The row opens
// the request's page. On the own page, a returned request has "Edit and send again" and "Cancel",
// and an approved one before its first day "Cancel request" (the server's `canEditAndResend` and
// `canCancel`); elsewhere the list is read-only.

function RequestRow({
  request,
  onResend,
  onCancel,
}: {
  request: TimeOffRequestView;
  onResend?: (request: TimeOffRequestView) => void;
  onCancel?: (request: TimeOffRequestView) => void;
}) {
  const label = request.kind === 'offset' ? TIME_OFF_KIND_LABELS.offset : request.typeLabel;
  const amount = requestAmountText(request);
  const unpaid = request.unpaidHalfDays ?? 0;
  const canResend = Boolean(onResend) && request.canEditAndResend;
  const canCancel = Boolean(onCancel) && request.canCancel;
  return (
    <li id={`request-${request.id}`} className="flex flex-col">
      <Link
        href={timeOffRequestHref(request.id)}
        className="flex min-h-18 items-center gap-3 px-4 py-3 transition-colors duration-fast hover:bg-accent-subtle/40 focus-visible:outline-offset-[-2px]"
      >
        <span
          aria-hidden="true"
          className="flex size-12 shrink-0 flex-col items-center justify-center rounded-lg bg-accent-subtle text-accent"
        >
          <span className="text-caption font-medium uppercase">
            {monthShortText(request.startDate)}
          </span>
          <span className="text-headline leading-none numeric">
            {dayOfMonth(request.startDate)}
          </span>
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <span className="text-subheadline font-semibold">{label}</span>
            <span className="text-footnote text-text-secondary numeric">{request.number}</span>
          </span>
          <span className="text-footnote text-text-secondary numeric">
            {timeOffWhenText(request)}
            {amount ? ` · ${amount}` : ''}
          </span>
          <span className="flex flex-wrap items-center gap-1.5">
            <TimeOffStatusBadge status={request.status} />
            {unpaid > 0 && request.status !== 'rejected' && request.status !== 'cancelled' ? (
              <span className="inline-flex items-center gap-1 text-footnote font-medium text-warning-text numeric">
                <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" strokeWidth={2} />
                {withoutPayText(unpaid)}
              </span>
            ) : null}
          </span>
          {request.status === 'returned' && request.remarks ? (
            <span className="line-clamp-2 text-footnote text-text-secondary">
              “{request.remarks}”
            </span>
          ) : null}
        </span>
        <span className="sr-only">, open the request</span>
        <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-text-tertiary" />
      </Link>
      {canResend || canCancel ? (
        <div className="flex flex-wrap gap-2 px-4 pb-3 sm:pl-[4.75rem]">
          {canResend ? (
            <Button variant="tinted" onClick={() => onResend?.(request)}>
              <Pencil aria-hidden="true" className="size-4" />
              Edit and send again
            </Button>
          ) : null}
          {canCancel ? (
            <Button
              variant="secondary"

              className="text-destructive-text"
              onClick={() => onCancel?.(request)}
            >
              <XCircle aria-hidden="true" className="size-4" />
              {request.status === 'returned' ? 'Cancel' : 'Cancel request'}
              <span className="sr-only">, {request.number}</span>
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function RequestList({
  requests,
  own,
  onResend,
  onCancel,
}: {
  requests: readonly TimeOffRequestView[];
  own: boolean;
  onResend?: (request: TimeOffRequestView) => void;
  onCancel?: (request: TimeOffRequestView) => void;
}) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-3">
      <h2 id={titleId} className="px-1 text-headline">
        Requests
      </h2>
      {requests.length === 0 ? (
        <EmptyState
          icon={<CalendarHeart strokeWidth={1.75} />}
          title="No time off requests"
          description={
            own
              ? 'Leave and offset time off you file shows here, newest first.'
              : 'No leave or offset time off has been filed yet.'
          }
        />
      ) : (
        <ul className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
          {requests.map((request) => (
            <RequestRow
              key={request.id}
              request={request}
              onResend={own ? onResend : undefined}
              onCancel={own ? onCancel : undefined}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
