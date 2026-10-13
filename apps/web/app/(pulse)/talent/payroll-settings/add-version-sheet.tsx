'use client';

import { useRef, useState } from 'react';
import { CircleAlert, ShieldAlert } from 'lucide-react';
import { type BusinessDate, formatDate, isBusinessDate } from '@pulse/core';
import {
  ADD_VERSION_CONFIRMATION,
  PAYROLL_SOURCE_MAX_LENGTH,
  type PayrollSettingKey,
  type PayrollSettingView,
} from '@pulse/talent';
import { Button } from '@pulse/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@pulse/ui/components/dialog';
import { FormField, FormSection, Input } from '@pulse/ui/components/form';
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
import { addPayrollSettingsVersionAction } from '@/lib/actions/talent-payroll';
import {
  draftToValue,
  emptyDraft,
  POLICY_SETTINGS,
  type SettingDraft,
  toDraft,
} from './payroll-format';
import { type AllowanceEditorContext, SettingEditor } from './value-editors';

// Spec: docs/modules/talent.md#payroll-settings-and-allowances-build-step-23 ("Adding a version",
// decision 197 in docs/BUILD_PLAN.md) — the "Add version" sheet, for a Talent Owner who is HR or
// the System Administrator (the page shows it only then; the action and the service check again).
//
// - Filled in with the version in effect. The effective date must be later than every existing
//   version and at most a year ahead (the date input's min and max say so; the service decides).
//   The source is required.
// - Saving (the button, or ⌘S / Ctrl+S) asks for confirmation first, since a version can't be
//   changed or withdrawn. Errors come back inline: the date, the source, and each figure under
//   `value.<path>`, on its field or its cell. Nothing here is logged.
// - Build step 2.4: the work schedule and timesheet settings are company policy, not an
//   issuance, so their date and source hints say so; a schedule's days and minutes are sent as
//   numbers (`draftToValue`).

const SAVE = ['mod', 's'] as const;
const SAVE_FAILED = 'The version wasn’t added. Check your connection and try again.';

export interface AddedVersion {
  id: string;
  key: PayrollSettingKey;
  effectiveFrom: BusinessDate;
}

function dateHint(setting: PayrollSettingView, draft: SettingDraft): string {
  const latest = formatDate(setting.latestEffectiveFrom);
  if (POLICY_SETTINGS.has(setting.key)) {
    return setting.earliestEffectiveFrom
      ? `From ${formatDate(setting.earliestEffectiveFrom)}, the day after the latest version, to ${latest}. Any day of the week works.`
      : `Up to ${latest}. Any day of the week works.`;
  }
  let hint = setting.earliestEffectiveFrom
    ? `From ${formatDate(setting.earliestEffectiveFrom)}, the day after the latest version, to ${latest}. An earlier date is fine for an issuance published late.`
    : `Up to ${latest}. An earlier date is fine for an issuance published late.`;
  if (setting.key === 'talent.payrollSettings') {
    const days = (draft as SettingDraft<'talent.payrollSettings'>).cutOffs
      .map((cutOff) => cutOff.startDay.trim())
      .filter(Boolean);
    hint += days.length
      ? ` It must be a cut-off start day of this schedule: day ${days.join(' or ')} of a month.`
      : ' It must be a cut-off start day of this schedule.';
  }
  return hint;
}

function sourceHint(key: PayrollSettingKey, inEffect: string | null | undefined): string {
  if (POLICY_SETTINGS.has(key)) {
    return inEffect
      ? `The policy or memo behind the change. The version in effect cites: ${inEffect}`
      : 'The policy or memo behind the change. For example: HR memo on work hours, October 2026.';
  }
  return inEffect
    ? `The issuance’s name and, if there is one, its link. The version in effect cites: ${inEffect}`
    : 'The issuance’s name and, if there is one, its link. For example: SSS Circular No. 2024-006.';
}

export function AddVersionSheet({
  setting,
  allowanceContext,
  onSaved,
}: {
  setting: PayrollSettingView;
  allowanceContext: AllowanceEditorContext;
  onSaved: (version: AddedVersion) => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [source, setSource] = useState('');
  const [draft, setDraft] = useState<SettingDraft>(() => {
    const start = setting.inEffect ?? setting.history[0] ?? null;
    return start ? toDraft(start.value) : emptyDraft(setting.key);
  });
  const [confirming, setConfirming] = useState(false);
  const [networkError, setNetworkError] = useState<string | null>(null);
  const save = useActionSubmit(addPayrollSettingsVersionAction, onSaved);
  const errors = save.fieldErrors;
  const valueErrors = Object.keys(errors).filter((key) => key.startsWith('value.')).length;

  useShortcut(SAVE, () => submitFormFromShortcut(formRef.current), {
    scope: formRef,
    enabled: !confirming,
  });

  function focusFirstError() {
    requestAnimationFrame(() => {
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    });
  }

  async function confirm() {
    setNetworkError(null);
    try {
      const ok = await save.run({
        key: setting.key,
        effectiveFrom,
        source,
        value: draftToValue(setting.key, draft),
      });
      if (!ok) {
        setConfirming(false);
        focusFirstError();
      }
    } catch {
      setConfirming(false);
      setNetworkError(SAVE_FAILED);
    }
  }

  const sourceLabel = setting.inEffect?.source;

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
          title={`Add version: ${setting.label}`}
          description={
            setting.inEffect
              ? `Filled in with the version in effect since ${formatDate(setting.inEffect.effectiveFrom)}. Change what the new issuance changes.`
              : 'Enter the figures from the issuance.'
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
                  ? 'One figure needs checking. It’s marked below.'
                  : `${valueErrors} figures need checking. They’re marked below.`}
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
              hint={dateHint(setting, draft)}
              error={errors.effectiveFrom}
            >
              <Input
                type="date"
                name="effectiveFrom"
                value={effectiveFrom}
                onChange={(event) => setEffectiveFrom(event.target.value)}
                min={setting.earliestEffectiveFrom ?? undefined}
                max={setting.latestEffectiveFrom}
                required
                className="numeric sm:max-w-56"
              />
            </FormField>
            <FormField
              label="Source"
              required
              hint={sourceHint(setting.key, sourceLabel)}
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
          <SettingEditor
            settingKey={setting.key}
            draft={draft}
            onChange={setDraft}
            errors={errors}
            allowanceContext={allowanceContext}
          />
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
                Add {setting.label}
                {isBusinessDate(effectiveFrom) ? ` from ${formatDate(effectiveFrom)}` : ''}?
              </DialogTitle>
              <DialogDescription>{ADD_VERSION_CONFIRMATION}</DialogDescription>
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
