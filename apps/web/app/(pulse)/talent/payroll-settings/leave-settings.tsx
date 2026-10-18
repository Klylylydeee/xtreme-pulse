'use client';

import { type ReactNode, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronRight, Lock, Plus, TriangleAlert } from 'lucide-react';
import { formatDate } from '@pulse/core';
import {
  formatDayCount,
  formatHours,
  GO_LIVE_DATE_MISSING_MESSAGE,
  halfDaysOf,
  LEAVE_BALANCE_KINDS,
  LEAVE_BALANCE_KIND_LABELS,
  LEAVE_COUNT_DAYS_LABELS,
  LEAVE_ELIGIBLE_STATUSES,
  type LeaveBalanceKind,
  type LeaveSettings,
  type LeaveType,
  SEX_LABELS,
} from '@pulse/talent';
import type { LeaveSettingsVersionView, LeaveSettingsView } from '@pulse/talent/server';
import { cn } from '@pulse/ui';
import { Button } from '@pulse/ui/components/button';
import { Sheet, SheetContent } from '@pulse/ui/components/sheet';
import { useReturnFocus } from '@pulse/ui/hooks/use-return-focus';
import { Badge, plural } from '@/components/org-structure';
import { LeaveVersionSheet } from './leave-version-sheet';

// Spec: docs/modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28 ("Leave
// settings", "Screens": Payroll settings › Leave; decisions 300 and 306 in docs/BUILD_PLAN.md) —
// the Leave segment of `/talent/payroll-settings`: `talent.leaveSettings`, its own versioned
// setting beside the payroll settings.
//
// - The version in effect: the go-live date (or "Set the go-live date first."), the offset time
//   off minimum and step, and the leave types as a grouped list by how their limit works
//   (credited, per request, per calendar year), each type a block of short lines, so a phone shows
//   a list and never a wide table.
// - Then the scheduled versions and the history, read-only, each opening to its figures.
// - "Add version" (the server's `canAddVersion`: Talent Owner and HR or the System Administrator;
//   the action and the service check again) opens `LeaveVersionSheet`. Once any opening balance
//   exists the go-live date is locked (`goLiveDateLocked`), and the sheet says so.
// - Nothing here is sensitive; leave types and their figures are company policy and law.

const STATUS_LABELS: Record<LeaveSettingsVersionView['status'], string> = {
  inEffect: 'In effect',
  scheduled: 'Scheduled',
  past: 'Superseded',
};

const SEEDED_LEAVE_NOTE =
  'Seeded: HR and counsel check every leave type and figure before real leave is filed.';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "01-01" → "Jan 1". */
function monthDayText(value: string): string {
  const [month, day] = value.split('-').map(Number);
  const name = month ? MONTHS[month - 1] : undefined;
  return name && day ? `${name} ${day}` : value;
}

function daysText(days: string): string {
  try {
    return formatDayCount(halfDaysOf(days));
  } catch {
    return `${days} days`;
  }
}

/** "5 days a year, credited" / "Up to 105 days per request" / "Up to 7 days per calendar year". */
export function leaveLimitText(type: Pick<LeaveType, 'balance' | 'days'>): string {
  const days = daysText(type.days);
  switch (type.balance) {
    case 'credited':
      return `${days} a year, credited`;
    case 'perEvent':
      return `Up to ${days} per request`;
    case 'perYear':
      return `Up to ${days} per calendar year`;
  }
}

function countingText(type: LeaveType): string {
  return [
    LEAVE_COUNT_DAYS_LABELS[type.countDays],
    type.halfDays ? 'half days allowed' : 'whole days only',
  ].join(' · ');
}

function creditingText(type: LeaveType): string | null {
  const crediting = type.crediting;
  if (!crediting) return null;
  return [
    `Credited every ${monthDayText(crediting.annualCreditOn)}`,
    crediting.prorateFromRegularization
      ? 'prorated from the regularization date'
      : 'in full from the regularization date',
    crediting.carryOverCapDays === null
      ? 'no carry-over cap'
      : `carry-over up to ${daysText(crediting.carryOverCapDays)}`,
  ].join(' · ');
}

function eligibilityText(type: LeaveType): string {
  const { employmentStatuses, sex, minServiceMonths, maxRequests } = type.eligibility;
  const statuses =
    employmentStatuses.length === LEAVE_ELIGIBLE_STATUSES.length
      ? 'Every employment status'
      : employmentStatuses.join(', ');
  return [
    sex ? `${SEX_LABELS[sex]} only` : null,
    statuses,
    minServiceMonths ? `${plural(minServiceMonths, 'month', 'months')} since hired` : null,
    maxRequests ? `at most ${plural(maxRequests, 'approved request', 'approved requests')}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function filingText(type: LeaveType): string {
  const { minNoticeDays, allowFuture, allowPast } = type.filing;
  const parts: string[] = [];
  if (allowFuture) {
    parts.push(
      minNoticeDays ? `At least ${plural(minNoticeDays, 'day', 'days')} ahead` : 'Ahead of the day',
    );
  }
  if (allowPast) {
    parts.push(
      allowFuture
        ? 'or after it, up to the timesheet deadline of its cut-off'
        : 'On or after the day, up to the timesheet deadline of its cut-off',
    );
  }
  let text = parts.join(', ');
  if (!allowFuture) text += '; never a future day';
  if (!allowPast) text += '; never a past day';
  return text;
}

function attachmentText(type: LeaveType): string {
  if (!type.attachment) return 'No attachment';
  return `${type.attachment.label}, ${type.attachment.required ? 'required' : 'optional'}`;
}

/** One leave type: its name and badges, then a short line per rule. */
function LeaveTypeRow({ type }: { type: LeaveType }) {
  const crediting = creditingText(type);
  return (
    <li className="flex flex-col gap-1 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-subheadline font-semibold">{type.name}</span>
        <span className="text-footnote text-text-secondary">({type.shortName})</span>
        {type.active ? null : <Badge>Retired</Badge>}
        {type.paid ? null : <Badge>Without pay</Badge>}
        {type.confidential ? <Badge tone="accent">Confidential</Badge> : null}
      </div>
      <p className="numeric text-footnote text-text-primary">
        {leaveLimitText(type)} · {countingText(type)}
      </p>
      {crediting ? <p className="text-footnote text-text-secondary">{crediting}</p> : null}
      <p className="text-footnote text-text-secondary">Who: {eligibilityText(type)}</p>
      <p className="text-footnote text-text-secondary">Filing: {filingText(type)}</p>
      <p className="text-footnote text-text-secondary">Attachment: {attachmentText(type)}</p>
      {type.legalBasis ? (
        <p className="text-footnote text-text-secondary">Legal basis: {type.legalBasis}</p>
      ) : null}
    </li>
  );
}

const GROUP_TITLES: Record<LeaveBalanceKind, string> = {
  credited: 'Credited leave (a running balance)',
  perEvent: LEAVE_BALANCE_KIND_LABELS.perEvent,
  perYear: LEAVE_BALANCE_KIND_LABELS.perYear,
};

/** The figures of one version: the go-live date, offset time off, and the types grouped. */
export function LeaveSettingsValue({ value }: { value: LeaveSettings }) {
  const baseId = useId();
  return (
    <div className="flex flex-col gap-4">
      <dl className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
        <div className="flex flex-col gap-0.5 px-4 py-2.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
          <dt className="text-footnote text-text-secondary sm:text-subheadline">Go-live date</dt>
          <dd
            className={cn(
              'numeric text-subheadline',
              value.goLiveDate ? 'font-medium' : 'text-text-secondary',
            )}
          >
            {value.goLiveDate ? formatDate(value.goLiveDate) : 'Not set'}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5 px-4 py-2.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
          <dt className="text-footnote text-text-secondary sm:text-subheadline">Offset time off</dt>
          <dd className="numeric text-subheadline font-medium">
            At least {formatHours(value.offsetTimeOff.minimumMinutes)}, in steps of{' '}
            {formatHours(value.offsetTimeOff.stepMinutes)}
          </dd>
        </div>
      </dl>
      {LEAVE_BALANCE_KINDS.map((kind) => {
        const types = value.types.filter((type) => type.balance === kind);
        if (types.length === 0) return null;
        const headingId = `${baseId}-${kind}`;
        return (
          <div key={kind} className="flex flex-col gap-2">
            <h4 id={headingId} className="px-4 text-footnote font-semibold text-text-secondary">
              {GROUP_TITLES[kind]}
            </h4>
            <ul
              aria-labelledby={headingId}
              className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card"
            >
              {types.map((type) => (
                <LeaveTypeRow key={type.key} type={type} />
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function SeededNote() {
  return (
    <p className="flex items-start gap-2 text-footnote font-medium text-warning-text">
      <TriangleAlert aria-hidden="true" className="mt-px size-4 shrink-0" />
      <span>{SEEDED_LEAVE_NOTE}</span>
    </p>
  );
}

function SourceLine({ version }: { version: LeaveSettingsVersionView }) {
  return (
    <span className="break-words">
      Source: {version.source?.trim() ? version.source : 'Not recorded'}
    </span>
  );
}

function LeaveVersionDisclosure({ version }: { version: LeaveSettingsVersionView }) {
  return (
    <details className="group">
      <summary
        className={cn(
          'flex min-h-11 cursor-pointer list-none items-center gap-3 px-4 py-2.5 [&::-webkit-details-marker]:hidden',
          'transition-colors duration-fast hover:bg-accent-subtle focus-visible:outline-offset-[-2px]',
        )}
      >
        <ChevronRight
          aria-hidden="true"
          className="size-4 shrink-0 text-text-secondary transition-transform duration-fast group-open:rotate-90 motion-reduce:transition-none"
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="numeric text-subheadline font-semibold">
              From {formatDate(version.effectiveFrom)}
            </span>
            <Badge tone={version.status === 'inEffect' ? 'accent' : 'neutral'}>
              {STATUS_LABELS[version.status]}
            </Badge>
            {version.seeded ? <Badge>Seeded</Badge> : null}
          </span>
          <span className="text-footnote text-text-secondary">
            <SourceLine version={version} />
          </span>
        </span>
      </summary>
      <div className="flex flex-col gap-3 bg-bg-grouped px-3 py-3 sm:px-4">
        {version.seeded ? <SeededNote /> : null}
        <LeaveSettingsValue value={version.value} />
      </div>
    </details>
  );
}

function Notice({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-card bg-surface px-4 py-3 text-footnote text-text-secondary shadow-card">
      {icon}
      <span>{children}</span>
    </p>
  );
}

/**
 * Payroll settings › Leave. `onAdded` shows the page's confirmation line after a new version.
 */
export function LeaveSettingsSegment({
  view,
  onAdded,
}: {
  view: LeaveSettingsView;
  onAdded: (message: string) => void;
}) {
  const router = useRouter();
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState(0);
  const focus = useReturnFocus();
  const { inEffect, scheduled, history } = view;
  const goLiveDate = inEffect?.value.goLiveDate ?? null;

  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 id={titleId} className="text-title-3">
            Leave
          </h2>
          <p className="text-footnote text-text-secondary">
            {inEffect ? (
              <>
                <span className="numeric">
                  In effect since {formatDate(inEffect.effectiveFrom)}
                </span>
                {' · '}
                <SourceLine version={inEffect} />
              </>
            ) : scheduled.length > 0 ? (
              'No version is in effect yet. The first one is scheduled below.'
            ) : (
              'No version yet. Run pnpm seed:admin to add the seeded leave types.'
            )}
          </p>
        </div>
        {view.canAddVersion ? (
          <Button
            variant="secondary"
            onClick={(event) => {
              focus.remember(event.currentTarget);
              setSession((count) => count + 1);
              setOpen(true);
            }}
            aria-label="Add version: Leave"
          >
            <Plus aria-hidden="true" className="size-4.5" />
            Add version
          </Button>
        ) : null}
      </div>

      {inEffect && goLiveDate === null ? (
        <Notice
          icon={
            <TriangleAlert aria-hidden="true" className="mt-px size-4 shrink-0 text-warning-text" />
          }
        >
          <span className="font-medium text-text-primary">{GO_LIVE_DATE_MISSING_MESSAGE}</span> No
          leave is credited and no opening balance can be entered until a version sets the day Pulse
          Talent goes live.
        </Notice>
      ) : null}
      {view.goLiveDateLocked ? (
        <Notice icon={<Lock aria-hidden="true" className="mt-px size-4 shrink-0" />}>
          Opening balances have been entered, so the go-live date can’t change in a new version.
        </Notice>
      ) : null}

      {inEffect ? (
        <div className="flex flex-col gap-3">
          {inEffect.seeded ? <SeededNote /> : null}
          <LeaveSettingsValue value={inEffect.value} />
        </div>
      ) : null}

      {scheduled.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="px-4 text-footnote font-semibold text-text-secondary">Scheduled</h3>
          <div className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
            {scheduled.map((version) => (
              <LeaveVersionDisclosure key={version.id} version={version} />
            ))}
          </div>
        </div>
      ) : null}

      {history.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="px-4 text-footnote font-semibold text-text-secondary">
            History · {plural(history.length, 'version', 'versions')}, newest first
          </h3>
          <div className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
            {history.map((version) => (
              <LeaveVersionDisclosure key={version.id} version={version} />
            ))}
          </div>
          <p className="px-4 text-footnote text-text-secondary">
            Versions are never changed or withdrawn. A wrong version is replaced by a newer one from
            its own date. A leave type is never removed, only retired.
          </p>
        </div>
      ) : null}

      {view.canAddVersion ? (
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent
            aria-describedby={undefined}
            onCloseAutoFocus={focus.onCloseAutoFocus}
            className="sm:w-[min(44rem,calc(100vw-2rem))]"
          >
            <LeaveVersionSheet
              key={session}
              view={view}
              onSaved={(version) => {
                setOpen(false);
                onAdded(`Version added: Leave from ${formatDate(version.effectiveFrom)}.`);
                router.refresh();
              }}
            />
          </SheetContent>
        </Sheet>
      ) : null}
    </section>
  );
}
