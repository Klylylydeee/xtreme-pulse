'use client';

import { type ReactNode, useId, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ChevronRight, CircleCheck, Plus, TriangleAlert } from 'lucide-react';
import { formatDate } from '@pulse/core';
import {
  PAYROLL_SETTING_LABELS,
  type PayrollSettingKey,
  type PayrollSettingsView,
  type PayrollSettingVersionView,
  type PayrollSettingView,
  type PayrollVersionStatus,
  SEEDED_VERSION_NOTE,
  type WorkRegion,
} from '@pulse/talent';
import { cn } from '@pulse/ui';
import { Button, buttonVariants } from '@pulse/ui/components/button';
import { PageHeader } from '@pulse/ui/components/page-header';
import { SegmentedControl } from '@pulse/ui/components/segmented-control';
import { Sheet, SheetContent } from '@pulse/ui/components/sheet';
import { useReturnFocus } from '@pulse/ui/hooks/use-return-focus';
import { Badge } from '@/components/org-structure';
import { type AddedVersion, AddVersionSheet } from './add-version-sheet';
import { BelowMinimumWageSheet, useBelowWageList } from './below-minimum-wage-sheet';
import { PAYROLL_VIEWS, type PayrollView, TABLE_SETTINGS } from './payroll-format';
import { type BelowWageRenderer, SettingValue } from './setting-values';
import type { AllowanceEditorContext } from './value-editors';

// Spec: docs/modules/talent.md#payroll-settings-and-allowances-build-step-23 ("Payroll settings
// page", decisions 197, 198, 207 and 208 in docs/BUILD_PLAN.md) — `/talent/payroll-settings`.
//
// - A segmented control switches between Pay schedule, Contributions (SSS, PhilHealth, Pag-IBIG),
//   Withholding tax, Premiums & benefits (premium rates, de minimis limits, the 13th month
//   ceiling), Minimum wage and Allowance types. It scrolls sideways inside its own strip on a
//   phone; the page never does.
// - Each setting shows its version in effect ("In effect since <date> · Source: …"), its scheduled
//   versions and its history, read-only; a seeded version carries the seeded note.
// - "Add version" (Talent Owner and HR or the System Administrator: `canAddVersion`) opens a sheet.
// - Minimum wage: for a viewer who may see them, each version and region shows the count of active
//   employees paid below it and "View list", with no amounts.

const STATUS_LABELS: Record<PayrollVersionStatus, string> = {
  inEffect: 'In effect',
  scheduled: 'Scheduled',
  past: 'Superseded',
};

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

function SourceLine({ version }: { version: PayrollSettingVersionView }) {
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
      <span>{SEEDED_VERSION_NOTE}</span>
    </p>
  );
}

/** A collapsible row: a version that isn't in effect, with its figures inside. */
function VersionDisclosure({
  version,
  settingKey,
  belowWage,
}: {
  version: PayrollSettingVersionView;
  settingKey: PayrollSettingKey;
  belowWage?: (versionId: string) => BelowWageRenderer | undefined;
}) {
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
        <SettingValue
          settingKey={settingKey}
          value={version.value}
          belowWage={belowWage?.(version.id)}
        />
      </div>
    </details>
  );
}

function SettingSection({
  setting,
  canAddVersion,
  onAddVersion,
  belowWage,
}: {
  setting: PayrollSettingView;
  canAddVersion: boolean;
  onAddVersion: (key: PayrollSettingKey, trigger: HTMLElement) => void;
  belowWage?: (versionId: string) => BelowWageRenderer | undefined;
}) {
  const titleId = useId();
  const { inEffect, scheduled, history } = setting;
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 id={titleId} className="text-title-3">
            {setting.label}
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
              'No version yet.'
            )}
          </p>
        </div>
        {canAddVersion ? (
          <Button
            variant="secondary"
            onClick={(event) => onAddVersion(setting.key, event.currentTarget)}
            aria-label={`Add version: ${setting.label}`}
          >
            <Plus aria-hidden="true" className="size-4.5" />
            Add version
          </Button>
        ) : null}
      </div>

      {inEffect ? (
        <div className="flex flex-col gap-3">
          {inEffect.seeded ? <SeededNote /> : null}
          <SettingValue
            settingKey={setting.key}
            value={inEffect.value}
            belowWage={belowWage?.(inEffect.id)}
          />
        </div>
      ) : null}

      {scheduled.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="flex items-center gap-2 px-4 text-footnote font-semibold text-text-secondary">
            Scheduled
          </h3>
          <div className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
            {scheduled.map((version) => (
              <VersionDisclosure
                key={version.id}
                version={version}
                settingKey={setting.key}
                belowWage={belowWage}
              />
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
              <VersionDisclosure
                key={version.id}
                version={version}
                settingKey={setting.key}
                belowWage={belowWage}
              />
            ))}
          </div>
          <p className="px-4 text-footnote text-text-secondary">
            Versions are never changed or withdrawn. A wrong version is replaced by a newer one from
            its own date.
          </p>
        </div>
      ) : null}
    </section>
  );
}

/** The count of employees paid below one region of a wage order, and "View list". No amounts. */
function BelowWageCell({
  count,
  wageOrder,
  onView,
}: {
  count: number | null;
  wageOrder: string;
  onView: (trigger: HTMLElement) => void;
}) {
  if (count === null) return <span className="text-text-secondary">Not checked</span>;
  if (count === 0) return <span className="text-text-secondary">No one</span>;
  const people = plural(count, 'employee', 'employees');
  return (
    <span className="flex items-center gap-2">
      <span className="numeric inline-flex items-center gap-1.5 font-medium text-warning-text">
        <TriangleAlert aria-hidden="true" className="size-4 shrink-0" />
        {people}
      </span>
      <Button
        variant="plain"
        className="-my-1.5 px-2 text-accent"
        aria-label={`View the ${people} paid below ${wageOrder}`}
        onClick={(event) => onView(event.currentTarget)}
      >
        View list
      </Button>
    </span>
  );
}

export function PayrollSettingsManager({ view }: { view: PayrollSettingsView }) {
  const router = useRouter();
  const [current, setCurrent] = useState<PayrollView>('schedule');
  const [adding, setAdding] = useState<PayrollSettingKey | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addSession, setAddSession] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const addFocus = useReturnFocus();
  const listFocus = useReturnFocus();
  const [listOpen, setListOpen] = useState(false);
  const belowList = useBelowWageList();

  const section =
    PAYROLL_VIEWS.find((candidate) => candidate.value === current) ?? PAYROLL_VIEWS[0];

  const allowanceContext = useMemo((): AllowanceEditorContext => {
    const types = view.settings['talent.allowanceTypes'];
    const start = types.inEffect ?? types.history[0] ?? null;
    const limits = view.settings['talent.deMinimisLimits'].inEffect;
    return {
      lockedCount: start?.value.types.length ?? 0,
      deMinimisOptions:
        limits?.value.items.map((item) => ({ value: item.key, label: item.label })) ?? [],
    };
  }, [view.settings]);

  const counts = view.minimumWageBelow;
  const belowWage = counts
    ? (versionId: string): BelowWageRenderer =>
        function BelowWage(region: WorkRegion): ReactNode {
          const entry = counts.find(
            (count) => count.versionId === versionId && count.region === region,
          );
          const wageOrder =
            view.settings['talent.minimumWages'].history
              .find((version) => version.id === versionId)
              ?.value.regions.find((row) => row.region === region)?.wageOrder ?? 'this wage order';
          return (
            <BelowWageCell
              count={entry?.count ?? null}
              wageOrder={wageOrder}
              onView={(trigger) => {
                listFocus.remember(trigger);
                setListOpen(true);
                void belowList.load({ versionId, region, wageOrder });
              }}
            />
          );
        }
    : undefined;

  const addingSetting = adding ? view.settings[adding] : null;

  return (
    <>
      <div className="flex flex-col gap-3">
        <Link
          href="/talent"
          className={buttonVariants({
            variant: 'plain',
            className: '-ml-3 w-fit text-accent',
          })}
        >
          <ArrowLeft aria-hidden="true" className="size-4.5" />
          Employees
        </Link>
        <PageHeader
          title="Payroll settings"
          description="Pay schedule, contribution tables, tax brackets, premium rates, minimum wages and allowance types. Each change is a new version from its own date."
        />
      </div>

      <div role="status" className="empty:hidden">
        {notice ? (
          <p className="flex items-start gap-2 rounded-card bg-surface px-4 py-3 text-footnote font-medium text-success-text shadow-card">
            <CircleCheck aria-hidden="true" className="mt-px size-4 shrink-0" />
            <span>{notice}</span>
          </p>
        ) : null}
      </div>

      <p className="flex items-start gap-2 rounded-card bg-surface px-4 py-3 text-footnote text-text-secondary shadow-card">
        <TriangleAlert aria-hidden="true" className="mt-px size-4 shrink-0 text-warning-text" />
        <span>
          Every seeded rate, table and amount is an assumption until HR or the accountant checks it
          against the current SSS, PhilHealth, Pag-IBIG, BIR and DOLE issuances, before the first
          payroll.
        </span>
      </p>

      {/* Scrolls sideways inside this strip on a phone, so the page never does. */}
      <div className="-mx-4 overflow-x-auto overscroll-x-contain px-4 py-1 sm:mx-0 sm:px-1">
        <SegmentedControl
          label="Payroll settings view"
          track="page"
          className="max-w-none"
          options={PAYROLL_VIEWS.map((option) => ({ value: option.value, label: option.label }))}
          value={current}
          onValueChange={setCurrent}
        />
      </div>

      <div className="flex flex-col gap-10">
        {section?.keys.map((key) => (
          <SettingSection
            key={key}
            setting={view.settings[key]}
            canAddVersion={view.canAddVersion}
            onAddVersion={(next, trigger) => {
              addFocus.remember(trigger);
              setNotice(null);
              setAdding(next);
              setAddSession((count) => count + 1);
              setAddOpen(true);
            }}
            belowWage={key === 'talent.minimumWages' ? belowWage : undefined}
          />
        ))}
      </div>

      {view.canAddVersion ? (
        <Sheet open={addOpen} onOpenChange={setAddOpen}>
          <SheetContent
            aria-describedby={undefined}
            onCloseAutoFocus={addFocus.onCloseAutoFocus}
            className={
              adding && TABLE_SETTINGS.has(adding)
                ? 'sm:w-[min(60rem,calc(100vw-2rem))]'
                : undefined
            }
          >
            {addingSetting ? (
              <AddVersionSheet
                key={addSession}
                setting={addingSetting}
                allowanceContext={allowanceContext}
                onSaved={(version: AddedVersion) => {
                  setAddOpen(false);
                  setNotice(
                    `Version added: ${PAYROLL_SETTING_LABELS[version.key]} from ${formatDate(version.effectiveFrom)}.`,
                  );
                  router.refresh();
                }}
              />
            ) : null}
          </SheetContent>
        </Sheet>
      ) : null}

      {counts ? (
        <Sheet open={listOpen} onOpenChange={setListOpen}>
          <SheetContent aria-describedby={undefined} onCloseAutoFocus={listFocus.onCloseAutoFocus}>
            {belowList.target ? (
              <BelowMinimumWageSheet
                target={belowList.target}
                state={belowList.state}
                onRetry={() => {
                  if (belowList.target) void belowList.load(belowList.target);
                }}
              />
            ) : null}
          </SheetContent>
        </Sheet>
      ) : null}
    </>
  );
}
