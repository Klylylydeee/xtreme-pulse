'use client';

import { type ComponentProps, type ReactNode, useId } from 'react';
import { CircleAlert, Plus, Trash2 } from 'lucide-react';
import { type FieldErrors, TIMESHEET_TYPES } from '@pulse/core';
import {
  ALLOWANCE_BASES,
  ALLOWANCE_BASIS_LABELS,
  ALLOWANCE_TAX_TREATMENT_LABELS,
  ALLOWANCE_TAX_TREATMENTS,
  CONTRIBUTION_AGENCIES,
  CUT_OFF_LABELS,
  type CutOffKey,
  DE_MINIMIS_PERIOD_LABELS,
  DE_MINIMIS_PERIODS,
  EXTRA_HOURS_TREATMENT_LABELS,
  EXTRA_HOURS_TREATMENTS,
  formatHours,
  GRACE_MINUTES_MAX,
  BREAK_MINUTES_MAX,
  ISO_WEEKDAY_LABELS,
  ISO_WEEKDAY_SHORT_LABELS,
  ISO_WEEKDAYS,
  type PayrollSettingKey,
  PREMIUM_RATE_FIELDS,
  PREMIUM_RATE_LABELS,
  scheduledMinutes,
  TIMESHEET_TYPE_TITLES,
  WORK_REGION_LABELS,
  WORK_REGIONS,
  workScheduleSchema,
} from '@pulse/talent';
import { cn } from '@pulse/ui';
import { Button } from '@pulse/ui/components/button';
import { FormField, FormSection, Input, Select, Switch } from '@pulse/ui/components/form';
import { GridEditor } from './grid-editor';
import {
  newAllowanceType,
  newDeMinimisItem,
  newMinimumWageRegion,
  newPagibigBracket,
  newSssRow,
  newWithholdingBracket,
  rateAsPercent,
  restDaysOf,
  scheduleDraftToValue,
  formatWeekdays,
  setIn,
  type SettingDraft,
} from './payroll-format';
import { AGENCY_LABELS } from './setting-values';

// Spec: docs/modules/talent.md#payroll-settings-and-allowances-build-step-23 ("Adding a version")
// and docs/DATA_MODEL.md#versioned-configuration — the figures of each setting in the "Add
// version" sheet. Amounts are typed in pesos (converted to centavos by the Server Action); rates
// as decimals ("0.05" is 5%). Errors come back under `value.<path>` and show next to their field,
// or on their cell in a grid.
//
// From build step 2.4 (docs/modules/talent.md#work-schedules-and-daily-time-entries-build-step-24)
// the company work schedule (weekday toggles, start, end, break and grace period) and the
// timesheet settings (the offset ratio as a decimal, and the extra-hours treatment for each
// timesheet type). `WorkScheduleFields` is shared with the inspector's "Set schedule" sheet.

export interface EditorProps<K extends PayrollSettingKey> {
  draft: SettingDraft<K>;
  onChange: (draft: SettingDraft<K>) => void;
  errors: FieldErrors;
}

/** What the allowance type editor needs to know about the other versions. */
export interface AllowanceEditorContext {
  /** The first types, prefilled from the version in effect: their keys are fixed, and they are never removed. */
  lockedCount: number;
  /** The de minimis limits in effect, for a de minimis type. */
  deMinimisOptions: readonly { value: string; label: string }[];
}

/** An error for a group of fields, such as "The cut-offs overlap on day 11". */
function GroupError({ message }: { message: string | undefined }) {
  return (
    <div aria-live="polite" className="empty:hidden">
      {message ? (
        <p className="flex items-start gap-1.5 px-4 text-footnote font-medium text-destructive-text">
          <CircleAlert aria-hidden="true" className="mt-px size-4 shrink-0" />
          <span>{message}</span>
        </p>
      ) : null}
    </div>
  );
}

/** An amount in pesos, with the ₱ sign in front. */
function PesoInput({ className, ...props }: ComponentProps<typeof Input>) {
  return (
    <div className={cn('relative', className)}>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-text-secondary"
      >
        ₱
      </span>
      <Input
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        className="numeric pl-7"
        {...props}
      />
    </div>
  );
}

function rateHint(value: string, base = 'A decimal: 0.05 is 5%.'): string {
  return /^\d{1,6}(?:\.\d{1,6})?$/.test(value.trim()) ? `${rateAsPercent(value)}. ${base}` : base;
}

/** A labelled field row in a FormSection. */
function TextField({
  label,
  value,
  onChange,
  error,
  hint,
  kind = 'text',
  required = true,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  hint?: ReactNode;
  kind?: 'text' | 'integer' | 'decimal' | 'rate' | 'peso' | 'time';
  required?: boolean;
  className?: string;
}) {
  const shared = {
    value,
    onChange: (event: { target: { value: string } }) => onChange(event.target.value),
    required,
  };
  return (
    <FormField
      label={label}
      required={required}
      error={error}
      hint={kind === 'rate' ? rateHint(value) : hint}
      className={className}
    >
      {kind === 'peso' ? (
        <PesoInput {...shared} className="sm:max-w-56" />
      ) : kind === 'time' ? (
        <Input type="time" {...shared} className="numeric sm:max-w-40" />
      ) : (
        <Input
          {...shared}
          inputMode={
            kind === 'integer'
              ? 'numeric'
              : kind === 'rate' || kind === 'decimal'
                ? 'decimal'
                : undefined
          }
          autoComplete="off"
          spellCheck={false}
          className={cn(kind !== 'text' && 'numeric sm:max-w-40')}
        />
      )}
    </FormField>
  );
}

// ---------------------------------------------------------------------------------------------

function PayScheduleEditor({ draft, onChange, errors }: EditorProps<'talent.payrollSettings'>) {
  const set = (path: string, value: string) => onChange(setIn(draft, path, value));
  return (
    <>
      <div className="flex flex-col gap-2">
        {draft.cutOffs.map((cutOff, index) => (
          <FormSection
            key={index}
            title={CUT_OFF_LABELS[cutOff.key as CutOffKey] ?? `Cut-off ${index + 1}`}
          >
            <div className="grid grid-cols-3 divide-x divide-separator">
              {(['startDay', 'endDay', 'payDay'] as const).map((field) => (
                <TextField
                  key={field}
                  label={
                    field === 'startDay' ? 'Start day' : field === 'endDay' ? 'End day' : 'Pay day'
                  }
                  kind="integer"
                  value={cutOff[field]}
                  onChange={(value) => set(`cutOffs.${index}.${field}`, value)}
                  error={errors[`value.cutOffs.${index}.${field}`]}
                />
              ))}
            </div>
          </FormSection>
        ))}
        <GroupError message={errors['value.cutOffs']} />
        <p className="px-4 text-footnote text-text-secondary">
          Days run from 1 to 28, and the two cut-offs cover the month with no overlap. A pay day
          runs from 1 to 31, after the end day; past a shorter month’s end it moves to its last day.
        </p>
      </div>
      <FormSection title="Rates">
        <TextField
          label="Daily rate factor"
          kind="integer"
          value={draft.dailyRateFactor}
          onChange={(value) => set('dailyRateFactor', value)}
          error={errors['value.dailyRateFactor']}
          hint="Working days a year, used to turn a monthly salary into a daily rate."
        />
        <TextField
          label="Hours per day"
          kind="integer"
          value={draft.hoursPerDay}
          onChange={(value) => set('hoursPerDay', value)}
          error={errors['value.hoursPerDay']}
        />
      </FormSection>
      <FormSection
        title="Contribution split"
        footer="Each contribution’s two parts add up to exactly 1. The end-of-month cut-off takes any remainder."
      >
        {CONTRIBUTION_AGENCIES.map((agency) => (
          <div key={agency} className="flex flex-col">
            <div className="grid grid-cols-2 divide-x divide-separator">
              {(['midMonth', 'endOfMonth'] as const).map((part) => (
                <TextField
                  key={part}
                  label={`${AGENCY_LABELS[agency]}, ${part === 'midMonth' ? 'mid-month' : 'end-of-month'}`}
                  kind="rate"
                  value={draft.contributionSplit[agency][part]}
                  onChange={(value) => set(`contributionSplit.${agency}.${part}`, value)}
                  error={errors[`value.contributionSplit.${agency}.${part}`]}
                />
              ))}
            </div>
            <div className="pb-3 empty:hidden">
              {errors[`value.contributionSplit.${agency}`] ? (
                <GroupError message={errors[`value.contributionSplit.${agency}`]} />
              ) : null}
            </div>
          </div>
        ))}
      </FormSection>
    </>
  );
}

function SssEditor({ draft, onChange, errors }: EditorProps<'talent.sssContributions'>) {
  return (
    <GridEditor
      caption="SSS contribution schedule"
      hint="One row per monthly salary credit, in pesos. The first row starts at ₱0.00, and each row’s salary credit is its regular SS plus MPF part."
      columns={[
        { field: 'minCompensationCentavos', label: 'Compensation from', kind: 'peso' },
        { field: 'regularMscCentavos', label: 'Regular SS', group: 'Salary credit', kind: 'peso' },
        { field: 'mpfMscCentavos', label: 'MPF', group: 'Salary credit', kind: 'peso' },
        {
          field: 'employee.regularCentavos',
          label: 'Regular SS',
          group: 'Employee share',
          kind: 'peso',
        },
        { field: 'employee.mpfCentavos', label: 'MPF', group: 'Employee share', kind: 'peso' },
        {
          field: 'employer.regularCentavos',
          label: 'Regular SS',
          group: 'Employer share',
          kind: 'peso',
        },
        { field: 'employer.mpfCentavos', label: 'MPF', group: 'Employer share', kind: 'peso' },
        { field: 'ecCentavos', label: 'EC', kind: 'peso' },
      ]}
      rows={draft.rows}
      onRowsChange={(rows) => onChange({ ...draft, rows })}
      errors={errors}
      path="value.rows"
      newRow={newSssRow}
    />
  );
}

function PhilhealthEditor({
  draft,
  onChange,
  errors,
}: EditorProps<'talent.philhealthContributions'>) {
  const set = (path: string, value: string) => onChange(setIn(draft, path, value));
  return (
    <FormSection title="PhilHealth">
      <TextField
        label="Premium rate"
        kind="rate"
        value={draft.premiumRate}
        onChange={(value) => set('premiumRate', value)}
        error={errors['value.premiumRate']}
      />
      <TextField
        label="Employee’s share of the premium"
        kind="rate"
        value={draft.employeeShare}
        onChange={(value) => set('employeeShare', value)}
        error={errors['value.employeeShare']}
      />
      <TextField
        label="Income floor"
        kind="peso"
        value={draft.floorCentavos}
        onChange={(value) => set('floorCentavos', value)}
        error={errors['value.floorCentavos']}
      />
      <TextField
        label="Income ceiling"
        kind="peso"
        value={draft.ceilingCentavos}
        onChange={(value) => set('ceilingCentavos', value)}
        error={errors['value.ceilingCentavos']}
      />
    </FormSection>
  );
}

function PagibigEditor({ draft, onChange, errors }: EditorProps<'talent.pagibigContributions'>) {
  return (
    <>
      <GridEditor
        caption="Pag-IBIG brackets"
        hint="Monthly compensation up to each amount, lowest first. Leave the last bracket’s amount blank: it has no upper limit."
        columns={[
          { field: 'upToCentavos', label: 'Up to', kind: 'peso', placeholder: 'No limit' },
          { field: 'employeeRate', label: 'Employee rate', kind: 'rate', placeholder: '0.02' },
          { field: 'employerRate', label: 'Employer rate', kind: 'rate', placeholder: '0.02' },
        ]}
        rows={draft.brackets}
        onRowsChange={(brackets) => onChange({ ...draft, brackets })}
        errors={errors}
        path="value.brackets"
        newRow={newPagibigBracket}
        addLabel="Add bracket"
      />
      <FormSection title="Fund salary">
        <TextField
          label="Maximum fund salary"
          kind="peso"
          value={draft.maxFundSalaryCentavos}
          onChange={(value) => onChange({ ...draft, maxFundSalaryCentavos: value })}
          error={errors['value.maxFundSalaryCentavos']}
        />
      </FormSection>
    </>
  );
}

function WithholdingEditor({
  draft,
  onChange,
  errors,
}: EditorProps<'talent.withholdingTaxSemiMonthly'>) {
  return (
    <GridEditor
      caption="Semi-monthly withholding tax brackets"
      hint="Lowest first, in pesos. The first bracket is over ₱0.00, with no base tax and a rate of 0."
      columns={[
        { field: 'overCentavos', label: 'Compensation over', kind: 'peso' },
        { field: 'baseTaxCentavos', label: 'Base tax', kind: 'peso' },
        { field: 'rate', label: 'Rate on the excess', kind: 'rate', placeholder: '0.15' },
      ]}
      rows={draft.brackets}
      onRowsChange={(brackets) => onChange({ ...draft, brackets })}
      errors={errors}
      path="value.brackets"
      newRow={newWithholdingBracket}
      addLabel="Add bracket"
    />
  );
}

function PremiumEditor({ draft, onChange, errors }: EditorProps<'talent.premiumRates'>) {
  const set = (path: string, value: string) => onChange(setIn(draft, path, value));
  return (
    <>
      <FormSection
        title="Rates"
        footer="A rate of the daily rate, as a decimal: 1.3 is 130%. An add-on is paid on top."
      >
        {PREMIUM_RATE_FIELDS.map((field) => (
          <TextField
            key={field}
            label={PREMIUM_RATE_LABELS[field]}
            kind="rate"
            value={draft[field]}
            onChange={(value) => set(field, value)}
            error={errors[`value.${field}`]}
          />
        ))}
      </FormSection>
      <FormSection title="Night window">
        <TextField
          label="Starts at"
          kind="time"
          value={draft.nightStart}
          onChange={(value) => set('nightStart', value)}
          error={errors['value.nightStart']}
        />
        <TextField
          label="Ends at"
          kind="time"
          value={draft.nightEnd}
          onChange={(value) => set('nightEnd', value)}
          error={errors['value.nightEnd']}
        />
      </FormSection>
    </>
  );
}

function DeMinimisEditor({ draft, onChange, errors }: EditorProps<'talent.deMinimisLimits'>) {
  return (
    <GridEditor
      caption="De minimis benefits"
      hint="Give each benefit either an amount in pesos or a share of the regional minimum wage, not both. Keys use letters and digits, like riceSubsidy."
      columns={[
        { field: 'key', label: 'Key', kind: 'text', width: 'min-w-36' },
        { field: 'label', label: 'Benefit', kind: 'text', width: 'min-w-56' },
        {
          field: 'period',
          label: 'Per',
          kind: 'select',
          width: 'min-w-32',
          options: DE_MINIMIS_PERIODS.map((period) => ({
            value: period,
            label: DE_MINIMIS_PERIOD_LABELS[period].replace(/^an? /, ''),
          })),
        },
        { field: 'limitCentavos', label: 'Amount', kind: 'peso' },
        {
          field: 'rateOfMinimumWage',
          label: 'Share of minimum wage',
          kind: 'rate',
          width: 'min-w-32',
        },
      ]}
      rows={draft.items}
      onRowsChange={(items) => onChange({ ...draft, items })}
      errors={errors}
      path="value.items"
      newRow={newDeMinimisItem}
      minRows={0}
      addLabel="Add benefit"
    />
  );
}

function ThirteenthMonthEditor({
  draft,
  onChange,
  errors,
}: EditorProps<'talent.thirteenthMonthExemption'>) {
  return (
    <FormSection title="13th month pay">
      <TextField
        label="Tax-exempt ceiling"
        kind="peso"
        value={draft.exemptCeilingCentavos}
        onChange={(value) => onChange({ ...draft, exemptCeilingCentavos: value })}
        error={errors['value.exemptCeilingCentavos']}
        hint="For 13th month pay and other benefits together, per year."
      />
    </FormSection>
  );
}

function MinimumWageEditor({ draft, onChange, errors }: EditorProps<'talent.minimumWages'>) {
  return (
    <GridEditor
      caption="Daily minimum wage by region"
      hint="One row per region: the general (non-agriculture) daily rate, in pesos, and its wage order."
      columns={[
        {
          field: 'region',
          label: 'Region',
          kind: 'select',
          width: 'min-w-64',
          options: WORK_REGIONS.map((region) => ({
            value: region,
            label: WORK_REGION_LABELS[region],
          })),
        },
        { field: 'wageOrder', label: 'Wage order', kind: 'text', width: 'min-w-44' },
        { field: 'dailyRateCentavos', label: 'Daily rate', kind: 'peso' },
      ]}
      rows={draft.regions}
      onRowsChange={(regions) => onChange({ ...draft, regions })}
      errors={errors}
      path="value.regions"
      newRow={newMinimumWageRegion}
      addLabel="Add region"
    />
  );
}

function AllowanceTypesEditor({
  draft,
  onChange,
  errors,
  context,
}: EditorProps<'talent.allowanceTypes'> & { context: AllowanceEditorContext }) {
  const setType = (index: number, field: string, value: string | boolean) =>
    onChange(setIn(draft, `types.${index}.${field}`, value));
  const e = (index: number, field: string) => errors[`value.types.${index}.${field}`];
  return (
    <>
      <p className="px-4 text-footnote text-text-secondary">
        A type’s key never changes and a type is never removed: mark one you no longer use inactive.
      </p>
      {draft.types.map((type, index) => {
        const locked = index < context.lockedCount;
        return (
          <FormSection key={index} title={type.name.trim() || 'New allowance type'}>
            {locked ? (
              <div className="flex flex-col gap-0.5 px-4 py-3">
                <span className="text-subheadline font-medium text-text-primary">Key</span>
                <span className="font-mono text-subheadline">{type.key}</span>
                <span className="text-footnote text-text-secondary">Fixed once added.</span>
              </div>
            ) : (
              <TextField
                label="Key"
                value={type.key}
                onChange={(value) => setType(index, 'key', value)}
                error={e(index, 'key')}
                hint="Letters and digits, starting with a lowercase letter, like mealAllowance. Fixed once added."
              />
            )}
            <TextField
              label="Name"
              value={type.name}
              onChange={(value) => setType(index, 'name', value)}
              error={e(index, 'name')}
            />
            <FormField label="Tax treatment" required error={e(index, 'taxTreatment')}>
              <Select
                value={type.taxTreatment}
                onChange={(event) => setType(index, 'taxTreatment', event.target.value)}
              >
                {ALLOWANCE_TAX_TREATMENTS.map((treatment) => (
                  <option key={treatment} value={treatment}>
                    {ALLOWANCE_TAX_TREATMENT_LABELS[treatment]}
                  </option>
                ))}
              </Select>
            </FormField>
            {type.taxTreatment === 'deMinimis' || type.deMinimisKey ? (
              <FormField
                label="De minimis limit"
                required={type.taxTreatment === 'deMinimis'}
                error={e(index, 'deMinimisKey')}
                hint="The amount over this limit is taxed."
              >
                <Select
                  value={type.deMinimisKey}
                  onChange={(event) => setType(index, 'deMinimisKey', event.target.value)}
                >
                  <option value="">None</option>
                  {context.deMinimisOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                  {type.deMinimisKey &&
                  !context.deMinimisOptions.some((option) => option.value === type.deMinimisKey) ? (
                    <option value={type.deMinimisKey}>{type.deMinimisKey}</option>
                  ) : null}
                </Select>
              </FormField>
            ) : null}
            <FormField label="Basis" required error={e(index, 'basis')}>
              <Select
                value={type.basis}
                onChange={(event) => setType(index, 'basis', event.target.value)}
              >
                {ALLOWANCE_BASES.map((basis) => (
                  <option key={basis} value={basis}>
                    {basis === 'perCutOff'
                      ? 'A fixed amount per cut-off'
                      : 'An amount per day present'}
                  </option>
                ))}
              </Select>
            </FormField>
            <TextField
              label={`Default amount, ${ALLOWANCE_BASIS_LABELS[type.basis as keyof typeof ALLOWANCE_BASIS_LABELS] ?? 'per cut-off'}`}
              kind="peso"
              value={type.defaultAmountCentavos}
              onChange={(value) => setType(index, 'defaultAmountCentavos', value)}
              error={e(index, 'defaultAmountCentavos')}
            />
            <FormField
              label="Assign automatically"
              layout="inline"
              error={e(index, 'autoAssign')}
              hint="Every employee gets it from their date hired. Only for a fixed amount per cut-off."
            >
              <Switch
                checked={type.autoAssign}
                onCheckedChange={(checked) => setType(index, 'autoAssign', checked)}
              />
            </FormField>
            <FormField
              label="Active"
              layout="inline"
              error={e(index, 'active')}
              hint="An inactive type can’t be newly assigned."
            >
              <Switch
                checked={type.active}
                onCheckedChange={(checked) => setType(index, 'active', checked)}
              />
            </FormField>
            {locked ? null : (
              <div className="px-2 py-1">
                <Button
                  variant="plain"
                  onClick={() =>
                    onChange({ ...draft, types: draft.types.filter((_, i) => i !== index) })
                  }
                  className="text-destructive-text hover:bg-bg-grouped hover:text-destructive-text"
                >
                  <Trash2 aria-hidden="true" className="size-4.5" />
                  Remove this type
                </Button>
              </div>
            )}
          </FormSection>
        );
      })}
      <div className="px-1">
        <Button
          variant="tinted"
          onClick={() => onChange({ ...draft, types: [...draft.types, newAllowanceType()] })}
        >
          <Plus aria-hidden="true" className="size-4.5" />
          Add allowance type
        </Button>
      </div>
    </>
  );
}

// --- Build step 2.4: work schedules and timesheet settings --------------------------------------

/** The seven weekday toggles: a pressed day is a work day, the rest are rest days. */
function WeekdayToggles({
  value,
  onChange,
  error,
}: {
  value: readonly string[];
  onChange: (days: string[]) => void;
  error: string | undefined;
}) {
  const labelId = useId();
  const errorId = useId();
  const hintId = useId();
  const days = value.map(Number);
  const rest = restDaysOf(days);
  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <span id={labelId} className="text-subheadline font-medium text-text-primary">
        Work days
        <span aria-hidden="true" className="text-text-secondary">
          {' *'}
        </span>
      </span>
      <div
        role="group"
        aria-labelledby={labelId}
        aria-describedby={[hintId, error ? errorId : null].filter(Boolean).join(' ')}
        className="grid grid-cols-7 gap-1"
      >
        {ISO_WEEKDAYS.map((day) => {
          const pressed = days.includes(day);
          return (
            <button
              key={day}
              type="button"
              aria-pressed={pressed}
              aria-label={ISO_WEEKDAY_LABELS[day]}
              onClick={() =>
                onChange(
                  (pressed ? days.filter((other) => other !== day) : [...days, day])
                    .sort((a, b) => a - b)
                    .map(String),
                )
              }
              className={cn(
                'flex min-h-11 min-w-0 items-center justify-center rounded-control border text-footnote font-semibold transition-colors duration-fast motion-reduce:transition-none',
                pressed
                  ? 'border-accent bg-accent text-accent-text hover:bg-accent-hover'
                  : 'border-separator bg-surface text-text-primary hover:bg-bg-grouped',
              )}
            >
              {ISO_WEEKDAY_SHORT_LABELS[day]}
            </button>
          );
        })}
      </div>
      <p id={hintId} className="text-footnote text-text-secondary">
        {rest.length > 0 ? `Rest days: ${formatWeekdays(rest)}.` : 'No rest days.'}
      </p>
      <div aria-live="polite" className="empty:hidden">
        {error ? (
          <p
            id={errorId}
            className="flex items-start gap-1.5 text-footnote font-medium text-destructive-text"
          >
            <CircleAlert aria-hidden="true" className="mt-px size-4 shrink-0" />
            <span>{error}</span>
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A work schedule's fields: the work days, start and end, the break and the grace period. Errors
 * come under `<errorPath>.<field>` (`value.start` on the Payroll settings page, `schedule.start`
 * in "Set schedule").
 */
export function WorkScheduleFields({
  draft,
  onChange,
  errors,
  errorPath,
}: {
  draft: SettingDraft<'talent.workSchedule'>;
  onChange: (draft: SettingDraft<'talent.workSchedule'>) => void;
  errors: FieldErrors;
  errorPath: string;
}) {
  const e = (field: string) => errors[`${errorPath}.${field}`];
  const parsed = workScheduleSchema.safeParse(scheduleDraftToValue(draft));
  const set = (field: keyof SettingDraft<'talent.workSchedule'>, value: string | string[]) =>
    onChange({ ...draft, [field]: value });
  return (
    <>
      <FormSection title="Work days">
        <WeekdayToggles
          value={draft.workDays}
          onChange={(days) => set('workDays', days)}
          error={e('workDays')}
        />
      </FormSection>
      <FormSection
        title="Hours"
        footer={
          <span aria-live="polite">
            {parsed.success
              ? `${formatHours(scheduledMinutes(parsed.data))} of work a day, after the break.`
              : 'Work after the break runs from 1 to 24 hours a day.'}
          </span>
        }
      >
        <div className="grid grid-cols-2 divide-x divide-separator">
          <TextField
            label="Start"
            kind="time"
            value={draft.start}
            onChange={(value) => set('start', value)}
            error={e('start')}
          />
          <TextField
            label="End"
            kind="time"
            value={draft.end}
            onChange={(value) => set('end', value)}
            error={e('end')}
            hint="At or before the start, it ends the next day."
          />
        </div>
        <div className="grid grid-cols-2 divide-x divide-separator">
          <TextField
            label="Break starts"
            kind="time"
            value={draft.breakStart}
            onChange={(value) => set('breakStart', value)}
            error={e('breakStart')}
          />
          <TextField
            label="Break, in minutes"
            kind="integer"
            value={draft.breakMinutes}
            onChange={(value) => set('breakMinutes', value)}
            error={e('breakMinutes')}
            hint={`0 to ${BREAK_MINUTES_MAX}.`}
          />
        </div>
        <TextField
          label="Grace period, in minutes"
          kind="integer"
          value={draft.graceMinutes}
          onChange={(value) => set('graceMinutes', value)}
          error={e('graceMinutes')}
          hint={`0 to ${GRACE_MINUTES_MAX}. How late a time in can be before it counts as late.`}
        />
      </FormSection>
    </>
  );
}

function WorkScheduleEditor({ draft, onChange, errors }: EditorProps<'talent.workSchedule'>) {
  return (
    <>
      <p className="px-4 text-footnote text-text-secondary">
        Applies to every employee without their own schedule, from the version’s date.
      </p>
      <WorkScheduleFields draft={draft} onChange={onChange} errors={errors} errorPath="value" />
    </>
  );
}

function TimesheetSettingsEditor({
  draft,
  onChange,
  errors,
}: EditorProps<'talent.timesheetSettings'>) {
  return (
    <>
      <FormSection title="Offset">
        <TextField
          label="Offset ratio"
          kind="decimal"
          value={draft.offsetRatio}
          onChange={(value) => onChange({ ...draft, offsetRatio: value })}
          error={errors['value.offsetRatio']}
          hint="Offset hours earned for each hour of claimed extra work, as a decimal, like 1 or 1.5."
        />
      </FormSection>
      <FormSection title="Extra hours" footer="How each timesheet type counts claimed extra hours.">
        {TIMESHEET_TYPES.map((type) => (
          <FormField
            key={type}
            label={TIMESHEET_TYPE_TITLES[type]}
            required
            error={errors[`value.extraHours.${type}`]}
          >
            <Select
              value={draft.extraHours[type]}
              onChange={(event) => onChange(setIn(draft, `extraHours.${type}`, event.target.value))}
            >
              {EXTRA_HOURS_TREATMENTS.map((treatment) => (
                <option key={treatment} value={treatment}>
                  {EXTRA_HOURS_TREATMENT_LABELS[treatment]}
                </option>
              ))}
            </Select>
          </FormField>
        ))}
      </FormSection>
    </>
  );
}

/** The figures of one setting, for the "Add version" sheet. */
export function SettingEditor({
  settingKey,
  draft,
  onChange,
  errors,
  allowanceContext,
}: {
  settingKey: PayrollSettingKey;
  draft: SettingDraft;
  onChange: (draft: SettingDraft) => void;
  errors: FieldErrors;
  allowanceContext: AllowanceEditorContext;
}) {
  // Each editor gets its own setting's draft: the sheet holds one setting at a time.
  const props = { draft, onChange, errors } as never;
  switch (settingKey) {
    case 'talent.payrollSettings':
      return <PayScheduleEditor {...(props as EditorProps<typeof settingKey>)} />;
    case 'talent.sssContributions':
      return <SssEditor {...(props as EditorProps<typeof settingKey>)} />;
    case 'talent.philhealthContributions':
      return <PhilhealthEditor {...(props as EditorProps<typeof settingKey>)} />;
    case 'talent.pagibigContributions':
      return <PagibigEditor {...(props as EditorProps<typeof settingKey>)} />;
    case 'talent.withholdingTaxSemiMonthly':
      return <WithholdingEditor {...(props as EditorProps<typeof settingKey>)} />;
    case 'talent.premiumRates':
      return <PremiumEditor {...(props as EditorProps<typeof settingKey>)} />;
    case 'talent.deMinimisLimits':
      return <DeMinimisEditor {...(props as EditorProps<typeof settingKey>)} />;
    case 'talent.thirteenthMonthExemption':
      return <ThirteenthMonthEditor {...(props as EditorProps<typeof settingKey>)} />;
    case 'talent.minimumWages':
      return <MinimumWageEditor {...(props as EditorProps<typeof settingKey>)} />;
    case 'talent.allowanceTypes':
      return (
        <AllowanceTypesEditor
          {...(props as EditorProps<typeof settingKey>)}
          context={allowanceContext}
        />
      );
    case 'talent.workSchedule':
      return <WorkScheduleEditor {...(props as EditorProps<typeof settingKey>)} />;
    case 'talent.timesheetSettings':
      return <TimesheetSettingsEditor {...(props as EditorProps<typeof settingKey>)} />;
  }
}
