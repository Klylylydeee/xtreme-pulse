'use client';

import { type ReactNode, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronRight, Plus, TriangleAlert } from 'lucide-react';
import { formatDate } from '@pulse/core';
import {
  CONTRIBUTION_BASE_KIND_LABELS,
  PAYROLL_RUN_SETTINGS_LABEL,
  type PayrollRunSettings,
  UNWORKED_SPECIAL_DAY_TREATMENT_LABELS,
} from '@pulse/talent';
import type { PayrollRunSettingsVersionView, PayrollRunSettingsView } from '@pulse/talent/server';
import { cn } from '@pulse/ui';
import { Button } from '@pulse/ui/components/button';
import { Sheet, SheetContent } from '@pulse/ui/components/sheet';
import { useReturnFocus } from '@pulse/ui/hooks/use-return-focus';
import { Badge, plural } from '@/components/org-structure';
import { PayrollRunVersionSheet } from './payroll-run-version-sheet';

// Spec: docs/modules/talent.md#payroll-run-computation-build-step-29 ("Run settings", "Screens":
// Payroll settings › Pay schedule; decision 326 in docs/BUILD_PLAN.md) — the "Payroll run" card
// in the Pay schedule segment of `/talent/payroll-settings`: `talent.payrollRunSettings`, its own
// versioned setting beside the payroll settings (HANDOFF assumption 258).
//
// - The version in effect: each agency's contribution base, a monthly-rated employee's unworked
//   special day, and the cut-offs a run reconciles, as a list of short rows (no table, so a phone
//   never scrolls sideways).
// - Then the scheduled versions and the history, read-only, each opening to its values.
// - "Add version" (the server's `canAddVersion`: Talent Owner and HR or the System Administrator;
//   the action and the service check again) opens `PayrollRunVersionSheet`.
// - Nothing here is sensitive; the values are company policy.

const STATUS_LABELS: Record<PayrollRunSettingsVersionView['status'], string> = {
  inEffect: 'In effect',
  scheduled: 'Scheduled',
  past: 'Superseded',
};

const SEEDED_RUN_NOTE =
  'Seeded: the accountant checks each choice before the first payroll is computed.';

const CONTRIBUTION_ROWS = [
  { key: 'sss', label: 'SSS contribution base' },
  { key: 'philhealth', label: 'PhilHealth contribution base' },
  { key: 'pagibig', label: 'Pag-IBIG contribution base' },
] as const satisfies readonly {
  key: keyof PayrollRunSettings['contributionBases'];
  label: string;
}[];

/** "24 cut-offs (about a year)". */
export function lookbackText(cutOffs: number): string {
  const text = plural(cutOffs, 'cut-off', 'cut-offs');
  if (cutOffs % 24 === 0) {
    const years = cutOffs / 24;
    return `${text} (about ${years === 1 ? 'a year' : `${years} years`})`;
  }
  if (cutOffs % 2 === 0) return `${text} (about ${plural(cutOffs / 2, 'month', 'months')})`;
  return text;
}

function ValueRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 px-4 py-2.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
      <dt className="text-footnote text-text-secondary sm:text-subheadline">{label}</dt>
      <dd className="text-subheadline font-medium sm:text-right">{children}</dd>
    </div>
  );
}

/** The values of one version, as short rows. */
export function PayrollRunSettingsValue({ value }: { value: PayrollRunSettings }) {
  return (
    <dl className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
      {CONTRIBUTION_ROWS.map((row) => (
        <ValueRow key={row.key} label={row.label}>
          {CONTRIBUTION_BASE_KIND_LABELS[value.contributionBases[row.key]]}
        </ValueRow>
      ))}
      <ValueRow label="Monthly-rated: unworked special day">
        {UNWORKED_SPECIAL_DAY_TREATMENT_LABELS[value.monthlyRatedUnworkedSpecialDay]}
      </ValueRow>
      <ValueRow label="Earlier cut-offs reconciled">
        <span className="numeric">{lookbackText(value.adjustmentLookbackCutOffs)}</span>
      </ValueRow>
    </dl>
  );
}

function SeededNote() {
  return (
    <p className="flex items-start gap-2 text-footnote font-medium text-warning-text">
      <TriangleAlert aria-hidden="true" className="mt-px size-4 shrink-0" />
      <span>{SEEDED_RUN_NOTE}</span>
    </p>
  );
}

function SourceLine({ version }: { version: PayrollRunSettingsVersionView }) {
  return (
    <span className="break-words">
      Source: {version.source?.trim() ? version.source : 'Not recorded'}
    </span>
  );
}

function RunVersionDisclosure({ version }: { version: PayrollRunSettingsVersionView }) {
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
        <PayrollRunSettingsValue value={version.value} />
      </div>
    </details>
  );
}

/**
 * The "Payroll run" card of Payroll settings › Pay schedule. `onAdded` shows the page's
 * confirmation line after a new version.
 */
export function PayrollRunSettingsCard({
  view,
  onAdded,
}: {
  view: PayrollRunSettingsView;
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
            {PAYROLL_RUN_SETTINGS_LABEL}
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
              'No version yet. Run pnpm seed:admin to add the seeded payroll run settings.'
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
            aria-label={`Add version: ${PAYROLL_RUN_SETTINGS_LABEL}`}
          >
            <Plus aria-hidden="true" className="size-4.5" />
            Add version
          </Button>
        ) : null}
      </div>

      <p className="px-4 text-footnote text-text-secondary">
        A payroll run uses the version in effect on its cut-off’s first day.
      </p>

      {inEffect ? (
        <div className="flex flex-col gap-3">
          {inEffect.seeded ? <SeededNote /> : null}
          <PayrollRunSettingsValue value={inEffect.value} />
        </div>
      ) : null}

      {scheduled.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="px-4 text-footnote font-semibold text-text-secondary">Scheduled</h3>
          <div className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
            {scheduled.map((version) => (
              <RunVersionDisclosure key={version.id} version={version} />
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
              <RunVersionDisclosure key={version.id} version={version} />
            ))}
          </div>
          <p className="px-4 text-footnote text-text-secondary">
            Versions are never changed or withdrawn. A wrong version is replaced by a newer one from
            its own date.
          </p>
        </div>
      ) : null}

      {view.canAddVersion ? (
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent aria-describedby={undefined} onCloseAutoFocus={focus.onCloseAutoFocus}>
            <PayrollRunVersionSheet
              key={session}
              view={view}
              onSaved={(version) => {
                setOpen(false);
                onAdded(
                  `Version added: ${PAYROLL_RUN_SETTINGS_LABEL} from ${formatDate(version.effectiveFrom)}.`,
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
