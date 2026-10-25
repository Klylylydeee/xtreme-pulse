'use client';

import { type ReactNode, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronRight, Plus, TriangleAlert } from 'lucide-react';
import { formatDate } from '@pulse/core';
import {
  REMITTANCE_AGENCIES,
  REMITTANCE_AGENCY_LABELS,
  REMITTANCE_SETTINGS_LABEL,
  type RemittanceDueRule,
  type RemittanceSettings,
} from '@pulse/talent';
import type { RemittanceSettingsVersionView, RemittanceSettingsView } from '@pulse/talent/server';
import { cn } from '@pulse/ui';
import { Button } from '@pulse/ui/components/button';
import { Sheet, SheetContent } from '@pulse/ui/components/sheet';
import { useReturnFocus } from '@pulse/ui/hooks/use-return-focus';
import { Badge, plural } from '@/components/org-structure';
import { RemittanceVersionSheet } from './remittance-version-sheet';

// Spec: docs/modules/talent.md#employer-contributions-and-remittances-build-step-211 ("Remittance
// settings", "Screens": Payroll settings › Pay schedule; decisions 383 and 384 in
// docs/BUILD_PLAN.md) — the "Remittances" card in the Pay schedule segment of
// `/talent/payroll-settings`: `talent.remittanceSettings`, its own versioned setting.
//
// - The version in effect: each agency's due date in words and the reminder lead days, as short
//   rows (no table, so a phone never scrolls sideways).
// - Then the scheduled versions and the history, read-only, each opening to its values.
// - "Add version" (the server's `canAddVersion`: Talent Owner and HR or the System Administrator;
//   the action and the service check again) opens `RemittanceVersionSheet`.
// - Nothing here is sensitive; the values are agency rules and company policy.

const STATUS_LABELS: Record<RemittanceSettingsVersionView['status'], string> = {
  inEffect: 'In effect',
  scheduled: 'Scheduled',
  past: 'Superseded',
};

const SEEDED_NOTE =
  'Seeded with the earliest possible date of each agency: HR sets the company’s own dates before relying on the reminders.';

const ordinal = (day: number) => {
  const tens = day % 100;
  if (tens >= 11 && tens <= 13) return `${day}th`;
  const suffixes: Record<number, string> = { 1: 'st', 2: 'nd', 3: 'rd' };
  return `${day}${suffixes[day % 10] ?? 'th'}`;
};

/** "The last day of the next month", "The 15th of the next month; December's on the 15th". */
export function dueRuleText(rule: RemittanceDueRule): string {
  const when = rule.monthsAfter === 1 ? 'the next month' : 'the second month after';
  const day = rule.dueDay >= 31 ? 'The last day' : `The ${ordinal(rule.dueDay)}`;
  const december =
    rule.decemberDueDay === null
      ? ''
      : `; December’s on the ${rule.decemberDueDay >= 31 ? 'last day' : ordinal(rule.decemberDueDay)}`;
  return `${day} of ${when}${december}`;
}

function ValueRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 px-4 py-2.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
      <dt className="text-footnote text-text-secondary sm:text-subheadline">{label}</dt>
      <dd className="text-subheadline font-medium sm:text-right">{children}</dd>
    </div>
  );
}

export function RemittanceSettingsValue({ value }: { value: RemittanceSettings }) {
  return (
    <dl className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
      {REMITTANCE_AGENCIES.map((agency) => (
        <ValueRow key={agency} label={`${REMITTANCE_AGENCY_LABELS[agency]} due`}>
          {dueRuleText(value.dueDates[agency])}
        </ValueRow>
      ))}
      <ValueRow label="First reminder">
        <span className="numeric">
          {value.reminderLeadDays === 0
            ? 'On the due date'
            : `${plural(value.reminderLeadDays, 'day', 'days')} before`}
        </span>
      </ValueRow>
    </dl>
  );
}

function SourceLine({ version }: { version: RemittanceSettingsVersionView }) {
  return (
    <span className="break-words">
      Source: {version.source?.trim() ? version.source : 'Not recorded'}
    </span>
  );
}

function SeededNote() {
  return (
    <p className="flex items-start gap-2 text-footnote font-medium text-warning-text">
      <TriangleAlert aria-hidden="true" className="mt-px size-4 shrink-0" />
      <span>{SEEDED_NOTE}</span>
    </p>
  );
}

function VersionDisclosure({ version }: { version: RemittanceSettingsVersionView }) {
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
        <RemittanceSettingsValue value={version.value} />
      </div>
    </details>
  );
}

/** The "Remittances" card of Payroll settings › Pay schedule. */
export function RemittanceSettingsCard({
  view,
  onAdded,
}: {
  view: RemittanceSettingsView;
  onAdded: (message: string) => void;
}) {
  const router = useRouter();
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState(0);
  const focus = useReturnFocus();
  const { inEffect, scheduled, history } = view;

  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 id={titleId} className="text-title-3">
            {REMITTANCE_SETTINGS_LABEL}
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
              'No version yet. Run pnpm seed:admin to add the seeded remittance settings.'
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
            aria-label={`Add version: ${REMITTANCE_SETTINGS_LABEL}`}
          >
            <Plus aria-hidden="true" className="size-4.5" />
            Add version
          </Button>
        ) : null}
      </div>

      <p className="px-4 text-footnote text-text-secondary">
        A month’s due dates use the version in effect on the first day of the month after it. Dates
        aren’t moved for weekends or holidays.
      </p>

      {inEffect ? (
        <div className="flex flex-col gap-3">
          {inEffect.seeded ? <SeededNote /> : null}
          <RemittanceSettingsValue value={inEffect.value} />
        </div>
      ) : null}

      {scheduled.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="px-4 text-footnote font-semibold text-text-secondary">Scheduled</h3>
          <div className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
            {scheduled.map((version) => (
              <VersionDisclosure key={version.id} version={version} />
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
              <VersionDisclosure key={version.id} version={version} />
            ))}
          </div>
        </div>
      ) : null}

      {view.canAddVersion ? (
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent aria-describedby={undefined} onCloseAutoFocus={focus.onCloseAutoFocus}>
            <RemittanceVersionSheet
              key={session}
              view={view}
              onSaved={(version) => {
                setOpen(false);
                onAdded(
                  `Version added: ${REMITTANCE_SETTINGS_LABEL} from ${formatDate(version.effectiveFrom)}.`,
                );
                router.refresh();
              }}
            />
          </SheetContent>
        </Sheet>
      ) : null}
    </section>
  );
}
