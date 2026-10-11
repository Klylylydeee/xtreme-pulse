'use client';

import { type ReactNode, useId } from 'react';
import Link from 'next/link';
import { ExternalLink, Lock, PencilLine, Plus, ShieldCheck, TriangleAlert } from 'lucide-react';
import { formatDate, formatPeso, TIMESHEET_TYPE_LABELS } from '@pulse/core';
import {
  CIVIL_STATUS_LABELS,
  COMPENSATION_STATUS_LABELS,
  type CompensationEntryView,
  type CompensationStatus,
  type EmployeeRecordView,
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
} from '@pulse/talent';
import { cn } from '@pulse/ui';
import { Button, buttonVariants } from '@pulse/ui/components/button';
import { MaskedField, type MaskedFieldRevealResult } from '@pulse/ui/components/masked-field';
import { Badge } from '@/components/org-structure';
import { revealSensitiveAction } from '@/lib/actions/sensitive';

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

export type RecordSectionKey =
  'personal' | 'employment' | 'compensation' | 'governmentIds' | 'bankAccount';

const NOT_SET = 'Not set';
const LATER_STEP = 'Added in a later step';

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

// --- Building blocks ---------------------------------------------------------------------------

/** One section: a header with its Edit action, then its cards. */
function RecordSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-2">
      <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 pl-4">
        <h3 id={titleId} className="text-footnote font-semibold text-text-secondary">
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** An inset grouped card of rows (each its own term and value), with optional footer help. */
function RecordCard({ footer, children }: { footer?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
        {children}
      </div>
      {footer ? <div className="px-4 text-footnote text-text-secondary">{footer}</div> : null}
    </div>
  );
}

/** A term and its value; an empty value reads "Not set" in `text-secondary`. */
function Row({ term, children }: { term: string; children?: ReactNode }) {
  const empty = children === null || children === undefined || children === '';
  return (
    <dl className="flex flex-col gap-0.5 px-4 py-2.5">
      <dt className="text-footnote text-text-secondary">{term}</dt>
      <dd className={cn('text-subheadline break-words', empty && 'text-text-secondary')}>
        {empty ? NOT_SET : children}
      </dd>
    </dl>
  );
}

function dateOrNull(value: string | null | undefined): string | null {
  return value ? formatDate(value) : null;
}

/** The section's Edit action. */
function EditButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button variant="plain" onClick={onClick} aria-label={label}>
      <PencilLine aria-hidden="true" className="size-4.5" />
      Edit
    </Button>
  );
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
}: {
  view: EmployeeRecordView;
  onEdit?: (section: RecordSectionKey) => void;
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
          <Row term="Work schedule">
            <span className="text-text-secondary">{LATER_STEP}</span>
          </Row>
        </RecordCard>
      </RecordSection>

      {view.compensation ? (
        <RecordSection
          title="Compensation"
          action={
            onEdit && can.addCompensation ? (
              <Button variant="plain" onClick={() => onEdit('compensation')}>
                <Plus aria-hidden="true" className="size-4.5" />
                Add salary change
              </Button>
            ) : null
          }
        >
          <CompensationCards compensation={view.compensation} />
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

      <RecordSection title="Documents">
        <RecordCard>
          <Row term="201 file">
            <span className="text-text-secondary">{LATER_STEP}</span>
          </Row>
          <Row term="Profile photo and e-signature">
            <span className="text-text-secondary">{LATER_STEP}</span>
          </Row>
        </RecordCard>
      </RecordSection>

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
  const { current, entries } = compensation;
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
        <Row term="Allowances">
          <span className="text-text-secondary">{LATER_STEP}</span>
        </Row>
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
