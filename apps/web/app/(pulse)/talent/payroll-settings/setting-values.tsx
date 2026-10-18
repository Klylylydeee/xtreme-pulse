'use client';

import { type ReactNode, useId } from 'react';
import { formatPeso, TIMESHEET_TYPES } from '@pulse/core';
import {
  ALLOWANCE_BASIS_LABELS,
  ALLOWANCE_TAX_TREATMENT_LABELS,
  CONTRIBUTION_AGENCIES,
  type ContributionAgency,
  CUT_OFF_LABELS,
  DE_MINIMIS_PERIOD_LABELS,
  EXTRA_HOURS_TREATMENT_LABELS,
  formatHours,
  type PayrollSettingKey,
  type PayrollSettingValues,
  PREMIUM_RATE_FIELDS,
  PREMIUM_RATE_LABELS,
  REIMBURSEMENT_LIMIT_PER_LABELS,
  type ReimbursementType,
  scheduledMinutes,
  submissionDeadlineDaysOf,
  TIMESHEET_TYPE_TITLES,
  WORK_REGION_LABELS,
  type WorkRegion,
} from '@pulse/talent';
import { cn } from '@pulse/ui';
import { Badge } from '@/components/org-structure';
import {
  formatWeekdays,
  graceText,
  ordinal,
  rateAsPercent,
  restDaysOf,
  scheduleBreakText,
  scheduleHoursText,
} from './payroll-format';

// Spec: docs/modules/talent.md#payroll-settings-and-allowances-build-step-23 — each setting's
// figures, read-only. Amounts show in pesos with tabular numerals; rates as percentages. A table
// sits in its own scrolling region (focusable, so the keyboard can scroll it), so on a phone it
// scrolls sideways there and the page never does (docs/DESIGN_SYSTEM.md#layout--components).
// From build step 2.4 the company work schedule and the timesheet settings; from build step 2.5
// the reimbursement types and the filing window (docs/modules/talent.md#reimbursements-build-step-25).

export const AGENCY_LABELS: Record<ContributionAgency, string> = {
  sss: 'SSS',
  philhealth: 'PhilHealth',
  pagibig: 'Pag-IBIG',
};

const peso = (centavos: number) => formatPeso(centavos);

/** A card of terms and values. */
function Facts({ rows }: { rows: { term: string; value: ReactNode }[] }) {
  return (
    <dl className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
      {rows.map((row) => (
        <div
          key={row.term}
          className="flex flex-col gap-0.5 px-4 py-2.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4"
        >
          <dt className="text-footnote text-text-secondary sm:text-subheadline">{row.term}</dt>
          <dd className="numeric text-subheadline break-words sm:text-right">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface TableColumn {
  label: string;
  /** A header shared by the columns next to each other that carry the same group. */
  group?: string;
  align?: 'start' | 'end';
}

/** A read-only table in its own scrolling region. */
export function ScrollTable({
  caption,
  columns,
  rows,
  tall = false,
}: {
  caption: string;
  columns: readonly TableColumn[];
  rows: readonly ReactNode[][];
  /** Long tables (SSS) also scroll down inside the region, with the header kept in view. */
  tall?: boolean;
}) {
  const captionId = useId();
  const grouped = columns.some((column) => column.group);
  // The first header row: each run of one group as one cell, ungrouped columns spanning both rows.
  const groupCells: { label: string; span: number; column?: TableColumn }[] = [];
  for (const column of columns) {
    const last = groupCells[groupCells.length - 1];
    if (column.group && last && last.label === column.group && !last.column) last.span += 1;
    else if (column.group) groupCells.push({ label: column.group, span: 1 });
    else groupCells.push({ label: column.label, span: 1, column });
  }
  const th = (column: TableColumn) =>
    cn(
      'h-11 border-b border-separator bg-surface px-3 text-footnote font-semibold whitespace-nowrap text-text-secondary first:pl-4 last:pr-4',
      column.align === 'end' ? 'text-right' : 'text-left',
    );
  return (
    <div
      role="region"
      aria-labelledby={captionId}
      tabIndex={0}
      className={cn(
        'overflow-x-auto overscroll-x-contain rounded-card bg-surface shadow-card',
        tall && 'max-h-[28rem] overflow-y-auto',
      )}
    >
      <table className="w-full border-collapse text-subheadline text-text-primary">
        <caption id={captionId} className="sr-only">
          {caption}
        </caption>
        <thead className={cn(tall && 'sticky top-0 z-10')}>
          {grouped ? (
            <>
              <tr>
                {groupCells.map((cell, index) =>
                  cell.column ? (
                    <th key={index} scope="col" rowSpan={2} className={th(cell.column)}>
                      {cell.label}
                    </th>
                  ) : (
                    <th
                      key={index}
                      scope="colgroup"
                      colSpan={cell.span}
                      className="h-9 border-b border-separator bg-surface px-3 pt-2 text-center text-footnote font-semibold whitespace-nowrap text-text-secondary"
                    >
                      {cell.label}
                    </th>
                  ),
                )}
              </tr>
              <tr>
                {columns
                  .filter((column) => column.group)
                  .map((column, index) => (
                    <th key={index} scope="col" className={th(column)}>
                      {column.label}
                    </th>
                  ))}
              </tr>
            </>
          ) : (
            <tr>
              {columns.map((column, index) => (
                <th key={index} scope="col" className={th(column)}>
                  {column.label}
                </th>
              ))}
            </tr>
          )}
        </thead>
        <tbody>
          {rows.map((cells, rowIndex) => (
            <tr key={rowIndex} className="border-b border-separator last:border-b-0">
              {cells.map((cell, index) => (
                <td
                  key={index}
                  className={cn(
                    'h-11 px-3 py-2 whitespace-nowrap first:pl-4 last:pr-4',
                    columns[index]?.align === 'end' && 'numeric text-right',
                  )}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PayScheduleValue({ value }: { value: PayrollSettingValues['talent.payrollSettings'] }) {
  return (
    <div className="flex flex-col gap-3">
      <Facts
        rows={[
          ...value.cutOffs.map((cutOff) => ({
            term: CUT_OFF_LABELS[cutOff.key],
            value: `${ordinal(cutOff.startDay)} to ${ordinal(cutOff.endDay)}, paid on the ${ordinal(cutOff.payDay)}${cutOff.payDay > 28 ? ' (the last day of a shorter month)' : ''}`,
          })),
          { term: 'Daily rate factor', value: `${value.dailyRateFactor} days a year` },
          { term: 'Hours per day', value: String(value.hoursPerDay) },
        ]}
      />
      <ScrollTable
        caption="How each contribution is split across the cut-offs"
        columns={[
          { label: 'Contribution' },
          { label: CUT_OFF_LABELS.midMonth, align: 'end' },
          { label: CUT_OFF_LABELS.endOfMonth, align: 'end' },
        ]}
        rows={CONTRIBUTION_AGENCIES.map((agency) => [
          AGENCY_LABELS[agency],
          rateAsPercent(value.contributionSplit[agency].midMonth),
          rateAsPercent(value.contributionSplit[agency].endOfMonth),
        ])}
      />
    </div>
  );
}

function SssValue({ value }: { value: PayrollSettingValues['talent.sssContributions'] }) {
  return (
    <ScrollTable
      caption={`SSS contribution schedule, ${value.rows.length} rows`}
      tall
      columns={[
        { label: 'Compensation from', align: 'end' },
        { label: 'Regular SS', group: 'Salary credit', align: 'end' },
        { label: 'MPF', group: 'Salary credit', align: 'end' },
        { label: 'Regular SS', group: 'Employee share', align: 'end' },
        { label: 'MPF', group: 'Employee share', align: 'end' },
        { label: 'Regular SS', group: 'Employer share', align: 'end' },
        { label: 'MPF', group: 'Employer share', align: 'end' },
        { label: 'EC', align: 'end' },
      ]}
      rows={value.rows.map((row) => [
        peso(row.minCompensationCentavos),
        peso(row.regularMscCentavos),
        peso(row.mpfMscCentavos),
        peso(row.employee.regularCentavos),
        peso(row.employee.mpfCentavos),
        peso(row.employer.regularCentavos),
        peso(row.employer.mpfCentavos),
        peso(row.ecCentavos),
      ])}
    />
  );
}

function PhilhealthValue({
  value,
}: {
  value: PayrollSettingValues['talent.philhealthContributions'];
}) {
  return (
    <Facts
      rows={[
        { term: 'Premium rate', value: rateAsPercent(value.premiumRate) },
        { term: 'Employee’s share of the premium', value: rateAsPercent(value.employeeShare) },
        { term: 'Income floor', value: peso(value.floorCentavos) },
        { term: 'Income ceiling', value: peso(value.ceilingCentavos) },
      ]}
    />
  );
}

function PagibigValue({ value }: { value: PayrollSettingValues['talent.pagibigContributions'] }) {
  return (
    <div className="flex flex-col gap-3">
      <ScrollTable
        caption="Pag-IBIG contribution brackets"
        columns={[
          { label: 'Monthly compensation' },
          { label: 'Employee', align: 'end' },
          { label: 'Employer', align: 'end' },
        ]}
        rows={value.brackets.map((bracket, index) => {
          const previous = value.brackets[index - 1]?.upToCentavos;
          const range =
            bracket.upToCentavos === null
              ? typeof previous === 'number'
                ? `Over ${peso(previous)}`
                : 'Any amount'
              : `Up to ${peso(bracket.upToCentavos)}`;
          return [
            <span key="range" className="numeric">
              {range}
            </span>,
            rateAsPercent(bracket.employeeRate),
            rateAsPercent(bracket.employerRate),
          ];
        })}
      />
      <Facts rows={[{ term: 'Maximum fund salary', value: peso(value.maxFundSalaryCentavos) }]} />
    </div>
  );
}

function WithholdingValue({
  value,
}: {
  value: PayrollSettingValues['talent.withholdingTaxSemiMonthly'];
}) {
  return (
    <ScrollTable
      caption="Semi-monthly withholding tax brackets"
      columns={[
        { label: 'Compensation over', align: 'end' },
        { label: 'Base tax', align: 'end' },
        { label: 'Rate on the excess', align: 'end' },
      ]}
      rows={value.brackets.map((bracket) => [
        peso(bracket.overCentavos),
        peso(bracket.baseTaxCentavos),
        rateAsPercent(bracket.rate),
      ])}
    />
  );
}

function PremiumValue({ value }: { value: PayrollSettingValues['talent.premiumRates'] }) {
  return (
    <Facts
      rows={[
        ...PREMIUM_RATE_FIELDS.map((field) => ({
          term: PREMIUM_RATE_LABELS[field],
          value: rateAsPercent(value[field]),
        })),
        { term: 'Night window', value: `${value.nightStart} to ${value.nightEnd}` },
      ]}
    />
  );
}

function DeMinimisValue({ value }: { value: PayrollSettingValues['talent.deMinimisLimits'] }) {
  if (value.items.length === 0) {
    return <p className="px-4 text-footnote text-text-secondary">No de minimis benefits listed.</p>;
  }
  return (
    <ScrollTable
      caption="De minimis limits"
      columns={[{ label: 'Benefit' }, { label: 'Limit', align: 'end' }, { label: 'Per' }]}
      rows={value.items.map((item) => [
        <span key="label" className="whitespace-normal">
          {item.label}
        </span>,
        item.limitCentavos !== null
          ? peso(item.limitCentavos)
          : `${rateAsPercent(item.rateOfMinimumWage ?? '0')} of the minimum wage`,
        DE_MINIMIS_PERIOD_LABELS[item.period].replace(/^an? /, ''),
      ])}
    />
  );
}

function ThirteenthMonthValue({
  value,
}: {
  value: PayrollSettingValues['talent.thirteenthMonthExemption'];
}) {
  return (
    <Facts
      rows={[
        {
          term: 'Tax-exempt ceiling, 13th month pay and other benefits',
          value: peso(value.exemptCeilingCentavos),
        },
      ]}
    />
  );
}

/** The count of employees below one region of a minimum wage version, and "View list". */
export type BelowWageRenderer = (region: WorkRegion) => ReactNode;

function MinimumWageValue({
  value,
  below,
}: {
  value: PayrollSettingValues['talent.minimumWages'];
  below?: BelowWageRenderer;
}) {
  return (
    <ScrollTable
      caption="Daily minimum wage by region"
      columns={[
        { label: 'Region' },
        { label: 'Wage order' },
        { label: 'Daily rate', align: 'end' },
        ...(below ? [{ label: 'Paid below it' }] : []),
      ]}
      rows={value.regions.map((row) => [
        WORK_REGION_LABELS[row.region],
        row.wageOrder,
        peso(row.dailyRateCentavos),
        ...(below ? [below(row.region)] : []),
      ])}
    />
  );
}

function AllowanceTypesValue({ value }: { value: PayrollSettingValues['talent.allowanceTypes'] }) {
  if (value.types.length === 0) {
    return <p className="px-4 text-footnote text-text-secondary">No allowance types yet.</p>;
  }
  return (
    <ul className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
      {value.types.map((type) => (
        <li key={type.key} className="flex flex-col gap-1 px-4 py-3">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-subheadline font-semibold">{type.name}</span>
            {type.autoAssign ? <Badge tone="accent">Automatic</Badge> : null}
            {type.active ? null : <Badge>Inactive</Badge>}
          </span>
          <span className="text-footnote text-text-secondary">
            <span className="numeric">{peso(type.defaultAmountCentavos)}</span>{' '}
            {ALLOWANCE_BASIS_LABELS[type.basis]} ·{' '}
            {ALLOWANCE_TAX_TREATMENT_LABELS[type.taxTreatment]}
            {type.deMinimisKey ? ` (counts against ${type.deMinimisKey})` : null} · Key{' '}
            <span className="font-mono">{type.key}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function WorkScheduleValue({ value }: { value: PayrollSettingValues['talent.workSchedule'] }) {
  const rest = restDaysOf(value.workDays);
  return (
    <Facts
      rows={[
        { term: 'Work days', value: formatWeekdays(value.workDays) },
        { term: 'Rest days', value: rest.length > 0 ? formatWeekdays(rest) : 'None' },
        { term: 'Hours', value: scheduleHoursText(value) },
        { term: 'Break', value: scheduleBreakText(value) },
        { term: 'Work a day', value: formatHours(scheduledMinutes(value)) },
        { term: 'Grace period for lates', value: graceText(value.graceMinutes) },
      ]}
    />
  );
}

/** "1 day after the cut-off ends", "3 days after the cut-off ends". */
export function submissionDeadlineText(days: number): string {
  return `${days} ${days === 1 ? 'day' : 'days'} after the cut-off ends`;
}

function TimesheetSettingsValue({
  value,
}: {
  value: PayrollSettingValues['talent.timesheetSettings'];
}) {
  return (
    <Facts
      rows={[
        {
          term: 'Offset ratio',
          value: `${value.offsetRatio} h of offset for each hour of claimed extra work`,
        },
        ...TIMESHEET_TYPES.map((type) => ({
          term: `${TIMESHEET_TYPE_TITLES[type]}, extra hours count as`,
          value: EXTRA_HOURS_TREATMENT_LABELS[value.extraHours[type]],
        })),
        // Build step 2.7 (decision 279): 1 day when the version has none (the seeded one).
        {
          term: 'Submission deadline',
          value: submissionDeadlineText(submissionDeadlineDaysOf(value)),
        },
      ]}
    />
  );
}

/** "Pick-up and drop-off · A description" — what a reimbursement type requires. */
function reimbursementRequires(type: ReimbursementType): string {
  const required = [
    type.requiresRoute ? 'pick-up and drop-off' : null,
    type.requiresDescription ? 'a description' : null,
    type.requiresClient ? 'the client' : null,
  ].filter((item): item is string => item !== null);
  if (required.length === 0) return 'Nothing else required';
  const list =
    required.length === 1
      ? required[0]
      : `${required.slice(0, -1).join(', ')} and ${required[required.length - 1]}`;
  return `Requires ${list}`;
}

/** "The current cut-off and the previous one", "The current cut-off and the 3 before it". */
export function filingWindowText(previousCutOffs: number): string {
  if (previousCutOffs === 0) return 'The current cut-off only';
  if (previousCutOffs === 1) return 'The current cut-off and the previous one';
  return `The current cut-off and the ${previousCutOffs} before it`;
}

function ReimbursementSettingsValue({
  value,
}: {
  value: PayrollSettingValues['talent.reimbursementSettings'];
}) {
  return (
    <div className="flex flex-col gap-3">
      <Facts
        rows={[
          {
            term: 'Receipts can be dated in',
            value: filingWindowText(value.filingWindowPreviousCutOffs),
          },
        ]}
      />
      {value.types.length === 0 ? (
        <p className="px-4 text-footnote text-text-secondary">No reimbursement types yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
          {value.types.map((type) => (
            <li key={type.key} className="flex flex-col gap-1 px-4 py-3">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-subheadline font-semibold">{type.name}</span>
                {type.active ? null : <Badge>Inactive</Badge>}
              </span>
              <span className="text-footnote text-text-secondary">
                {type.limit ? (
                  <>
                    Limit <span className="numeric">{peso(type.limit.amountCentavos)}</span>{' '}
                    {REIMBURSEMENT_LIMIT_PER_LABELS[type.limit.per]}
                  </>
                ) : (
                  'No limit'
                )}{' '}
                · {reimbursementRequires(type)} · Key <span className="font-mono">{type.key}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One version's figures, read-only. */
export function SettingValue({
  settingKey,
  value,
  belowWage,
}: {
  settingKey: PayrollSettingKey;
  value: PayrollSettingValues[PayrollSettingKey];
  /** Minimum wage only: the count of employees below each region, and "View list". */
  belowWage?: BelowWageRenderer;
}) {
  switch (settingKey) {
    case 'talent.payrollSettings':
      return <PayScheduleValue value={value as PayrollSettingValues[typeof settingKey]} />;
    case 'talent.sssContributions':
      return <SssValue value={value as PayrollSettingValues[typeof settingKey]} />;
    case 'talent.philhealthContributions':
      return <PhilhealthValue value={value as PayrollSettingValues[typeof settingKey]} />;
    case 'talent.pagibigContributions':
      return <PagibigValue value={value as PayrollSettingValues[typeof settingKey]} />;
    case 'talent.withholdingTaxSemiMonthly':
      return <WithholdingValue value={value as PayrollSettingValues[typeof settingKey]} />;
    case 'talent.premiumRates':
      return <PremiumValue value={value as PayrollSettingValues[typeof settingKey]} />;
    case 'talent.deMinimisLimits':
      return <DeMinimisValue value={value as PayrollSettingValues[typeof settingKey]} />;
    case 'talent.thirteenthMonthExemption':
      return <ThirteenthMonthValue value={value as PayrollSettingValues[typeof settingKey]} />;
    case 'talent.minimumWages':
      return (
        <MinimumWageValue
          value={value as PayrollSettingValues[typeof settingKey]}
          below={belowWage}
        />
      );
    case 'talent.allowanceTypes':
      return <AllowanceTypesValue value={value as PayrollSettingValues[typeof settingKey]} />;
    case 'talent.workSchedule':
      return <WorkScheduleValue value={value as PayrollSettingValues[typeof settingKey]} />;
    case 'talent.timesheetSettings':
      return <TimesheetSettingsValue value={value as PayrollSettingValues[typeof settingKey]} />;
    case 'talent.reimbursementSettings':
      return (
        <ReimbursementSettingsValue value={value as PayrollSettingValues[typeof settingKey]} />
      );
  }
}
