'use client';

import { useRef, useState } from 'react';
import { CircleAlert, ShieldAlert } from 'lucide-react';
import { type BusinessDate, formatDate, isBusinessDate } from '@pulse/core';
import {
  ADJUSTMENT_LOOKBACK_CUT_OFFS_MAX,
  ADJUSTMENT_LOOKBACK_CUT_OFFS_MIN,
  CONTRIBUTION_BASE_KIND_LABELS,
  CONTRIBUTION_BASE_KINDS,
  type ContributionBaseKind,
  PAYROLL_RUN_SETTINGS_LABEL,
  PAYROLL_SOURCE_MAX_LENGTH,
  type PayrollRunSettings,
  SEED_PAYROLL_RUN_SETTINGS,
  UNWORKED_SPECIAL_DAY_TREATMENT_LABELS,
  UNWORKED_SPECIAL_DAY_TREATMENTS,
  type UnworkedSpecialDayTreatment,
} from '@pulse/talent';
import type { PayrollRunSettingsView } from '@pulse/talent/server';
import { Button } from '@pulse/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@pulse/ui/components/dialog';
import { FormField, FormSection, Input, Select } from '@pulse/ui/components/form';
import { IconTile } from '@pulse/ui/components/icon-tile';
import { SheetBody, SheetClose, SheetFooter, SheetHeader } from '@pulse/ui/components/sheet';
import {
  ariaKeyShortcuts,
  ShortcutHint,
  submitFormFromShortcut,
  useShortcut,
} from '@pulse/ui/components/shortcut-hint';
import { FormAlert } from '@/components/form-alert';
import { useActionSubmit } from '@/components/org-structure';
import { addPayrollRunSettingsVersionAction } from '@/lib/actions/talent-payroll';

// Spec: docs/modules/talent.md#payroll-run-computation-build-step-29 ("Run settings"; decision 326
// in docs/BUILD_PLAN.md) — "Add version" on the "Payroll run" card of Payroll settings › Pay
// schedule, for a Talent Owner who is HR or the System Administrator (the card shows it only
// then; the action and the service check again).
//
// - Filled in with the latest version (or the seeded values when there is none yet).
// - A version may start on any day, but a run uses the version in effect on its cut-off's first
//   day, so one starting inside a cut-off applies from the next cut-off (HANDOFF assumption 258).
//   The date hint says so.
// - The lookback is sent as a number when typed as digits (anything else stays text, so the
//   schema names the field).
// - Saving (the button, or ⌘S / Ctrl+S) asks for confirmation first, since a version can't be
//   changed or withdrawn. Errors come back under `value.<path>` and show on their field. Nothing
//   here is logged.

const SAVE = ['mod', 's'] as const;
const SAVE_FAILED = 'The version wasn’t added. Check your connection and try again.';
const CONFIRMATION =
  'Versions can’t be changed or withdrawn once added. Check each choice: the next payroll runs use it.';

type AgencyKey = keyof PayrollRunSettings['contributionBases'];

const AGENCIES: readonly { key: AgencyKey; label: string }[] = [
  { key: 'sss', label: 'SSS' },
  { key: 'philhealth', label: 'PhilHealth' },
  { key: 'pagibig', label: 'Pag-IBIG' },
];

interface RunDraft {
  contributionBases: Record<AgencyKey, ContributionBaseKind>;
  monthlyRatedUnworkedSpecialDay: UnworkedSpecialDayTreatment;
  adjustmentLookbackCutOffs: string;
}

function toDraft(value: PayrollRunSettings): RunDraft {
  return {
    contributionBases: { ...value.contributionBases },
    monthlyRatedUnworkedSpecialDay: value.monthlyRatedUnworkedSpecialDay,
    adjustmentLookbackCutOffs: String(value.adjustmentLookbackCutOffs),
  };
}

/** The draft as the setting's value (the action and the service parse it). */
function draftToValue(draft: RunDraft) {
  const lookback = draft.adjustmentLookbackCutOffs.trim();
  return {
    contributionBases: draft.contributionBases,
    monthlyRatedUnworkedSpecialDay: draft.monthlyRatedUnworkedSpecialDay,
    adjustmentLookbackCutOffs:
      lookback === '' ? undefined : /^\d{1,6}$/.test(lookback) ? Number(lookback) : lookback,
  };
}

export interface AddedPayrollRunVersion {
  id: string;
  effectiveFrom: BusinessDate;
}

export function PayrollRunVersionSheet({
  view,
  onSaved,
}: {
  view: PayrollRunSettingsView;
  onSaved: (version: AddedPayrollRunVersion) => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const latest = view.history[0] ?? null;
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [source, setSource] = useState('');
  const [draft, setDraft] = useState<RunDraft>(() =>
    toDraft(latest?.value ?? SEED_PAYROLL_RUN_SETTINGS),
  );
  const [confirming, setConfirming] = useState(false);
  const [networkError, setNetworkError] = useState<string | null>(null);
  const save = useActionSubmit(addPayrollRunSettingsVersionAction, onSaved);
  const errors = save.fieldErrors;
  const valueErrors = Object.keys(errors).filter((key) => key.startsWith('value.')).length;

  useShortcut(SAVE, () => submitFormFromShortcut(formRef.current), {
    scope: formRef,
    enabled: !confirming,
  });

  async function confirm() {
    setNetworkError(null);
    try {
      const ok = await save.run({ effectiveFrom, source, value: draftToValue(draft) });
      if (!ok) {
        setConfirming(false);
        requestAnimationFrame(() => {
          formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
        });
      }
    } catch {
      setConfirming(false);
      setNetworkError(SAVE_FAILED);
    }
  }

  const range = view.earliestEffectiveFrom
    ? `From ${formatDate(view.earliestEffectiveFrom)}, the day after the latest version, to ${formatDate(view.latestEffectiveFrom)}.`
    : `Up to ${formatDate(view.latestEffectiveFrom)}.`;
  const dateHint = `${range} Any day works, but a payroll run uses the version in effect on its cut-off’s first day, so a date inside a cut-off applies from the next cut-off.`;

  return (
    <>
      <form
        ref={formRef}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          setConfirming(true);
        }}
        className="flex min-h-0 flex-1 flex-col"
        aria-busy={save.pending || undefined}
      >
        <SheetHeader
          title={`Add version: ${PAYROLL_RUN_SETTINGS_LABEL}`}
          description={
            latest
              ? `Filled in with the version from ${formatDate(latest.effectiveFrom)}. Change what the new policy changes.`
              : 'Choose the contribution bases, the unworked special day and the lookback.'
          }
        />
        <SheetBody>
          <FormAlert message={save.formError ?? networkError ?? errors.value} />
          {valueErrors > 0 ? (
            <p
              role="status"
              className="flex items-start gap-2 rounded-card bg-surface px-4 py-3 text-footnote font-medium text-destructive-text shadow-card"
            >
              <CircleAlert aria-hidden="true" className="mt-px size-4 shrink-0" />
              <span>
                {valueErrors === 1
                  ? 'One field needs checking. It’s marked below.'
                  : `${valueErrors} fields need checking. They’re marked below.`}
              </span>
            </p>
          ) : null}
          <FormSection
            title="Version"
            footer="Versions can’t be changed or withdrawn. A wrong version is replaced by a newer one from its own date."
          >
            <FormField label="Effective date" required hint={dateHint} error={errors.effectiveFrom}>
              <Input
                type="date"
                name="effectiveFrom"
                value={effectiveFrom}
                onChange={(event) => setEffectiveFrom(event.target.value)}
                min={view.earliestEffectiveFrom ?? undefined}
                max={view.latestEffectiveFrom}
                required
                className="numeric sm:max-w-56"
              />
            </FormField>
            <FormField
              label="Source"
              required
              hint={
                latest?.source
                  ? `The policy or memo behind the change. The latest version cites: ${latest.source}`
                  : 'The policy or memo behind the change. For example: Accountant’s memo on contributions, November 2026.'
              }
              error={errors.source}
            >
              <Input
                name="source"
                value={source}
                onChange={(event) => setSource(event.target.value)}
                maxLength={PAYROLL_SOURCE_MAX_LENGTH}
                autoComplete="off"
                required
              />
            </FormField>
          </FormSection>

          <FormSection
            title="Contribution bases"
            footer="The monthly basic salary is the one in effect on the first day of the contribution month. The month’s compensation is basic pay, holiday pay, overtime, premiums, night differential and taxable allowances, less attendance deductions, over both cut-offs. The mid-month cut-off always estimates on the monthly basic salary."
          >
            {AGENCIES.map((agency) => (
              <FormField
                key={agency.key}
                label={agency.label}
                required
                error={errors[`value.contributionBases.${agency.key}`]}
              >
                <Select
                  value={draft.contributionBases[agency.key]}
                  onChange={(event) =>
                    setDraft((previous) => ({
                      ...previous,
                      contributionBases: {
                        ...previous.contributionBases,
                        [agency.key]: event.target.value as ContributionBaseKind,
                      },
                    }))
                  }
                >
                  {CONTRIBUTION_BASE_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {CONTRIBUTION_BASE_KIND_LABELS[kind]}
                    </option>
                  ))}
                </Select>
              </FormField>
            ))}
          </FormSection>

          <FormSection title="Monthly-rated employees">
            <FormField
              label="Unworked special day"
              required
              hint="Paid: the monthly salary already covers it. Deducted: the day is taken off at the unworked special day rate."
              error={errors['value.monthlyRatedUnworkedSpecialDay']}
            >
              <Select
                value={draft.monthlyRatedUnworkedSpecialDay}
                onChange={(event) =>
                  setDraft((previous) => ({
                    ...previous,
                    monthlyRatedUnworkedSpecialDay: event.target
                      .value as UnworkedSpecialDayTreatment,
                  }))
                }
              >
                {UNWORKED_SPECIAL_DAY_TREATMENTS.map((treatment) => (
                  <option key={treatment} value={treatment}>
                    {UNWORKED_SPECIAL_DAY_TREATMENT_LABELS[treatment]}
                  </option>
                ))}
              </Select>
            </FormField>
          </FormSection>

          <FormSection title="Late changes">
            <FormField
              label="Earlier cut-offs reconciled"
              required
              hint={`A whole number from ${ADJUSTMENT_LOOKBACK_CUT_OFFS_MIN} to ${ADJUSTMENT_LOOKBACK_CUT_OFFS_MAX}. A run settles attendance approved or changed late in this many cut-offs before its own; 24 is about a year.`}
              error={errors['value.adjustmentLookbackCutOffs']}
            >
              <Input
                value={draft.adjustmentLookbackCutOffs}
                onChange={(event) =>
                  setDraft((previous) => ({
                    ...previous,
                    adjustmentLookbackCutOffs: event.target.value,
                  }))
                }
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
                required
                className="numeric sm:max-w-40"
              />
            </FormField>
          </FormSection>
        </SheetBody>
        <SheetFooter>
          <SheetClose asChild>
            <Button variant="secondary" className="pr-3">
              Cancel
              <ShortcutHint keys={['escape']} className="hidden sm:inline-flex" />
            </Button>
          </SheetClose>
          <Button
            type="submit"
            loading={save.pending}
            aria-keyshortcuts={ariaKeyShortcuts(SAVE)}
            className="pr-3"
          >
            Add version
            <ShortcutHint keys={SAVE} tone="on-fill" className="hidden sm:inline-flex" />
          </Button>
        </SheetFooter>
      </form>

      {/* Outside the form: React events bubble through portals. */}
      <Dialog
        open={confirming}
        onOpenChange={(next) => {
          if (!next && !save.pending) setConfirming(false);
        }}
      >
        <DialogContent
          onEscapeKeyDown={(event) => {
            if (save.pending) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (save.pending) event.preventDefault();
          }}
          className={[
            'top-1/2 left-1/2 flex w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col gap-5',
            'rounded-panel bg-surface p-6 text-text-primary shadow-float',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
            'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
          ].join(' ')}
        >
          <div className="flex items-start gap-4">
            <IconTile className="size-11 shrink-0 rounded-xl [&_svg]:size-5">
              <ShieldAlert strokeWidth={1.75} />
            </IconTile>
            <div className="flex min-w-0 flex-col gap-1.5">
              <DialogTitle>
                Add {PAYROLL_RUN_SETTINGS_LABEL}
                {isBusinessDate(effectiveFrom) ? ` from ${formatDate(effectiveFrom)}` : ''}?
              </DialogTitle>
              <DialogDescription>{CONFIRMATION}</DialogDescription>
            </div>
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              variant="secondary"
              onClick={() => setConfirming(false)}
              disabled={save.pending}
              autoFocus
              className="gap-2.5"
            >
              Check again
              <ShortcutHint keys={['escape']} className="hidden sm:inline-flex" />
            </Button>
            <Button loading={save.pending} onClick={() => void confirm()}>
              Add version
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
