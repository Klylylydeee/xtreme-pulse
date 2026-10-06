'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { CircleCheck, UserRound } from 'lucide-react';
import {
  type BusinessDate,
  EMPLOYEE_NAME_MAX_LENGTH,
  type EmploymentStatus,
  type FieldErrors,
  formatDate,
  HIRE_EMPLOYMENT_STATUSES,
  isSeparatedStatus,
  parseEmployeeNumber,
} from '@pulse/core';
import type { UserDetail, UserListRow } from '@pulse/core/server';
import { Button } from '@pulse/ui/components/button';
import { DestructiveConfirmDialog } from '@pulse/ui/components/confirm-dialog';
import { ErrorState } from '@pulse/ui/components/error-state';
import { FormField, FormSection, Input, Select } from '@pulse/ui/components/form';
import { IconTile } from '@pulse/ui/components/icon-tile';
import { SegmentedControl } from '@pulse/ui/components/segmented-control';
import { SheetBody, SheetClose, SheetFooter, SheetHeader } from '@pulse/ui/components/sheet';
import {
  ariaKeyShortcuts,
  ShortcutHint,
  submitFormFromShortcut,
  useShortcut,
} from '@pulse/ui/components/shortcut-hint';
import { Skeleton } from '@pulse/ui/components/skeleton';
import { FormAlert } from '@/components/form-alert';
import { Badge, ReadOnlyField, useActionSubmit } from '@/components/org-structure';
import {
  createUserAction,
  getUserAction,
  resetPasswordAction,
  updateUserAction,
} from '@/lib/actions/users';
import { EmploymentStatusDialog } from './employment-status-dialog';
import { type PickedSupervisor, SupervisorPicker } from './supervisor-picker';
import { SystemAccountStatusRow } from './system-account-status';
import type { TemporaryPasswordNotice } from './temporary-password-dialog';

// Spec: docs/modules/core.md#managing-user-accounts — the create and edit sheet on `/admin/users`.
// Create: login email, name, employee number (Generate or Enter existing), date hired, a live
// department and a live position in it, a starting employment status and the supervisors. Edit:
// the same, except the employee number is fixed, the date hired stays in the number's year, and
// the employment status changes in its own dialog. The row's action flags (from the service) make
// fields read-only: one's own row and the system account entirely, and for HR a System
// Administrator's email and status. The services check all of it again. From step 1.7, a saved
// position change offers "Review access" (access never changes with the position), and a System
// Administrator can Disable or Enable the system account on its sheet.

/** A department in the pickers and the filter. */
export interface UserDepartmentOption {
  id: string;
  name: string;
  code: string;
  retired: boolean;
  /** The Board of Directors: no "no supervisor" hint. */
  isBoard: boolean;
}

/** A position in the picker. */
export interface UserPositionOption {
  id: string;
  name: string;
  departmentId: string;
  retired: boolean;
}

export interface UserSheetProps {
  departments: UserDepartmentOption[];
  positions: UserPositionOption[];
  /** Today in Manila. */
  today: BusinessDate;
  dateHiredRange: { earliest: BusinessDate; latest: BusinessDate };
  onCreated: (notice: TemporaryPasswordNotice) => void;
  /**
   * An edit saved. `reviewAccessUserId` is set when the position changed on an active user, so
   * the page can offer "Review access" (docs/modules/core.md#managing-user-accounts).
   */
  onSaved: (message: string, reviewAccessUserId: string | null) => void;
  onReset: (notice: TemporaryPasswordNotice) => void;
  /** A status change saved; the list behind is refreshed and the sheet stays open. */
  onStatusChanged: (message: string) => void;
  /** Whether the viewer may Disable or Enable the system account: a System Administrator. */
  canManageSystemAccount: boolean;
  /** The system account was disabled or enabled. */
  onSystemAccountChanged: (disabled: boolean) => void;
}

const SUBMIT = ['mod', 'enter'] as const;

type NumberMode = 'generate' | 'existing';
const NUMBER_MODES = [
  { value: 'generate', label: 'Generate' },
  { value: 'existing', label: 'Enter existing' },
] as const satisfies readonly { value: NumberMode; label: string }[];

/** The display name of a row: the person's name, or the email for the system account. */
export function displayName(user: Pick<UserListRow, 'name' | 'email'>): string {
  return user.name ?? user.email;
}

/** The first field error under `field`, including errors on its items (`reportingTo.0`). */
function errorFor(errors: FieldErrors, field: string): string | undefined {
  if (errors[field]) return errors[field];
  const key = Object.keys(errors).find((name) => name.startsWith(`${field}.`));
  return key ? errors[key] : undefined;
}

function SheetIcon() {
  return (
    <IconTile className="size-11 rounded-xl [&_svg]:size-5">
      <UserRound strokeWidth={1.75} />
    </IconTile>
  );
}

// --- The sheet's content ----------------------------------------------------------------------

/** The sheet for a new user (`target` null) or an existing one (loaded when the sheet opens). */
export function UserSheetContent({
  target,
  ...props
}: UserSheetProps & { target: UserListRow | null }) {
  if (!target) return <UserForm detail={null} {...props} />;
  return <ExistingUser key={target.id} target={target} {...props} />;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'gone' }
  | { status: 'done'; detail: UserDetail };

const LOAD_FAILED = 'The user couldn’t load. Try again.';

function ExistingUser({ target, ...props }: UserSheetProps & { target: UserListRow }) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    getUserAction(null, { id: target.id })
      .then((result) => {
        if (!current) return;
        if (!result.ok) setState({ status: 'error', message: result.formError ?? LOAD_FAILED });
        else if (!result.data) setState({ status: 'gone' });
        else setState({ status: 'done', detail: result.data });
      })
      .catch(() => {
        if (current) setState({ status: 'error', message: LOAD_FAILED });
      });
    return () => {
      current = false;
    };
  }, [target.id, attempt]);

  if (state.status === 'done') {
    return state.detail.actions.edit ? (
      <UserForm detail={state.detail} {...props} />
    ) : (
      <ReadOnlyUser detail={state.detail} {...props} />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SheetHeader title={displayName(target)} leading={<SheetIcon />} />
      <SheetBody>
        {state.status === 'loading' ? (
          <div role="status" className="flex flex-col gap-6">
            <span className="sr-only">Loading the user…</span>
            {Array.from({ length: 3 }, (_, section) => (
              <div key={section} className="flex flex-col gap-2">
                <Skeleton className="ml-4 h-3 w-24" />
                <div className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
                  {Array.from({ length: 2 }, (_, row) => (
                    <div key={row} className="flex flex-col gap-2 px-4 py-3">
                      <Skeleton className="h-4 w-28" />
                      <Skeleton className="h-11 w-full rounded-lg" />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : state.status === 'gone' ? (
          <ErrorState
            headingLevel={3}
            title="This user no longer exists"
            description="Close this and reload the page to see the current list."
          />
        ) : (
          <ErrorState
            headingLevel={3}
            title="Couldn’t load the user"
            description={state.message}
            action={
              <Button
                variant="tinted"
                onClick={() => {
                  setState({ status: 'loading' });
                  setAttempt((count) => count + 1);
                }}
              >
                Try again
              </Button>
            }
          />
        )}
      </SheetBody>
      <SheetFooter>
        <SheetClose asChild>
          <Button variant="secondary" className="pr-3">
            Close
            <ShortcutHint keys={['escape']} className="hidden sm:inline-flex" />
          </Button>
        </SheetClose>
      </SheetFooter>
    </div>
  );
}

// --- Department and position -----------------------------------------------------------------

/** Live departments, plus the employee's current one when it was retired since. */
function departmentChoices(departments: UserDepartmentOption[], currentId: string | null) {
  return departments.filter((department) => !department.retired || department.id === currentId);
}

/** Live positions in the department, plus the employee's current one when it was retired since. */
function positionChoices(
  positions: UserPositionOption[],
  departmentId: string,
  currentId: string | null,
) {
  return positions.filter(
    (position) =>
      position.departmentId === departmentId && (!position.retired || position.id === currentId),
  );
}

// --- Create and edit --------------------------------------------------------------------------

function UserForm({
  detail,
  departments,
  positions,
  today,
  dateHiredRange,
  onCreated,
  onSaved,
  onReset,
  onStatusChanged,
}: UserSheetProps & { detail: UserDetail | null }) {
  const formRef = useRef<HTMLFormElement>(null);
  const submitted = useRef({ name: '', email: '', positionId: '' });
  const [departmentId, setDepartmentId] = useState(detail?.departmentId ?? '');
  const [positionId, setPositionId] = useState(detail?.positionId ?? '');
  const [supervisors, setSupervisors] = useState<PickedSupervisor[]>(detail?.reportingTo ?? []);
  const [numberMode, setNumberMode] = useState<NumberMode>('generate');
  const [dateHired, setDateHired] = useState<string>(detail?.dateHired ?? '');
  // The status shown on the edit sheet, updated in place after a change in its dialog.
  const [status, setStatus] = useState<{
    employmentStatus: EmploymentStatus | null;
    separationDate: BusinessDate | null;
  }>({
    employmentStatus: detail?.employmentStatus ?? null,
    separationDate: detail?.separationDate ?? null,
  });
  const [statusOpen, setStatusOpen] = useState(false);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  // Whether a field was edited since the sheet opened: a reset closes the sheet, losing the edits.
  const [dirty, setDirty] = useState(false);

  const save = useActionSubmit<unknown>(detail ? updateUserAction : createUserAction, (data) => {
    const { name, email, positionId: savedPositionId } = submitted.current;
    if (detail) {
      // Access never changes with the position: the editor is offered a look at it instead.
      const positionChanged =
        detail.accountStatus === 'active' && savedPositionId !== (detail.positionId ?? '');
      onSaved(`${name} saved.`, positionChanged ? detail.id : null);
      return;
    }
    const created = data as { id: string; employeeNumber: string; temporaryPassword: string };
    onCreated({
      kind: 'created',
      userId: created.id,
      name,
      email,
      employeeNumber: created.employeeNumber,
      temporaryPassword: created.temporaryPassword,
    });
  });

  useShortcut(SUBMIT, () => submitFormFromShortcut(formRef.current), { scope: formRef });

  const actions = detail?.actions;
  const canChangeEmail = !detail || actions?.changeEmail === true;
  const department = departments.find((option) => option.id === departmentId) ?? null;
  const departmentOptions = departmentChoices(departments, detail?.departmentId ?? null);
  const positionOptions = departmentId
    ? positionChoices(positions, departmentId, detail?.positionId ?? null)
    : [];

  // On edit, the date hired stays in the employee number's year (and within the overall range).
  const numberYear = detail?.employeeNumber
    ? (parseEmployeeNumber(detail.employeeNumber)?.year ?? null)
    : null;
  const yearStart = numberYear ? (`${numberYear}-01-01` as BusinessDate) : null;
  const yearEnd = numberYear ? (`${numberYear}-12-31` as BusinessDate) : null;
  const dateMin =
    yearStart && yearStart > dateHiredRange.earliest ? yearStart : dateHiredRange.earliest;
  const dateMax = yearEnd && yearEnd < dateHiredRange.latest ? yearEnd : dateHiredRange.latest;
  const hireYear = /^\d{4}-/.test(dateHired) ? dateHired.slice(0, 4) : null;

  function changeDepartment(next: string) {
    setDepartmentId(next);
    if (
      !positions.some((position) => position.id === positionId && position.departmentId === next)
    ) {
      setPositionId('');
    }
  }

  const title = detail ? displayName(detail) : 'Add user';

  return (
    <>
      <form
        ref={formRef}
        noValidate
        onChange={(event) => {
          // Only the form's own fields: the supervisor search, in a popover, bubbles here too.
          const field = event.target as Partial<HTMLInputElement>;
          if (field.name && field.form === event.currentTarget) setDirty(true);
        }}
        onSubmit={(event) => {
          const data = new FormData(event.currentTarget);
          const first = String(data.get('firstName') ?? '').trim();
          const last = String(data.get('lastName') ?? '').trim();
          submitted.current = {
            name: [first, last].filter(Boolean).join(' ') || title,
            email: String(data.get('email') ?? '')
              .trim()
              .toLowerCase(),
            positionId: String(data.get('positionId') ?? ''),
          };
          void save.onSubmit(event);
        }}
        className="flex min-h-0 flex-1 flex-col"
      >
        <SheetHeader
          title={title}
          description={
            detail ? (
              <>
                <span className="numeric">{detail.employeeNumber}</span> · {detail.email}
              </>
            ) : undefined
          }
          leading={<SheetIcon />}
        />
        <SheetBody>
          {detail ? <input type="hidden" name="id" value={detail.id} /> : null}
          {!detail ? <input type="hidden" name="employeeNumberMode" value={numberMode} /> : null}
          <FormAlert message={save.formError} />
          {statusNotice ? (
            <p
              role="status"
              className="flex items-center gap-1.5 px-4 text-footnote font-medium text-success-text"
            >
              <CircleCheck aria-hidden="true" className="size-4 shrink-0" />
              {statusNotice}
            </p>
          ) : null}

          <FormSection
            title="Login"
            footer={
              detail
                ? 'Changing the email doesn’t sign them out.'
                : 'They sign in with this email and a temporary password, shown once after you add them.'
            }
          >
            {canChangeEmail ? (
              <FormField label="Email" required error={save.fieldErrors.email}>
                <Input
                  type="email"
                  name="email"
                  defaultValue={detail?.email ?? ''}
                  autoComplete="off"
                  spellCheck={false}
                  inputMode="email"
                  autoFocus={!detail}
                  required
                />
              </FormField>
            ) : (
              <>
                {/* Sent only to fill the form; the server keeps the stored email (updateUser). */}
                <input type="hidden" name="email" value={detail?.email ?? ''} />
                <ReadOnlyField
                  label="Email"
                  hint="Only another System Administrator can change a System Administrator’s email."
                >
                  {detail?.email}
                </ReadOnlyField>
              </>
            )}
          </FormSection>

          <FormSection title="Name">
            <FormField label="First name" required error={save.fieldErrors.firstName}>
              <Input
                name="firstName"
                defaultValue={detail?.firstName ?? ''}
                maxLength={EMPLOYEE_NAME_MAX_LENGTH}
                autoComplete="off"
                required
              />
            </FormField>
            <FormField label="Middle name" hint="Optional." error={save.fieldErrors.middleName}>
              <Input
                name="middleName"
                defaultValue={detail?.middleName ?? ''}
                maxLength={EMPLOYEE_NAME_MAX_LENGTH}
                autoComplete="off"
              />
            </FormField>
            <FormField label="Last name" required error={save.fieldErrors.lastName}>
              <Input
                name="lastName"
                defaultValue={detail?.lastName ?? ''}
                maxLength={EMPLOYEE_NAME_MAX_LENGTH}
                autoComplete="off"
                required
              />
            </FormField>
          </FormSection>

          <FormSection title="Employment">
            {detail ? (
              <ReadOnlyField label="Employee number" hint="An employee number can’t be changed.">
                <span className="numeric">{detail.employeeNumber}</span>
              </ReadOnlyField>
            ) : (
              <div className="flex flex-col gap-1.5 px-4 py-3">
                <span className="text-subheadline font-medium text-text-primary">
                  Employee number
                </span>
                <SegmentedControl
                  label="Employee number"
                  options={NUMBER_MODES}
                  value={numberMode}
                  onValueChange={setNumberMode}
                  tone="accent"
                  fullWidth
                />
                {numberMode === 'generate' ? (
                  <>
                    <p className="text-footnote text-text-secondary">
                      The next number for the year of the date hired
                      {hireYear ? `, ${hireYear}` : ''}, given when you add the user.
                    </p>
                    {save.fieldErrors.employeeNumber ? (
                      <FieldMessage message={save.fieldErrors.employeeNumber} />
                    ) : null}
                  </>
                ) : null}
              </div>
            )}
            {!detail && numberMode === 'existing' ? (
              <FormField
                label="Existing employee number"
                required
                hint={`Their company ID as YYYY-NN, in the year of the date hired${hireYear ? ` (${hireYear})` : ''}.`}
                error={save.fieldErrors.employeeNumber}
              >
                <Input
                  name="employeeNumber"
                  placeholder={`${hireYear ?? today.slice(0, 4)}-01`}
                  autoComplete="off"
                  spellCheck={false}
                  inputMode="numeric"
                  maxLength={7}
                  className="numeric"
                  required
                />
              </FormField>
            ) : null}
            <FormField
              label="Date hired"
              required
              hint={
                detail && numberYear
                  ? `Stays in ${numberYear}, the year of employee number ${detail.employeeNumber}.`
                  : `From ${formatDate(dateHiredRange.earliest)} to ${formatDate(dateHiredRange.latest)}. The account is active from today, whatever the date hired.`
              }
              error={save.fieldErrors.dateHired}
            >
              <Input
                type="date"
                name="dateHired"
                value={dateHired}
                onChange={(event) => setDateHired(event.target.value)}
                min={dateMin}
                max={dateMax}
                required
              />
            </FormField>
            {detail ? (
              <StatusRow
                status={status}
                canChange={actions?.changeEmploymentStatus === true}
                onChange={() => setStatusOpen(true)}
              />
            ) : (
              <FormField
                label="Employment status"
                required
                error={save.fieldErrors.employmentStatus}
              >
                <Select name="employmentStatus" defaultValue={HIRE_EMPLOYMENT_STATUSES[0]} required>
                  {HIRE_EMPLOYMENT_STATUSES.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </Select>
              </FormField>
            )}
          </FormSection>

          <FormSection
            title="Department and position"
            footer={
              detail
                ? 'Moving someone into or out of HR, Accounting or the Board changes their role from their next request. Their module access doesn’t change.'
                : 'New users start with no module access.'
            }
          >
            <FormField label="Department" required error={save.fieldErrors.departmentId}>
              <Select
                name="departmentId"
                value={departmentId}
                onChange={(event) => changeDepartment(event.target.value)}
                required
              >
                <option value="" disabled>
                  Choose a department
                </option>
                {departmentOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name} ({option.code}){option.retired ? ', retired' : ''}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField
              label="Position"
              required
              hint={
                !departmentId
                  ? 'Choose the department first.'
                  : positionOptions.length === 0
                    ? 'This department has no positions yet. Add one on Positions.'
                    : undefined
              }
              error={save.fieldErrors.positionId}
            >
              <Select
                name="positionId"
                value={positionId}
                onChange={(event) => setPositionId(event.target.value)}
                disabled={!departmentId || positionOptions.length === 0}
                required
              >
                <option value="" disabled>
                  Choose a position
                </option>
                {positionOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                    {option.retired ? ' (retired)' : ''}
                  </option>
                ))}
              </Select>
            </FormField>
          </FormSection>

          <FormSection title="Reports to">
            <SupervisorPicker
              value={supervisors}
              onChange={(next) => {
                setSupervisors(next);
                setDirty(true);
              }}
              excludeEmployeeId={detail?.employeeId ?? null}
              showNoSupervisorHint={!department?.isBoard}
              error={errorFor(save.fieldErrors, 'reportingTo')}
            />
          </FormSection>
        </SheetBody>
        <SheetFooter>
          {detail && actions?.resetPassword ? (
            <ResetPasswordButton user={detail} onReset={onReset} unsavedChanges={dirty} />
          ) : null}
          <SheetClose asChild>
            <Button variant="secondary" className="pr-3">
              Cancel
              <ShortcutHint keys={['escape']} className="hidden sm:inline-flex" />
            </Button>
          </SheetClose>
          <Button
            type="submit"
            loading={save.pending}
            aria-keyshortcuts={ariaKeyShortcuts(SUBMIT)}
            className="pr-3"
          >
            {detail ? 'Save' : 'Add user'}
            <ShortcutHint keys={SUBMIT} tone="on-fill" className="hidden sm:inline-flex" />
          </Button>
        </SheetFooter>
      </form>
      {/* Outside the form: React events bubble through portals, so a nested form would submit it. */}
      {detail && status.employmentStatus && detail.dateHired ? (
        <EmploymentStatusDialog
          open={statusOpen}
          onOpenChange={setStatusOpen}
          today={today}
          target={{
            id: detail.id,
            name: displayName(detail),
            employmentStatus: status.employmentStatus,
            separationDate: status.separationDate,
            dateHired: detail.dateHired,
          }}
          onChanged={(employmentStatus, separationDate) => {
            setStatus({ employmentStatus, separationDate });
            setStatusOpen(false);
            const message = `${displayName(detail)} is now ${employmentStatus}.`;
            setStatusNotice(message);
            onStatusChanged(message);
          }}
        />
      ) : null}
    </>
  );
}

function FieldMessage({ message }: { message: string }) {
  return (
    <p role="alert" className="text-footnote font-medium text-destructive-text">
      {message}
    </p>
  );
}

/** The employment status on the edit sheet, with Change status when the actor may. */
function StatusRow({
  status,
  canChange,
  onChange,
}: {
  status: { employmentStatus: EmploymentStatus | null; separationDate: BusinessDate | null };
  canChange: boolean;
  onChange: () => void;
}) {
  const separated = status.employmentStatus ? isSeparatedStatus(status.employmentStatus) : false;
  return (
    <div className="flex flex-col gap-1.5 px-4 py-3">
      <span className="text-subheadline font-medium text-text-primary">Employment status</span>
      <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <span className="flex flex-wrap items-center gap-2 text-body md:text-subheadline">
          {status.employmentStatus ?? 'None'}
          {separated ? <Badge>Deactivated</Badge> : null}
        </span>
        {canChange ? (
          <Button variant="tinted" onClick={onChange}>
            Change status
          </Button>
        ) : null}
      </div>
      <p className="text-footnote text-text-secondary">
        {status.separationDate ? `Separated on ${formatDate(status.separationDate)}. ` : null}
        {canChange
          ? 'A change takes effect at once.'
          : 'Only another System Administrator can change a System Administrator’s employment status.'}
      </p>
    </div>
  );
}

// --- Read-only --------------------------------------------------------------------------------

/** One's own row, or the system account: details only, with Reset password when allowed. */
function ReadOnlyUser({
  detail,
  onReset,
  canManageSystemAccount,
  onSystemAccountChanged,
}: UserSheetProps & { detail: UserDetail }) {
  const manageSystemAccount = detail.isSystemAccount && !detail.isSelf && canManageSystemAccount;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SheetHeader
        title={displayName(detail)}
        description={
          detail.employeeNumber ? (
            <>
              <span className="numeric">{detail.employeeNumber}</span> · {detail.email}
            </>
          ) : (
            detail.email
          )
        }
        leading={<SheetIcon />}
      />
      <SheetBody>
        <p className="rounded-card bg-surface px-4 py-3 text-footnote text-text-secondary shadow-card">
          {detail.isSelf ? (
            <>
              This is your account, so you can’t change it here. Change your password on{' '}
              <Link href="/change-password" className="font-medium text-accent underline">
                Change password
              </Link>
              .
            </>
          ) : detail.isSystemAccount ? (
            manageSystemAccount ? (
              'The system account isn’t an employee. Here you can only reset its password, or disable or enable it.'
            ) : (
              'The system account isn’t an employee, and it’s read-only here.'
            )
          ) : (
            'You can’t change this account.'
          )}
        </p>
        <FormSection title="Login">
          <ReadOnlyField label="Email">{detail.email}</ReadOnlyField>
          {detail.mustChangePassword ? (
            <ReadOnlyField label="Password">
              <Badge tone="accent">Temporary password</Badge>
            </ReadOnlyField>
          ) : null}
        </FormSection>
        {manageSystemAccount ? (
          <FormSection title="Account">
            <SystemAccountStatusRow
              disabled={detail.accountStatus !== 'active'}
              onChanged={onSystemAccountChanged}
            />
          </FormSection>
        ) : null}
        {detail.isSystemAccount ? null : (
          <>
            <FormSection title="Name">
              <ReadOnlyField label="Name">
                {[detail.firstName, detail.middleName, detail.lastName].filter(Boolean).join(' ')}
              </ReadOnlyField>
            </FormSection>
            <FormSection title="Employment">
              <ReadOnlyField label="Employee number">
                <span className="numeric">{detail.employeeNumber}</span>
              </ReadOnlyField>
              <ReadOnlyField label="Date hired">
                {detail.dateHired ? formatDate(detail.dateHired) : '—'}
              </ReadOnlyField>
              <ReadOnlyField label="Employment status">
                {detail.employmentStatus}
                {detail.separationDate
                  ? `, separated on ${formatDate(detail.separationDate)}`
                  : null}
              </ReadOnlyField>
            </FormSection>
            <FormSection title="Department and position">
              <ReadOnlyField label="Department">{detail.departmentName ?? '—'}</ReadOnlyField>
              <ReadOnlyField label="Position">{detail.positionName ?? '—'}</ReadOnlyField>
            </FormSection>
            <FormSection title="Reports to">
              {detail.reportingTo.length === 0 ? (
                <ReadOnlyField label="Supervisors">No supervisor</ReadOnlyField>
              ) : (
                detail.reportingTo.map((supervisor) => (
                  <div key={supervisor.id} className="flex min-h-14 flex-col px-4 py-2">
                    <span className="flex items-center gap-2 text-body md:text-subheadline">
                      {supervisor.name}
                      {supervisor.active ? null : <Badge>Inactive</Badge>}
                    </span>
                    <span className="numeric text-footnote text-text-secondary">
                      {supervisor.employeeNumber}
                    </span>
                  </div>
                ))
              )}
            </FormSection>
          </>
        )}
      </SheetBody>
      <SheetFooter>
        {detail.actions.resetPassword ? (
          <ResetPasswordButton user={detail} onReset={onReset} />
        ) : null}
        <SheetClose asChild>
          <Button variant="secondary" className="pr-3">
            Close
            <ShortcutHint keys={['escape']} className="hidden sm:inline-flex" />
          </Button>
        </SheetClose>
      </SheetFooter>
    </div>
  );
}

// --- Reset password ---------------------------------------------------------------------------

/** Reset password, after a confirmation: it signs the user out everywhere at once. */
function ResetPasswordButton({
  user,
  onReset,
  unsavedChanges = false,
}: {
  user: UserDetail;
  onReset: (notice: TemporaryPasswordNotice) => void;
  /** The edit form has unsaved edits, which the reset discards (it closes the sheet). */
  unsavedChanges?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const name = displayName(user);
  const reset = useActionSubmit<{ temporaryPassword: string }>(resetPasswordAction, (data) =>
    onReset({
      kind: 'reset',
      name,
      email: user.email,
      employeeNumber: null,
      temporaryPassword: data.temporaryPassword,
    }),
  );

  return (
    <>
      <Button
        variant="plain"
        onClick={() => {
          reset.reset();
          setConfirming(true);
        }}
        className="mr-auto text-destructive-text hover:bg-bg-grouped hover:text-destructive-text"
      >
        Reset password
      </Button>
      <DestructiveConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Reset ${name}’s password?`}
        description={`Their current password stops working and they’re signed out everywhere at once. You’ll get a new temporary password to hand over; they change it when they sign in.${unsavedChanges ? ' Unsaved changes in this form will be lost.' : ''}`}
        confirmLabel="Reset password"
        error={reset.formError}
        onConfirm={async () => {
          const ok = await reset.run({ id: user.id });
          if (!ok) throw new Error('Reset refused');
        }}
      />
    </>
  );
}
