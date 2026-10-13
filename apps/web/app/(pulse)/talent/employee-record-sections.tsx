'use client';

import { type ReactNode, useId } from 'react';
import Link from 'next/link';
import {
  CalendarClock,
  Clock,
  ExternalLink,
  Lock,
  Plus,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import { addCentavos, formatDate, formatPeso, TIMESHEET_TYPE_LABELS } from '@pulse/core';
import {
  ALLOWANCE_BASIS_LABELS,
  type AllowanceAssignmentView,
  type AllowanceLineView,
  type AllowancesSectionView,
  CIVIL_STATUS_LABELS,
  COMPENSATION_STATUS_LABELS,
  type CompensationEntryView,
  type CompensationStatus,
  type EmployeeRecordView,
  formatHours,
  formatMobileNumber,
  formatPagibigMid,
  formatPhilhealthPin,
  formatSssNumber,
  formatTin,
  type MaskedAmountView,
  type MaskedDigitsView,
  PAYROLL_BANK_LABELS,
  RATE_TYPE_LABELS,
  type RevealTarget,
  SEX_LABELS,
  WORK_REGION_LABELS,
  type WorkScheduleAssignmentView,
  type WorkScheduleSectionView,
} from '@pulse/talent';
import { cn } from '@pulse/ui';
import { Button, buttonVariants } from '@pulse/ui/components/button';
import { MaskedField, type MaskedFieldRevealResult } from '@pulse/ui/components/masked-field';
import { Badge } from '@/components/org-structure';
import { revealSensitiveAction } from '@/lib/actions/sensitive';
import {
  type DocumentHandlers,
  DocumentsSection,
  SkillsCertificationsSection,
} from './employee-documents-sections';
import {
  formatWeekdays,
  graceText,
  restDaysOf,
  scheduleBreakText,
  scheduleHoursText,
  scheduleSummary,
} from './payroll-settings/payroll-format';
import { dateOrNull, EditButton, RecordCard, RecordSection, Row } from './record-ui';

// Spec: docs/modules/talent.md#the-employee-record-build-step-21, SECURITY.md#sensitive-data and
// docs/DESIGN_SYSTEM.md#layout--components ("Employee record") — the record's inset grouped
// sections, shared by the `/talent` inspector and `/talent/me`. They show only what the server
// sent for this viewer:
//
// - Compensation, Government IDs and Payroll bank account appear only when the view has them. A
//   viewer who may not see them gets the one `restrictedNotice` line instead, never an empty or
//   locked field.
// - Government IDs and the account number show their last 4 digits, a salary `••••` with no
//   digits, until Reveal fetches the full value through the reveal Server Action (access-checked
//   and audit-logged on the server); Hide forgets it again.
// - Core's identity fields are read-only, marked "Managed in Users".
// - Each section's Edit action shows only when the view's `can` flag allows it; the services check
//   again. Nothing here is logged, and no value is kept anywhere but the masked field's own state.
// - From step 2.2 the Documents section holds the photo, the e-signature status and the 201 file,
//   and a Skills & certifications section follows it (`employee-documents-sections.tsx`).
// - From step 2.3 (docs/modules/talent.md#payroll-settings-and-allowances-build-step-23) the
//   Compensation section shows the "Below minimum wage" badge on the current salary (the server's
//   `belowMinimumWage`, no amount), and the allowances when the view has them (only for a viewer
//   who may reveal `allowances`), with "Assign allowance" when `can.assignAllowance`.
// - From step 2.4 (docs/modules/talent.md#work-schedules-and-daily-time-entries-build-step-24) a
//   Work schedule section follows Employment (`WorkScheduleSection`, passed in as `workSchedule`
//   because it loads on its own): the schedule in effect, the scheduled changes and the history,
//   with "Set schedule" and "Timesheet" in the inspector. A schedule isn't sensitive.

export type RecordSectionKey =
  'personal' | 'employment' | 'compensation' | 'allowance' | 'governmentIds' | 'bankAccount';

/** The reveal for a masked value: the reveal Server Action, its answer formatted for display. */
function revealOf(target: RevealTarget, format: (value: string) => string) {
  return async (): Promise<MaskedFieldRevealResult> => {
    const result = await revealSensitiveAction(null, {
      ownerType: target.ownerType,
      ownerId: target.ownerId,
      field: target.field,
    });
    return result.ok
      ? { ok: true, data: format(result.data) }
      : { ok: false, formError: result.formError };
  };
}

/** A revealed salary arrives as whole centavos. */
function formatRevealedSalary(value: string): string {
  return /^\d+$/.test(value) ? formatPeso(Number(value)) : value;
}

/** A masked government ID or account number, or "Not set" when none is stored. */
function MaskedDigitsRow({
  label,
  value,
  format,
}: {
  label: string;
  value: MaskedDigitsView | null;
  format: (digits: string) => string;
}) {
  if (!value) return <Row term={label} />;
  return <MaskedField label={label} lastFour={value.lastFour} reveal={revealOf(value, format)} />;
}

/** A masked salary: "••••", no digits, until revealed. */
function MaskedSalary({ label, value }: { label: string; value: MaskedAmountView }) {
  return <MaskedField label={label} lastFour="" reveal={revealOf(value, formatRevealedSalary)} />;
}

const STATUS_TONES: Record<CompensationStatus, 'accent' | 'neutral'> = {
  current: 'accent',
  scheduled: 'neutral',
  superseded: 'neutral',
  previous: 'neutral',
};

// --- The record --------------------------------------------------------------------------------

/**
 * The record's sections. `onEdit` opens a section's sheet (the `/talent` inspector); without it,
 * as on `/talent/me`, the record is read-only.
 */
export function EmployeeRecordSections({
  view,
  onEdit,
  documentHandlers,
  photoSlot,
  workSchedule,
  showESignature = true,
}: {
  view: EmployeeRecordView;
  onEdit?: (section: RecordSectionKey) => void;
  /** The inspector's 201 file, skills and certification actions; read-only without them. */
  documentHandlers?: DocumentHandlers;
  /** The photo row at the top of Documents (the inspector's photo with Change and Remove). */
  photoSlot?: ReactNode;
  /** The Work schedule section (step 2.4), after Employment. */
  workSchedule?: ReactNode;
  /** False on `/talent/me`, which shows the e-signature in its own section. */
  showESignature?: boolean;
}) {
  const { identity, personal, employment, can } = view;
  const name = `${identity.firstName} ${identity.lastName}`;
  const edit = (section: RecordSectionKey, flag: boolean, label: string) =>
    onEdit && flag ? <EditButton label={label} onClick={() => onEdit(section)} /> : null;
  const contact = personal.emergencyContact;

  return (
    <div className="flex flex-col gap-5">
      <RecordSection
        title="Personal"
        action={edit('personal', can.editPersonal, 'Edit personal details')}
      >
        <RecordCard>
          {'dateOfBirth' in personal ? (
            <Row term="Date of birth">{dateOrNull(personal.dateOfBirth)}</Row>
          ) : null}
          <Row term="Sex">{personal.sex ? SEX_LABELS[personal.sex] : null}</Row>
          {'civilStatus' in personal ? (
            <Row term="Civil status">
              {personal.civilStatus ? CIVIL_STATUS_LABELS[personal.civilStatus] : null}
            </Row>
          ) : null}
          <Row term="Nationality">{personal.nationality}</Row>
          <Row term="Mobile number">
            {personal.mobileNumber ? (
              <span className="numeric">{formatMobileNumber(personal.mobileNumber)}</span>
            ) : null}
          </Row>
          <Row term="Personal email">{personal.personalEmail}</Row>
          <Row term="Present address">{personal.presentAddress}</Row>
          <Row term="Permanent address">{personal.permanentAddress}</Row>
        </RecordCard>
        <RecordCard>
          <Row term="Emergency contact">{contact?.name}</Row>
          <Row term="Relationship">{contact?.relationship}</Row>
          <Row term="Emergency contact’s mobile">
            {contact?.mobileNumber ? (
              <span className="numeric">{formatMobileNumber(contact.mobileNumber)}</span>
            ) : null}
          </Row>
        </RecordCard>
      </RecordSection>

      <RecordSection
        title="Employment"
        action={edit('employment', can.editEmployment, 'Edit employment details')}
      >
        <RecordCard
          footer={
            <span className="flex flex-wrap items-center gap-x-2">
              <span>Managed in Users.</span>
              {view.editInUsersHref ? (
                <Link
                  href={view.editInUsersHref}
                  className="inline-flex min-h-11 items-center gap-1 font-semibold text-accent underline-offset-2 hover:underline"
                >
                  Edit in Users
                  <ExternalLink aria-hidden="true" className="size-3.5" />
                </Link>
              ) : null}
            </span>
          }
        >
          <Row term="Employee number">
            <span className="numeric">{identity.employeeNumber}</span>
          </Row>
          <Row term="Login email">{identity.email}</Row>
          <Row term="Department">{identity.department?.name}</Row>
          <Row term="Position">{identity.position?.name}</Row>
          <Row term="Reports to">
            {identity.reportingTo.length > 0
              ? identity.reportingTo.map((supervisor) => supervisor.name).join(', ')
              : null}
          </Row>
          <Row term="Employment status">{identity.employmentStatus}</Row>
          <Row term="Date hired">{formatDate(identity.dateHired)}</Row>
          {identity.separationDate ? (
            <Row term="Separation date">{formatDate(identity.separationDate)}</Row>
          ) : null}
          <Row term="Timesheet type">
            {identity.position ? TIMESHEET_TYPE_LABELS[identity.position.timesheetType] : null}
          </Row>
        </RecordCard>
        <RecordCard>
          <Row term="Work region">{WORK_REGION_LABELS[employment.workRegion]}</Row>
          {employment.probationEndDate ? (
            <Row term="Probation ends">{formatDate(employment.probationEndDate)}</Row>
          ) : null}
          {identity.employmentStatus === 'Contractual' || employment.contractEndDate ? (
            <Row term="Contract end date">
              {employment.contractEndDateMissing ? (
                <span className="inline-flex items-start gap-1.5 font-medium text-warning-text">
                  <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  Contract end date missing
                </span>
              ) : (
                dateOrNull(employment.contractEndDate)
              )}
            </Row>
          ) : null}
          <Row term="Regularization date">{dateOrNull(employment.regularizationDate)}</Row>
          {identity.separated || employment.separationRemarks ? (
            <Row term="Separation remarks">{employment.separationRemarks}</Row>
          ) : null}
        </RecordCard>
      </RecordSection>

      {workSchedule}

      {view.compensation || view.allowances ? (
        <RecordSection
          title="Compensation"
          action={
            onEdit && view.compensation && can.addCompensation ? (
              <Button variant="plain" onClick={() => onEdit('compensation')}>
                <Plus aria-hidden="true" className="size-4.5" />
                Add salary change
              </Button>
            ) : null
          }
        >
          {view.compensation ? <CompensationCards compensation={view.compensation} /> : null}
          {view.allowances ? (
            <AllowancesBlock
              allowances={view.allowances}
              onAssign={onEdit && can.assignAllowance ? () => onEdit('allowance') : undefined}
            />
          ) : null}
        </RecordSection>
      ) : null}

      {view.governmentIds ? (
        <RecordSection
          title="Government IDs"
          action={edit('governmentIds', can.editGovernmentIds, 'Edit government IDs')}
        >
          <RecordCard>
            <MaskedDigitsRow label="TIN" value={view.governmentIds.tin} format={formatTin} />
            <Row term="RDO code">
              {view.governmentIds.rdoCode ? (
                <span className="numeric">{view.governmentIds.rdoCode}</span>
              ) : null}
            </Row>
            <MaskedDigitsRow
              label="SSS number"
              value={view.governmentIds.sss}
              format={formatSssNumber}
            />
            <MaskedDigitsRow
              label="PhilHealth PIN"
              value={view.governmentIds.philhealth}
              format={formatPhilhealthPin}
            />
            <MaskedDigitsRow
              label="Pag-IBIG MID"
              value={view.governmentIds.pagibig}
              format={formatPagibigMid}
            />
          </RecordCard>
        </RecordSection>
      ) : null}

      {view.bankAccount ? (
        <RecordSection
          title="Payroll bank account"
          action={edit('bankAccount', can.editBankAccount, 'Edit payroll bank account')}
        >
          <RecordCard>
            <Row term="Bank">
              {view.bankAccount.bank ? PAYROLL_BANK_LABELS[view.bankAccount.bank] : null}
            </Row>
            <MaskedDigitsRow
              label="Account number"
              value={view.bankAccount.accountNumber}
              format={(digits) => digits}
            />
            <Row term="Account name">{view.bankAccount.accountName}</Row>
          </RecordCard>
        </RecordSection>
      ) : null}

      {view.restrictedNotice ? (
        <p className="flex items-start gap-3 rounded-card bg-surface px-4 py-3 text-subheadline text-text-secondary shadow-card">
          <Lock aria-hidden="true" className="mt-0.5 size-4.5 shrink-0" />
          <span>{view.restrictedNotice}</span>
        </p>
      ) : null}

      <DocumentsSection
        view={view}
        handlers={documentHandlers}
        photoSlot={photoSlot}
        showESignature={showESignature}
      />

      <SkillsCertificationsSection view={view} handlers={documentHandlers} />

      {view.manageAccessHref ? (
        <Link
          href={view.manageAccessHref}
          className={cn(buttonVariants({ variant: 'tinted' }), 'self-start')}
          aria-label={`Manage access for ${name}`}
        >
          <ShieldCheck aria-hidden="true" className="size-4.5" />
          Manage access
        </Link>
      ) : null}
    </div>
  );
}

/** The current salary, then the history, newest first, each with its status badge. */
function CompensationCards({
  compensation,
}: {
  compensation: NonNullable<EmployeeRecordView['compensation']>;
}) {
  const { current, entries, belowMinimumWage } = compensation;
  const historyId = useId();
  return (
    <>
      <RecordCard
        footer={
          current
            ? `Effective ${formatDate(current.effectiveDate)}.`
            : entries.length > 0
              ? 'No salary is in effect yet: the first one is scheduled.'
              : 'No salary recorded yet.'
        }
      >
        {current ? (
          <>
            {belowMinimumWage ? (
              <div className="px-4 py-2.5">
                <BelowMinimumWageBadge />
              </div>
            ) : null}
            <MaskedSalary
              label={current.rateType === 'daily' ? 'Daily rate' : 'Basic salary'}
              value={current.basicSalary}
            />
            <Row term="Rate type">{RATE_TYPE_LABELS[current.rateType]}</Row>
            <Row term="Minimum wage earner">{current.minimumWageEarner ? 'Yes' : 'No'}</Row>
          </>
        ) : (
          <Row term="Basic salary" />
        )}
      </RecordCard>
      {entries.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h4 id={historyId} className="px-4 text-footnote font-semibold text-text-secondary">
            Salary history
          </h4>
          <ol
            aria-labelledby={historyId}
            className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card"
          >
            {entries.map((entry) => (
              <CompensationEntryRow key={entry.id} entry={entry} />
            ))}
          </ol>
        </div>
      ) : null}
    </>
  );
}

function CompensationEntryRow({ entry }: { entry: CompensationEntryView }) {
  return (
    <li className="flex flex-col gap-1 py-2">
      <div className="flex flex-wrap items-center gap-2 px-4">
        <span className="numeric text-subheadline font-semibold">
          {formatDate(entry.effectiveDate)}
        </span>
        <Badge tone={STATUS_TONES[entry.status]}>{COMPENSATION_STATUS_LABELS[entry.status]}</Badge>
      </div>
      <MaskedSalary label="Amount" value={entry.basicSalary} />
      <p className="px-4 text-footnote text-text-secondary">
        {RATE_TYPE_LABELS[entry.rateType]}
        {entry.minimumWageEarner ? ' · Minimum wage earner' : null}
      </p>
      <p className="px-4 text-footnote break-words text-text-primary">{entry.reason}</p>
    </li>
  );
}

// --- Step 2.3: the minimum wage badge and the allowances ----------------------------------------

/** The current salary is below today's minimum wage: text and an icon, never color alone. */
function BelowMinimumWageBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-bg-grouped px-2 py-0.5 text-footnote font-medium whitespace-nowrap text-warning-text">
      <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />
      Below minimum wage
    </span>
  );
}

/**
 * An automatic line's company default: "₱500.00 per cut-off (₱1,000.00 a month)". A month has
 * exactly two cut-offs, so the monthly figure is the amount twice, in whole centavos.
 */
function defaultAmountText(
  amount: number | undefined,
  basis: AllowanceLineView['basis'],
): string | null {
  if (amount === undefined) return null;
  if (basis === 'perCutOff') {
    return `${formatPeso(amount)} ${ALLOWANCE_BASIS_LABELS.perCutOff} (${formatPeso(addCentavos(amount, amount))} a month)`;
  }
  return basis ? `${formatPeso(amount)} ${ALLOWANCE_BASIS_LABELS[basis]}` : formatPeso(amount);
}

/** "Automatic from Nov 3, 2026", "Assigned from …", or "Starts …" for a later date. */
function sinceText(line: AllowanceLineView): string {
  if (line.upcoming) return `Starts ${formatDate(line.since)}`;
  return `${line.origin === 'automatic' ? 'Automatic' : 'Assigned'} from ${formatDate(line.since)}`;
}

/**
 * The allowances in effect, then the explicit assignments, newest first. Only for a viewer who
 * may reveal `allowances` (the server leaves `view.allowances` out otherwise). An automatic line
 * shows the company default unmasked; an assigned amount stays "••••" until revealed.
 */
function AllowancesBlock({
  allowances,
  onAssign,
}: {
  allowances: AllowancesSectionView;
  /** Opens "Assign allowance"; without it the allowances are read-only. */
  onAssign?: () => void;
}) {
  const { lines, history } = allowances;
  const headingId = useId();
  const historyId = useId();
  return (
    <>
      <div className="flex flex-col gap-2">
        <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 pl-4">
          <h4 id={headingId} className="text-footnote font-semibold text-text-secondary">
            Allowances
          </h4>
          {onAssign ? (
            <Button variant="plain" onClick={onAssign}>
              <Plus aria-hidden="true" className="size-4.5" />
              Assign allowance
            </Button>
          ) : null}
        </div>
        {lines.length > 0 ? (
          <ul
            aria-labelledby={headingId}
            className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card"
          >
            {lines.map((line) => (
              <AllowanceLineRow key={line.typeKey} line={line} />
            ))}
          </ul>
        ) : (
          <p className="rounded-card bg-surface px-4 py-3 text-subheadline text-text-secondary shadow-card">
            No allowances.
          </p>
        )}
      </div>
      {history.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h4 id={historyId} className="px-4 text-footnote font-semibold text-text-secondary">
            Allowance history
          </h4>
          <ol
            aria-labelledby={historyId}
            className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card"
          >
            {history.map((entry) => (
              <AllowanceHistoryRow key={entry.id} entry={entry} />
            ))}
          </ol>
        </div>
      ) : null}
    </>
  );
}

function AllowanceLineRow({ line }: { line: AllowanceLineView }) {
  if (line.origin === 'assigned' && line.amount) {
    return (
      <li className="flex flex-col pb-2.5">
        <MaskedSalary label={line.name} value={line.amount} />
        <p className="px-4 text-footnote text-text-secondary">
          {[line.basis ? ALLOWANCE_BASIS_LABELS[line.basis] : null, sinceText(line)]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </li>
    );
  }
  const amount = defaultAmountText(line.defaultAmountCentavos, line.basis);
  return (
    <li className="px-4 py-2.5 text-subheadline break-words">
      <span className="font-medium">{line.name}</span>
      {amount ? <span className="numeric"> · {amount}</span> : null}
      <span className="text-text-secondary"> · {sinceText(line)}</span>
    </li>
  );
}

function AllowanceHistoryRow({ entry }: { entry: AllowanceAssignmentView }) {
  return (
    <li className="flex flex-col gap-1 py-2">
      <div className="flex flex-wrap items-center gap-2 px-4">
        <span className="numeric text-subheadline font-semibold">
          {formatDate(entry.effectiveDate)}
        </span>
        <Badge tone={STATUS_TONES[entry.status]}>{COMPENSATION_STATUS_LABELS[entry.status]}</Badge>
      </div>
      {entry.kind === 'set' && entry.amount ? (
        <MaskedSalary label={entry.typeName} value={entry.amount} />
      ) : (
        <p className="px-4 text-subheadline break-words">
          {entry.typeName} <span className="text-text-secondary">· Ended</span>
        </p>
      )}
      <p className="px-4 text-footnote break-words text-text-primary">{entry.reason}</p>
    </li>
  );
}

// --- Step 2.4: the work schedule ----------------------------------------------------------------

/**
 * The Work schedule section (docs/modules/talent.md#work-schedules-and-daily-time-entries-build-step-24):
 * the schedule in effect and where it comes from (Company default or Own schedule), the scheduled
 * changes and the history of the employee's own entries. `onSet` shows "Set schedule" (the
 * inspector, when the server's `canSet` allows it); `timesheetHref` adds the "Timesheet" link
 * (the inspector, for Talent Read). Read-only without them, as on `/talent/me`.
 */
export function WorkScheduleSection({
  section,
  onSet,
  timesheetHref,
  timesheetLabel,
}: {
  section: WorkScheduleSectionView;
  onSet?: () => void;
  timesheetHref?: string;
  /** The link's accessible name, such as "Timesheet for Ana Cruz". */
  timesheetLabel?: string;
}) {
  const { current, asOf, scheduled, history } = section;
  const { schedule } = current;
  const rest = restDaysOf(schedule.workDays);
  const scheduledId = useId();
  const historyId = useId();
  const past = history.filter((entry) => entry.effectiveFrom <= asOf);
  return (
    <RecordSection
      title="Work schedule"
      action={
        onSet && section.canSet ? (
          <Button variant="plain" onClick={onSet}>
            <CalendarClock aria-hidden="true" className="size-4.5" />
            Set schedule
          </Button>
        ) : null
      }
    >
      <RecordCard
        footer={
          current.origin === 'company'
            ? `The company default, in effect since ${formatDate(current.effectiveFrom)}.`
            : `In effect since ${formatDate(current.effectiveFrom)}.`
        }
      >
        <div className="px-4 py-2.5">
          <Badge tone={current.origin === 'own' ? 'accent' : 'neutral'}>
            {current.origin === 'own' ? 'Own schedule' : 'Company default'}
          </Badge>
        </div>
        <Row term="Work days">{formatWeekdays(schedule.workDays)}</Row>
        <Row term="Rest days">{rest.length > 0 ? formatWeekdays(rest) : 'None'}</Row>
        <Row term="Hours">
          <span className="numeric">{scheduleHoursText(schedule)}</span>
        </Row>
        <Row term="Break">
          <span className="numeric">{scheduleBreakText(schedule)}</span>
        </Row>
        <Row term="Work a day">
          <span className="numeric">{formatHours(section.currentScheduledMinutes)}</span>
        </Row>
        <Row term="Grace period for lates">
          <span className="numeric">{graceText(schedule.graceMinutes)}</span>
        </Row>
      </RecordCard>

      {scheduled.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h4 id={scheduledId} className="px-4 text-footnote font-semibold text-text-secondary">
            Scheduled
          </h4>
          <ol
            aria-labelledby={scheduledId}
            className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card"
          >
            {scheduled.map((entry) => (
              <ScheduleEntryRow key={entry.id} entry={entry} status="Scheduled" />
            ))}
          </ol>
        </div>
      ) : null}

      {past.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h4 id={historyId} className="px-4 text-footnote font-semibold text-text-secondary">
            Schedule history
          </h4>
          <ol
            aria-labelledby={historyId}
            className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card"
          >
            {past.map((entry, index) => (
              <ScheduleEntryRow
                key={entry.id}
                entry={entry}
                status={index === 0 ? 'In effect' : 'Superseded'}
              />
            ))}
          </ol>
        </div>
      ) : null}

      {timesheetHref ? (
        <Link
          href={timesheetHref}
          className={cn(buttonVariants({ variant: 'tinted' }), 'self-start')}
          aria-label={timesheetLabel}
        >
          <Clock aria-hidden="true" className="size-4.5" />
          Timesheet
        </Link>
      ) : null}
    </RecordSection>
  );
}

function ScheduleEntryRow({
  entry,
  status,
}: {
  entry: WorkScheduleAssignmentView;
  status: 'Scheduled' | 'In effect' | 'Superseded';
}) {
  return (
    <li className="flex flex-col gap-1 px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="numeric text-subheadline font-semibold">
          From {formatDate(entry.effectiveFrom)}
        </span>
        <Badge tone={status === 'In effect' ? 'accent' : 'neutral'}>{status}</Badge>
      </div>
      <p className="numeric text-footnote text-text-secondary">
        {entry.schedule
          ? `${scheduleSummary(entry.schedule)} · Break ${scheduleBreakText(entry.schedule)}`
          : 'Back to the company default'}
      </p>
      <p className="text-footnote break-words text-text-primary">{entry.reason}</p>
    </li>
  );
}
