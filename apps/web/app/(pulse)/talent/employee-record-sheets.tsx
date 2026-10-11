'use client';

import { type ReactNode, useRef, useState } from 'react';
import { CircleAlert, RotateCw } from 'lucide-react';
import { businessToday, type FieldErrors } from '@pulse/core';
import {
  ACCOUNT_NAME_MAX_LENGTH,
  ADDRESS_MAX_LENGTH,
  CIVIL_STATUS_LABELS,
  CIVIL_STATUSES,
  COMPENSATION_REASON_MAX_LENGTH,
  EMERGENCY_CONTACT_NAME_MAX_LENGTH,
  EMERGENCY_CONTACT_RELATIONSHIP_MAX_LENGTH,
  type EmployeeRecordView,
  latestEffectiveDate,
  type MaskedDigitsView,
  NATIONALITY_MAX_LENGTH,
  PAYROLL_BANK_LABELS,
  PAYROLL_BANKS,
  PERSONAL_EMAIL_MAX_LENGTH,
  RATE_TYPE_LABELS,
  RATE_TYPES,
  RECORD_CHANGED_ELSEWHERE,
  SEPARATION_REMARKS_MAX_LENGTH,
  SEX_LABELS,
  SEXES,
  WORK_REGION_LABELS,
  WORK_REGIONS,
} from '@pulse/talent';
import { Button } from '@pulse/ui/components/button';
import { FormField, FormSection, Input, Select, Switch, Textarea } from '@pulse/ui/components/form';
import { SheetBody, SheetClose, SheetFooter, SheetHeader } from '@pulse/ui/components/sheet';
import {
  ariaKeyShortcuts,
  ShortcutHint,
  submitFormFromShortcut,
  useShortcut,
} from '@pulse/ui/components/shortcut-hint';
import { FormAlert } from '@/components/form-alert';
import { useActionSubmit } from '@/components/org-structure';
import {
  addCompensationEntryAction,
  setBankAccountAction,
  setGovernmentIdsAction,
  updateEmploymentAction,
  updatePersonalAction,
} from '@/lib/actions/talent';
import type { RecordSectionKey } from './employee-record-sections';

// Spec: docs/modules/talent.md#the-employee-record-build-step-21 (decisions 161–165) and
// docs/DESIGN_SYSTEM.md#layout--components ("Employee record") — each section's Edit sheet. Each
// saves on its own and sends back the record's `version`; a stale save is refused with "Someone
// else changed this record. Reload to see it." and offers Reload. Save is ⌘S or Ctrl+S.
//
// - Sensitive inputs (the government IDs and the account number) are never filled in with the
//   stored value: they start empty with the hint "Ends in 1234", and leaving one empty keeps it.
// - The date of birth and civil status inputs are in the form only for viewers who may change
//   them; without them the service keeps the stored values.
// - Errors come back inline next to each field; no message repeats a sensitive value.

const SAVE = ['mod', 's'] as const;
const SAVE_FAILED = 'The changes weren’t saved. Check your connection and try again.';

const SHEET_TITLES: Record<RecordSectionKey, string> = {
  personal: 'Edit personal details',
  employment: 'Edit employment details',
  compensation: 'Add salary change',
  governmentIds: 'Edit government IDs',
  bankAccount: 'Edit payroll bank account',
};

type SubmitAction = Parameters<typeof useActionSubmit<unknown>>[0];

/** The sheet for `section` of `view`. Keyed per opening by the parent, so each opens afresh. */
export function RecordSectionSheet({
  section,
  view,
  onSaved,
  onReload,
}: {
  section: RecordSectionKey;
  view: EmployeeRecordView;
  /** After a save: closes the sheet and shows `message`. */
  onSaved: (message: string) => void;
  /** After the stale-form message: closes the sheet and loads the record again. */
  onReload: () => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const action: SubmitAction =
    section === 'personal'
      ? updatePersonalAction
      : section === 'employment'
        ? updateEmploymentAction
        : section === 'governmentIds'
          ? setGovernmentIdsAction
          : section === 'bankAccount'
            ? setBankAccountAction
            : addCompensationEntryAction;
  const save = useActionSubmit(action, () =>
    onSaved(section === 'compensation' ? 'Salary change added.' : 'Changes saved.'),
  );
  const [networkError, setNetworkError] = useState<string | null>(null);
  const stale = save.formError === RECORD_CHANGED_ELSEWHERE;
  const name = `${view.identity.firstName} ${view.identity.lastName}`;

  useShortcut(SAVE, () => submitFormFromShortcut(formRef.current), { scope: formRef });

  async function submit(form: HTMLFormElement) {
    setNetworkError(null);
    try {
      const ok = await save.run(new FormData(form));
      if (!ok) {
        requestAnimationFrame(() => {
          form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
        });
      }
    } catch {
      setNetworkError(SAVE_FAILED);
    }
  }

  const errors = save.fieldErrors;
  return (
    <form
      ref={formRef}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit(event.currentTarget);
      }}
      className="flex min-h-0 flex-1 flex-col"
      aria-busy={save.pending || undefined}
    >
      <SheetHeader
        title={SHEET_TITLES[section]}
        description={`${name} · ${view.identity.employeeNumber}`}
      />
      <SheetBody>
        <input type="hidden" name="employeeId" value={view.employeeId} />
        {section !== 'compensation' ? (
          <input type="hidden" name="version" value={view.version} />
        ) : null}
        {stale ? (
          <div
            role="alert"
            className="flex flex-col gap-3 rounded-card bg-surface px-4 py-3 shadow-card sm:flex-row sm:items-center"
          >
            <p className="flex flex-1 items-start gap-2 text-footnote font-medium text-destructive-text">
              <CircleAlert aria-hidden="true" className="mt-px size-4 shrink-0" />
              <span>{RECORD_CHANGED_ELSEWHERE}</span>
            </p>
            <Button variant="tinted" onClick={onReload} className="shrink-0">
              <RotateCw aria-hidden="true" className="size-4.5" />
              Reload
            </Button>
          </div>
        ) : (
          <FormAlert message={save.formError ?? networkError} />
        )}
        {section === 'personal' ? <PersonalFields view={view} errors={errors} /> : null}
        {section === 'employment' ? <EmploymentFields view={view} errors={errors} /> : null}
        {section === 'governmentIds' ? <GovernmentIdFields view={view} errors={errors} /> : null}
        {section === 'bankAccount' ? <BankAccountFields view={view} errors={errors} /> : null}
        {section === 'compensation' ? <CompensationFields view={view} errors={errors} /> : null}
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
          disabled={stale}
          aria-keyshortcuts={ariaKeyShortcuts(SAVE)}
          className="pr-3"
        >
          {section === 'compensation' ? 'Add salary change' : 'Save'}
          <ShortcutHint keys={SAVE} tone="on-fill" className="hidden sm:inline-flex" />
        </Button>
      </SheetFooter>
    </form>
  );
}

type FieldsProps = { view: EmployeeRecordView; errors: FieldErrors };

/** The hint on a sensitive input: what is stored, masked, and that empty keeps it. */
function sensitiveHint(stored: MaskedDigitsView | null | undefined, extra?: string): ReactNode {
  const parts = [
    stored ? `Ends in ${stored.lastFour}. Leave it empty to keep it.` : 'None stored yet.',
    extra,
  ].filter(Boolean);
  return parts.join(' ');
}

function PersonalFields({ view, errors }: FieldsProps) {
  const { personal, can } = view;
  const contact = personal.emergencyContact;
  return (
    <>
      <FormSection title="Personal">
        {can.editBirthAndCivilStatus ? (
          <FormField label="Date of birth" error={errors.dateOfBirth}>
            <Input
              type="date"
              name="dateOfBirth"
              defaultValue={personal.dateOfBirth ?? ''}
              max={businessToday()}
              className="numeric sm:max-w-60"
            />
          </FormField>
        ) : null}
        <FormField label="Sex" error={errors.sex}>
          <Select name="sex" defaultValue={personal.sex ?? ''}>
            <option value="">Not set</option>
            {SEXES.map((sex) => (
              <option key={sex} value={sex}>
                {SEX_LABELS[sex]}
              </option>
            ))}
          </Select>
        </FormField>
        {can.editBirthAndCivilStatus ? (
          <FormField label="Civil status" error={errors.civilStatus}>
            <Select name="civilStatus" defaultValue={personal.civilStatus ?? ''}>
              <option value="">Not set</option>
              {CIVIL_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {CIVIL_STATUS_LABELS[status]}
                </option>
              ))}
            </Select>
          </FormField>
        ) : null}
        <FormField label="Nationality" error={errors.nationality}>
          <Input
            name="nationality"
            defaultValue={personal.nationality ?? ''}
            maxLength={NATIONALITY_MAX_LENGTH}
            autoComplete="off"
          />
        </FormField>
      </FormSection>
      {!can.editBirthAndCivilStatus && ('dateOfBirth' in personal || 'civilStatus' in personal) ? (
        <p className="px-4 text-footnote text-text-secondary">
          Only HR and the System Administrator change the date of birth and civil status.
        </p>
      ) : null}
      <FormSection title="Contact">
        <FormField
          label="Mobile number"
          hint="11 digits, like 0917 123 4567."
          error={errors.mobileNumber}
        >
          <Input
            name="mobileNumber"
            type="tel"
            inputMode="tel"
            defaultValue={personal.mobileNumber ?? ''}
            maxLength={20}
            autoComplete="off"
            className="numeric"
          />
        </FormField>
        <FormField label="Personal email" error={errors.personalEmail}>
          <Input
            name="personalEmail"
            type="email"
            defaultValue={personal.personalEmail ?? ''}
            maxLength={PERSONAL_EMAIL_MAX_LENGTH}
            autoComplete="off"
            spellCheck={false}
          />
        </FormField>
        <FormField label="Present address" error={errors.presentAddress}>
          <Textarea
            name="presentAddress"
            defaultValue={personal.presentAddress ?? ''}
            maxLength={ADDRESS_MAX_LENGTH}
          />
        </FormField>
        <FormField label="Permanent address" error={errors.permanentAddress}>
          <Textarea
            name="permanentAddress"
            defaultValue={personal.permanentAddress ?? ''}
            maxLength={ADDRESS_MAX_LENGTH}
          />
        </FormField>
      </FormSection>
      <FormSection title="Emergency contact">
        <FormField label="Name" error={errors.emergencyContactName}>
          <Input
            name="emergencyContactName"
            defaultValue={contact?.name ?? ''}
            maxLength={EMERGENCY_CONTACT_NAME_MAX_LENGTH}
            autoComplete="off"
          />
        </FormField>
        <FormField label="Relationship" error={errors.emergencyContactRelationship}>
          <Input
            name="emergencyContactRelationship"
            defaultValue={contact?.relationship ?? ''}
            maxLength={EMERGENCY_CONTACT_RELATIONSHIP_MAX_LENGTH}
            autoComplete="off"
          />
        </FormField>
        <FormField
          label="Mobile number"
          hint="11 digits, like 0917 123 4567."
          error={errors.emergencyContactMobile}
        >
          <Input
            name="emergencyContactMobile"
            type="tel"
            inputMode="tel"
            defaultValue={contact?.mobileNumber ?? ''}
            maxLength={20}
            autoComplete="off"
            className="numeric"
          />
        </FormField>
      </FormSection>
    </>
  );
}

function EmploymentFields({ view, errors }: FieldsProps) {
  const { employment } = view;
  return (
    <FormSection
      title="Employment"
      footer="The employee number, department, position, status and dates hired and separated are managed in Users."
    >
      <FormField
        label="Work region"
        required
        hint="Used for the minimum wage check."
        error={errors.workRegion}
      >
        <Select name="workRegion" defaultValue={employment.workRegion} required>
          {WORK_REGIONS.map((region) => (
            <option key={region} value={region}>
              {WORK_REGION_LABELS[region]}
            </option>
          ))}
        </Select>
      </FormField>
      <FormField label="Contract end date" error={errors.contractEndDate}>
        <Input
          type="date"
          name="contractEndDate"
          defaultValue={employment.contractEndDate ?? ''}
          className="numeric sm:max-w-60"
        />
      </FormField>
      <FormField label="Regularization date" error={errors.regularizationDate}>
        <Input
          type="date"
          name="regularizationDate"
          defaultValue={employment.regularizationDate ?? ''}
          className="numeric sm:max-w-60"
        />
      </FormField>
      <FormField label="Separation remarks" error={errors.separationRemarks}>
        <Textarea
          name="separationRemarks"
          defaultValue={employment.separationRemarks ?? ''}
          maxLength={SEPARATION_REMARKS_MAX_LENGTH}
        />
      </FormField>
    </FormSection>
  );
}

/** A sensitive digits input: never prefilled, no autocomplete, digits keyboard. */
function SensitiveInput({ name, maxLength }: { name: string; maxLength: number }) {
  return (
    <Input
      name={name}
      defaultValue=""
      inputMode="numeric"
      autoComplete="off"
      spellCheck={false}
      maxLength={maxLength}
      className="numeric"
    />
  );
}

function GovernmentIdFields({ view, errors }: FieldsProps) {
  const ids = view.governmentIds;
  return (
    <FormSection
      title="Government IDs"
      footer="Dashes and spaces are fine; only the digits are kept."
    >
      <FormField
        label="TIN"
        hint={sensitiveHint(ids?.tin, '9, 12 or 14 digits.')}
        error={errors.tin}
      >
        <SensitiveInput name="tin" maxLength={24} />
      </FormField>
      <FormField label="RDO code" hint="3 digits." error={errors.rdoCode}>
        <Input
          name="rdoCode"
          defaultValue={ids?.rdoCode ?? ''}
          inputMode="numeric"
          autoComplete="off"
          maxLength={5}
          className="numeric sm:max-w-40"
        />
      </FormField>
      <FormField label="SSS number" hint={sensitiveHint(ids?.sss, '10 digits.')} error={errors.sss}>
        <SensitiveInput name="sss" maxLength={20} />
      </FormField>
      <FormField
        label="PhilHealth PIN"
        hint={sensitiveHint(ids?.philhealth, '12 digits.')}
        error={errors.philhealth}
      >
        <SensitiveInput name="philhealth" maxLength={20} />
      </FormField>
      <FormField
        label="Pag-IBIG MID"
        hint={sensitiveHint(ids?.pagibig, '12 digits.')}
        error={errors.pagibig}
      >
        <SensitiveInput name="pagibig" maxLength={20} />
      </FormField>
    </FormSection>
  );
}

function BankAccountFields({ view, errors }: FieldsProps) {
  const bank = view.bankAccount;
  return (
    <FormSection title="Payroll bank account">
      <FormField label="Bank" required error={errors.bank}>
        <Select name="bank" defaultValue={bank?.bank ?? ''} required>
          <option value="" disabled>
            Choose a bank
          </option>
          {PAYROLL_BANKS.map((value) => (
            <option key={value} value={value}>
              {PAYROLL_BANK_LABELS[value]}
            </option>
          ))}
        </Select>
      </FormField>
      <FormField
        label="Account number"
        required={!bank?.accountNumber}
        hint={sensitiveHint(bank?.accountNumber, '10 to 16 digits.')}
        error={errors.accountNumber}
      >
        <SensitiveInput name="accountNumber" maxLength={24} />
      </FormField>
      <FormField label="Account name" required error={errors.accountName}>
        <Input
          name="accountName"
          defaultValue={bank?.accountName ?? ''}
          maxLength={ACCOUNT_NAME_MAX_LENGTH}
          autoComplete="off"
          required
        />
      </FormField>
    </FormSection>
  );
}

function CompensationFields({ view, errors }: FieldsProps) {
  const today = businessToday();
  const current = view.compensation?.current ?? null;
  const [minimumWageEarner, setMinimumWageEarner] = useState(current?.minimumWageEarner ?? false);
  return (
    <>
      <FormSection
        title="Salary change"
        footer="Entries can’t be edited. To correct one, add a new entry with the same effective date."
      >
        <FormField
          label="Effective date"
          required
          hint={`From the date hired up to a year ahead. A date after today shows as scheduled.`}
          error={errors.effectiveDate}
        >
          <Input
            type="date"
            name="effectiveDate"
            defaultValue={today}
            min={view.identity.dateHired}
            max={latestEffectiveDate(today)}
            required
            className="numeric sm:max-w-60"
          />
        </FormField>
        <FormField
          label="Basic salary"
          required
          hint="In pesos, like 25,000.00. For a daily-rated employee, the daily rate."
          error={errors.basicSalary ?? errors.basicSalaryCentavos}
        >
          <Input
            name="basicSalary"
            defaultValue=""
            inputMode="decimal"
            autoComplete="off"
            maxLength={20}
            required
            className="numeric sm:max-w-60"
          />
        </FormField>
        <FormField label="Rate type" required error={errors.rateType}>
          <Select name="rateType" defaultValue={current?.rateType ?? 'monthly'} required>
            {RATE_TYPES.map((type) => (
              <option key={type} value={type}>
                {RATE_TYPE_LABELS[type]}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField
          label="Minimum wage earner"
          layout="inline"
          hint="Exempt from income tax."
          error={errors.minimumWageEarner}
        >
          <Switch
            name="minimumWageEarner"
            checked={minimumWageEarner}
            onCheckedChange={setMinimumWageEarner}
          />
        </FormField>
      </FormSection>
      <FormSection title="Reason">
        <FormField
          label="Reason"
          required
          hint="For example “Regularization”."
          error={errors.reason}
        >
          <Textarea name="reason" maxLength={COMPENSATION_REASON_MAX_LENGTH} required />
        </FormField>
      </FormSection>
    </>
  );
}
