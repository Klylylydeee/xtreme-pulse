'use client';

import { useRef, useState } from 'react';
import { CircleAlert, ShieldAlert } from 'lucide-react';
import { type BusinessDate, formatDate, isBusinessDate } from '@pulse/core';
import {
  PAYROLL_SOURCE_MAX_LENGTH,
  REMITTANCE_AGENCIES,
  REMITTANCE_AGENCY_LABELS,
  REMITTANCE_REMINDER_LEAD_DAYS_MAX,
  REMITTANCE_SETTINGS_LABEL,
  type RemittanceAgency,
  type RemittanceSettings,
  SEED_REMITTANCE_SETTINGS,
} from '@pulse/talent';
import type { RemittanceSettingsView } from '@pulse/talent/server';
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
import { addRemittanceSettingsVersionAction } from '@/lib/actions/talent-payroll';

// Spec: docs/modules/talent.md#employer-contributions-and-remittances-build-step-211 ("Remittance
// settings"; decision 383 in docs/BUILD_PLAN.md) — "Add version" on the "Remittances" card of
// Payroll settings › Pay schedule, for a Talent Owner who is HR or the System Administrator (the
// card shows it only then; the action and the service check again).
//
// - Filled in with the latest version (or the seeded values when there is none yet).
// - Per agency: the due day (1–31, a day past the month's end is its last day), the month it is
//   due in (the next month or the second month after) and an optional December day; then the
//   reminder lead days (0–30). Days are sent as numbers when typed as digits (anything else stays
//   text, so the schema names the field).
// - Saving (the button, or ⌘S / Ctrl+S) asks for confirmation first, since a version can't be
//   changed or withdrawn. Errors come back under `value.<path>` and show on their field.

const SAVE = ['mod', 's'] as const;
const SAVE_FAILED = 'The version wasn’t added. Check your connection and try again.';
const CONFIRMATION =
  'Versions can’t be changed or withdrawn once added. Check each date: the reminders and the remittances page use them.';

interface RuleDraft {
  dueDay: string;
  monthsAfter: '1' | '2';
  decemberDueDay: string;
}

type Draft = { dueDates: Record<RemittanceAgency, RuleDraft>; reminderLeadDays: string };

function toDraft(value: RemittanceSettings): Draft {
  return {
    dueDates: Object.fromEntries(
      REMITTANCE_AGENCIES.map((agency) => {
        const rule = value.dueDates[agency];
        return [
          agency,
          {
            dueDay: String(rule.dueDay),
            monthsAfter: rule.monthsAfter === 2 ? '2' : '1',
            decemberDueDay: rule.decemberDueDay === null ? '' : String(rule.decemberDueDay),
          },
        ];
      }),
    ) as Record<RemittanceAgency, RuleDraft>,
    reminderLeadDays: String(value.reminderLeadDays),
  };
}

const numberOf = (text: string) => {
  const trimmed = text.trim();
  return trimmed === '' ? undefined : /^\d{1,3}$/.test(trimmed) ? Number(trimmed) : trimmed;
};

/** The draft as the setting's value (the action and the service parse it). */
function draftToValue(draft: Draft) {
  return {
    dueDates: Object.fromEntries(
      REMITTANCE_AGENCIES.map((agency) => {
        const rule = draft.dueDates[agency];
        const december = rule.decemberDueDay.trim();
        return [
          agency,
          {
            dueDay: numberOf(rule.dueDay),
            monthsAfter: Number(rule.monthsAfter),
            decemberDueDay: december === '' ? null : numberOf(december),
          },
        ];
      }),
    ),
    reminderLeadDays: numberOf(draft.reminderLeadDays),
  };
}

export interface AddedRemittanceVersion {
  id: string;
  effectiveFrom: BusinessDate;
}

export function RemittanceVersionSheet({
  view,
  onSaved,
}: {
  view: RemittanceSettingsView;
  onSaved: (version: AddedRemittanceVersion) => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const latest = view.history[0] ?? null;
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [source, setSource] = useState('');
  const [draft, setDraft] = useState<Draft>(() =>
    toDraft(latest?.value ?? SEED_REMITTANCE_SETTINGS),
  );
  const [confirming, setConfirming] = useState(false);
  const [networkError, setNetworkError] = useState<string | null>(null);
  const save = useActionSubmit(addRemittanceSettingsVersionAction, onSaved);
  const errors = save.fieldErrors;
  const valueErrors = Object.keys(errors).filter((key) => key.startsWith('value.')).length;

  useShortcut(SAVE, () => submitFormFromShortcut(formRef.current), {
    scope: formRef,
    enabled: !confirming,
  });

  const setRule = (agency: RemittanceAgency, change: Partial<RuleDraft>) =>
    setDraft((previous) => ({
      ...previous,
      dueDates: { ...previous.dueDates, [agency]: { ...previous.dueDates[agency], ...change } },
    }));

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
          title={`Add version: ${REMITTANCE_SETTINGS_LABEL}`}
          description={
            latest
              ? `Filled in with the version from ${formatDate(latest.effectiveFrom)}. Change the dates the agencies gave the company.`
              : 'Each agency’s due date and when the first reminder goes.'
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
            <FormField
              label="Effective date"
              required
              hint={`${range} A month’s due dates use the version in effect on the first day of the month after it.`}
              error={errors.effectiveFrom}
            >
              <Input
                type="date"
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
              hint="The agency notice or HR memo behind the dates. For example: PhilHealth employer number group 16th–20th."
              error={errors.source}
            >
              <Input
                value={source}
                onChange={(event) => setSource(event.target.value)}
                maxLength={PAYROLL_SOURCE_MAX_LENGTH}
                autoComplete="off"
                required
              />
            </FormField>
          </FormSection>

          {REMITTANCE_AGENCIES.map((agency) => {
            const rule = draft.dueDates[agency];
            const path = `value.dueDates.${agency}`;
            return (
              <FormSection
                key={agency}
                title={REMITTANCE_AGENCY_LABELS[agency]}
                footer="A day past the month’s end is its last day: 31 is always the last day."
              >
                <FormField label="Due day" required error={errors[`${path}.dueDay`]}>
                  <Input
                    value={rule.dueDay}
                    onChange={(event) => setRule(agency, { dueDay: event.target.value })}
                    inputMode="numeric"
                    autoComplete="off"
                    required
                    className="numeric sm:max-w-32"
                  />
                </FormField>
                <FormField label="Due in" required error={errors[`${path}.monthsAfter`]}>
                  <Select
                    value={rule.monthsAfter}
                    onChange={(event) =>
                      setRule(agency, { monthsAfter: event.target.value === '2' ? '2' : '1' })
                    }
                  >
                    <option value="1">The next month</option>
                    <option value="2">The second month after</option>
                  </Select>
                </FormField>
                <FormField
                  label="December’s due day"
                  hint="Leave blank to use the due day for December too."
                  error={errors[`${path}.decemberDueDay`]}
                >
                  <Input
                    value={rule.decemberDueDay}
                    onChange={(event) => setRule(agency, { decemberDueDay: event.target.value })}
                    inputMode="numeric"
                    autoComplete="off"
                    className="numeric sm:max-w-32"
                  />
                </FormField>
              </FormSection>
            );
          })}

          <FormSection title="Reminders">
            <FormField
              label="First reminder, days before the due date"
              required
              hint={`0 to ${REMITTANCE_REMINDER_LEAD_DAYS_MAX}. HR is also reminded on the due date and the day after.`}
              error={errors['value.reminderLeadDays']}
            >
              <Input
                value={draft.reminderLeadDays}
                onChange={(event) =>
                  setDraft((previous) => ({ ...previous, reminderLeadDays: event.target.value }))
                }
                inputMode="numeric"
                autoComplete="off"
                required
                className="numeric sm:max-w-32"
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
                Add {REMITTANCE_SETTINGS_LABEL}
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
