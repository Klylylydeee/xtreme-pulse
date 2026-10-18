'use client';

import { type ReactNode, useEffect, useState } from 'react';
import { CircleCheck, Pencil, Plus, RotateCw } from 'lucide-react';
import { type FieldErrors, formatDate } from '@pulse/core';
import {
  formatLeaveDays,
  formatOffsetHours,
  LEAVE_ENTRY_REASON_MAX_LENGTH,
  LEAVE_OPENING_DAYS_MAX,
} from '@pulse/talent';
import type {
  OpeningBalanceRow,
  OpeningBalancesView,
  PayrollOpeningSectionView,
} from '@pulse/talent/server';
import { cn } from '@pulse/ui';
import { Button } from '@pulse/ui/components/button';
import { ErrorState } from '@pulse/ui/components/error-state';
import { FormField, FormSection, Input, Select, Textarea } from '@pulse/ui/components/form';
import { SheetBody, SheetClose, SheetFooter, SheetHeader } from '@pulse/ui/components/sheet';
import { Skeleton } from '@pulse/ui/components/skeleton';
import { FormAlert } from '@/components/form-alert';
import { Badge, useActionSubmit } from '@/components/org-structure';
import {
  addLeaveCorrectionAction,
  addOffsetCorrectionAction,
  enterLeaveOpeningAction,
  enterOffsetOpeningAction,
  enterPayrollOpeningAction,
  getPayrollOpeningSectionAction,
} from '@/lib/actions/talent-opening-balances';
import { type PayrollOpeningFieldLabel, PayrollOpeningCards } from '../employee-record-sections';

// Spec: docs/modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28 ("Opening
// balances", "Screens"; decisions 306–308 in docs/BUILD_PLAN.md) and SECURITY.md#sensitive-data —
// the sheets of `/talent/opening-balances`, and the correction sheet the employee inspector's Time
// off section opens too.
//
// - `EmployeeOpeningSheet`: one employee. Each credited type (VL, SL) and offset shows its opening,
//   or, while it isn't entered and the viewer may enter it, a field and "Save": entered once,
//   dated the go-live date. Then "Add correction", and year-to-date pay.
// - `CorrectionSheet`: an `adjustment` with a required reason: signed days for a credited type,
//   signed hours for offset.
// - Year-to-date pay loads on its own, masked, only for a viewer who may reveal `salary` for the
//   employee; the others see only Entered or Not entered. "Enter" (or "Correct") opens the seven
//   figures, typed in pesos; a correction needs a reason and names the entry it replaces. The
//   amounts typed go to the Server Action and are never shown back; nothing here is logged.
// - Every save shows the server's words next to the field; the services check access again.

const LOAD_FAILED = 'Year-to-date pay couldn’t load. Check your connection and try again.';
const SAVE_FAILED = 'It wasn’t saved. Check your connection and try again.';

/** A credited type, for the correction's "What" and the opening rows. */
export interface CorrectionLeaveType {
  key: string;
  name: string;
  shortName: string;
}

/** A success line inside a sheet. */
function SavedLine({ message }: { message: string | null }) {
  return (
    <div role="status" className="empty:hidden">
      {message ? (
        <p className="flex items-start gap-2 rounded-card bg-surface px-4 py-3 text-footnote font-medium text-success-text shadow-card">
          <CircleCheck aria-hidden="true" className="mt-px size-4 shrink-0" />
          <span>{message}</span>
        </p>
      ) : null}
    </div>
  );
}

/** An amount input with the ₱ sign in front. */
function PesoInput({ name, defaultValue }: { name: string; defaultValue?: string }) {
  return (
    <div className="relative sm:max-w-56">
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-text-secondary"
      >
        ₱
      </span>
      <Input
        name={name}
        defaultValue={defaultValue}
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        required
        className="numeric pl-7"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// An opening: one field and Save

function OpeningField({
  employeeId,
  label,
  hint,
  unit,
  typeKey,
  onSaved,
}: {
  employeeId: string;
  label: string;
  hint: string;
  unit: 'days' | 'hours';
  /** The credited type's key; null for offset. */
  typeKey: string | null;
  onSaved: () => void;
}) {
  const leave = useActionSubmit(enterLeaveOpeningAction, onSaved);
  const offset = useActionSubmit(enterOffsetOpeningAction, onSaved);
  const save = typeKey === null ? offset : leave;
  const [value, setValue] = useState('');
  const [networkError, setNetworkError] = useState<string | null>(null);
  const error =
    save.fieldErrors[typeKey === null ? 'minutes' : 'halfDays'] ??
    save.fieldErrors.typeKey ??
    save.fieldErrors.employeeId;

  async function submit() {
    setNetworkError(null);
    try {
      if (typeKey === null) await offset.run({ employeeId, minutes: value });
      else await leave.run({ employeeId, typeKey, halfDays: value });
    } catch {
      setNetworkError(SAVE_FAILED);
    }
  }

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className="flex flex-col gap-2 py-1"
      aria-busy={save.pending || undefined}
    >
      <FormField
        label={label}
        required
        hint={hint}
        error={error ?? save.formError ?? networkError ?? undefined}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            required
            className="numeric w-32"
          />
          <span className="text-footnote text-text-secondary">{unit}</span>
          <Button type="submit" variant="tinted" loading={save.pending}>
            Save
          </Button>
        </div>
      </FormField>
    </form>
  );
}

/** An opening already entered (or one this viewer can't enter), with the balance now. */
function OpeningValue({
  label,
  opening,
  balance,
}: {
  label: string;
  opening: string | null;
  balance: string;
}) {
  return (
    <dl className="flex flex-col gap-0.5 px-4 py-2.5">
      <dt className="text-footnote text-text-secondary">{label}</dt>
      <dd className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-subheadline">
        <span className={cn('numeric', opening ? 'font-medium' : 'text-text-secondary')}>
          {opening ?? 'Not entered'}
        </span>
        <span className="numeric text-footnote text-text-secondary">Balance now {balance}</span>
      </dd>
    </dl>
  );
}

// ---------------------------------------------------------------------------------------------
// Year-to-date pay

type PayrollState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'done';
      data: { section: PayrollOpeningSectionView; fields: PayrollOpeningFieldLabel[] } | null;
    };

/** Year-to-date pay at go-live for one employee, loaded on its own (masked, salary viewers only). */
export function usePayrollOpening(employeeId: string | null, session: number) {
  const [state, setState] = useState<PayrollState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  const key = employeeId ? `${employeeId}:${session}` : null;
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  if (key !== loadedFor) {
    setLoadedFor(key);
    setState({ status: 'loading' });
  }

  useEffect(() => {
    if (!employeeId) return;
    let current = true;
    getPayrollOpeningSectionAction(null, { employeeId })
      .then((result) => {
        if (!current) return;
        if (!result.ok) setState({ status: 'error', message: result.formError ?? LOAD_FAILED });
        else setState({ status: 'done', data: result.data });
      })
      .catch(() => {
        if (current) setState({ status: 'error', message: LOAD_FAILED });
      });
    return () => {
      current = false;
    };
  }, [employeeId, session, attempt]);

  return { state, reload: () => setAttempt((count) => count + 1) };
}

/** The loading and error states of a block that loads on its own. */
export function BlockStatus({
  state,
  what,
  onRetry,
}: {
  state: { status: 'loading' } | { status: 'error'; message: string };
  what: string;
  onRetry: () => void;
}) {
  if (state.status === 'loading') {
    return (
      <div role="status" className="flex flex-col gap-3 rounded-card bg-surface p-4 shadow-card">
        <span className="sr-only">Loading {what}…</span>
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  }
  return (
    <ErrorState
      variant="inline"
      headingLevel={3}
      title={`Couldn’t load ${what}`}
      description={state.message}
      action={
        <Button variant="tinted" onClick={onRetry}>
          <RotateCw aria-hidden="true" className="size-4.5" />
          Try again
        </Button>
      }
    />
  );
}

/** The seven figures, typed in pesos; a correction also takes the reason. */
function PayrollOpeningForm({
  employeeId,
  name,
  section,
  fields,
  onSaved,
  onBack,
}: {
  employeeId: string;
  name: string;
  section: PayrollOpeningSectionView;
  fields: readonly PayrollOpeningFieldLabel[];
  onSaved: (message: string) => void;
  onBack: () => void;
}) {
  const correcting = section.current !== null;
  const [networkError, setNetworkError] = useState<string | null>(null);
  const save = useActionSubmit(enterPayrollOpeningAction, () =>
    onSaved(correcting ? 'Year-to-date pay corrected.' : 'Year-to-date pay saved.'),
  );
  const errors: FieldErrors = save.fieldErrors;

  return (
    <form
      noValidate
      onSubmit={(event) => {
        setNetworkError(null);
        save.onSubmit(event).catch(() => setNetworkError(SAVE_FAILED));
      }}
      className="flex min-h-0 flex-1 flex-col"
      aria-busy={save.pending || undefined}
    >
      <SheetHeader
        title={correcting ? 'Correct year-to-date pay' : 'Enter year-to-date pay'}
        description={`${name} · as of ${section.goLiveDate ? formatDate(section.goLiveDate) : 'the go-live date'}`}
      />
      <SheetBody>
        <FormAlert
          message={save.formError ?? networkError ?? errors.employeeId ?? errors.supersedesId}
        />
        <input type="hidden" name="employeeId" value={employeeId} />
        <input type="hidden" name="supersedesId" value={section.current?.id ?? ''} />
        <FormSection
          title={`Year to date, ${section.year ?? ''}`}
          footer="In pesos, from January 1 to the go-live date, as the old payroll shows them. Enter 0 for none. The amounts are encrypted and shown masked."
        >
          {fields.map(({ field, label }) => (
            <FormField key={field} label={label} required error={errors[`${field}Centavos`]}>
              <PesoInput name={`${field}Centavos`} />
            </FormField>
          ))}
        </FormSection>
        {correcting ? (
          <FormSection
            title="Correction"
            footer="Type all seven figures again. The new entry replaces the latest one; both are kept."
          >
            <FormField label="Reason" required error={errors.reason}>
              <Textarea name="reason" maxLength={LEAVE_ENTRY_REASON_MAX_LENGTH} required />
            </FormField>
          </FormSection>
        ) : null}
      </SheetBody>
      <SheetFooter>
        <Button variant="secondary" onClick={onBack} disabled={save.pending}>
          Back
        </Button>
        <Button type="submit" loading={save.pending}>
          {correcting ? 'Save correction' : 'Save'}
        </Button>
      </SheetFooter>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// Correction

const OFFSET_TARGET = '__offset';

/**
 * "Add correction": signed days for a credited type or signed hours for offset, with a reason.
 * `onBack` returns to the sheet it came from; without it Cancel closes the sheet.
 */
export function CorrectionSheet({
  employeeId,
  name,
  leaveTypes,
  onSaved,
  onBack,
}: {
  employeeId: string;
  name: string;
  leaveTypes: readonly CorrectionLeaveType[];
  onSaved: (message: string) => void;
  onBack?: () => void;
}) {
  const [target, setTarget] = useState(leaveTypes[0]?.key ?? OFFSET_TARGET);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [networkError, setNetworkError] = useState<string | null>(null);
  const isOffset = target === OFFSET_TARGET;
  const type = leaveTypes.find((item) => item.key === target);
  const done = () =>
    onSaved(`Correction saved: ${isOffset ? 'offset' : (type?.shortName ?? 'leave')}.`);
  const leave = useActionSubmit(addLeaveCorrectionAction, done);
  const offset = useActionSubmit(addOffsetCorrectionAction, done);
  const save = isOffset ? offset : leave;
  const errors = save.fieldErrors;

  async function submit() {
    setNetworkError(null);
    try {
      const ok = isOffset
        ? await offset.run({ employeeId, minutes: amount, reason })
        : await leave.run({ employeeId, typeKey: target, halfDays: amount, reason });
      if (!ok) {
        requestAnimationFrame(() => {
          document
            .querySelector<HTMLElement>('[data-correction-form] [aria-invalid="true"]')
            ?.focus();
        });
      }
    } catch {
      setNetworkError(SAVE_FAILED);
    }
  }

  return (
    <form
      noValidate
      data-correction-form=""
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className="flex min-h-0 flex-1 flex-col"
      aria-busy={save.pending || undefined}
    >
      <SheetHeader title="Add correction" description={name} />
      <SheetBody>
        <FormAlert message={save.formError ?? networkError ?? errors.employeeId} />
        <FormSection footer="A correction is a dated entry with its reason, added to the balance. The balance itself is never edited.">
          <FormField label="Balance" required error={errors.typeKey}>
            <Select value={target} onChange={(event) => setTarget(event.target.value)}>
              {leaveTypes.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.name} ({item.shortName})
                </option>
              ))}
              <option value={OFFSET_TARGET}>Offset</option>
            </Select>
          </FormField>
          <FormField
            label={isOffset ? 'Hours' : 'Days'}
            required
            hint={
              isOffset
                ? 'Up to two decimals, like 1.25. Use a minus sign to take hours away, like -2.'
                : 'Whole or half days, like 1 or 0.5. Use a minus sign to take days away, like -1.5.'
            }
            error={errors[isOffset ? 'minutes' : 'halfDays']}
          >
            <Input
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              inputMode="text"
              autoComplete="off"
              spellCheck={false}
              required
              className="numeric sm:max-w-40"
            />
          </FormField>
          <FormField label="Reason" required error={errors.reason}>
            <Textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={LEAVE_ENTRY_REASON_MAX_LENGTH}
              required
            />
          </FormField>
        </FormSection>
      </SheetBody>
      <SheetFooter>
        {onBack ? (
          <Button variant="secondary" onClick={onBack} disabled={save.pending}>
            Back
          </Button>
        ) : (
          <SheetClose asChild>
            <Button variant="secondary">Cancel</Button>
          </SheetClose>
        )}
        <Button type="submit" loading={save.pending}>
          Save correction
        </Button>
      </SheetFooter>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// One employee

type Mode = 'overview' | 'correction' | 'payroll';

export function EmployeeOpeningSheet({
  row,
  view,
  onChanged,
}: {
  row: OpeningBalanceRow;
  view: OpeningBalancesView;
  /** After a save: the server data behind the page is refreshed. */
  onChanged: () => void;
}) {
  const [mode, setMode] = useState<Mode>('overview');
  const [saved, setSaved] = useState<string | null>(null);
  const [payrollSession, setPayrollSession] = useState(0);
  const payroll = usePayrollOpening(
    row.canEnterPayrollOpening ? row.employeeId : null,
    payrollSession,
  );
  const goLive = view.goLiveDate ? formatDate(view.goLiveDate) : null;

  function changed(message: string) {
    setSaved(message);
    setMode('overview');
    onChanged();
  }

  if (mode === 'correction') {
    return (
      <CorrectionSheet
        employeeId={row.employeeId}
        name={row.name}
        leaveTypes={view.leaveTypes}
        onSaved={changed}
        onBack={() => setMode('overview')}
      />
    );
  }
  if (mode === 'payroll' && payroll.state.status === 'done' && payroll.state.data) {
    return (
      <PayrollOpeningForm
        employeeId={row.employeeId}
        name={row.name}
        section={payroll.state.data.section}
        fields={payroll.state.data.fields}
        onBack={() => setMode('overview')}
        onSaved={(message) => {
          setPayrollSession((count) => count + 1);
          changed(message);
        }}
      />
    );
  }

  let payrollBlock: ReactNode;
  if (!row.canEnterPayrollOpening) {
    payrollBlock = (
      <div className="flex flex-col gap-2">
        <h3 className="px-4 text-footnote font-semibold text-text-secondary">
          Year-to-date pay at go-live
        </h3>
        <div className="flex flex-col gap-1 rounded-card bg-surface px-4 py-3 shadow-card">
          <Badge tone={row.payrollOpening === 'entered' ? 'accent' : 'neutral'}>
            {row.payrollOpening === 'entered' ? 'Entered' : 'Not entered'}
          </Badge>
          <p className="text-footnote text-text-secondary">
            You can’t enter this employee’s year-to-date pay. For someone in HR, the System
            Administrator or a Board member enters it, and nobody enters their own.
          </p>
        </div>
      </div>
    );
  } else if (payroll.state.status !== 'done') {
    payrollBlock = (
      <BlockStatus state={payroll.state} what="year-to-date pay" onRetry={payroll.reload} />
    );
  } else if (payroll.state.data) {
    const { section, fields } = payroll.state.data;
    payrollBlock = (
      <PayrollOpeningCards
        section={section}
        fields={fields}
        action={
          section.canEnter ? (
            <Button variant="plain" onClick={() => setMode('payroll')}>
              {section.current ? (
                <Pencil aria-hidden="true" className="size-4.5" />
              ) : (
                <Plus aria-hidden="true" className="size-4.5" />
              )}
              {section.current ? 'Correct' : 'Enter'}
            </Button>
          ) : null
        }
      />
    );
  } else {
    payrollBlock = null;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SheetHeader
        title={row.name}
        description={`${row.employeeNumber} · Hired ${formatDate(row.dateHired)}${row.department ? ` · ${row.department}` : ''}`}
      />
      <SheetBody>
        <SavedLine message={saved} />
        <FormSection
          title={goLive ? `Opening balances as of ${goLive}` : 'Opening balances'}
          footer="Each is entered once, dated the go-live date. Fix a mistake with a correction."
        >
          {row.leave.map((cell) => {
            const type = view.leaveTypes.find((item) => item.key === cell.typeKey);
            const label = `${type?.name ?? cell.shortName} (${cell.shortName})`;
            return cell.openingHalfDays === null && row.canEnter ? (
              <OpeningField
                key={cell.typeKey}
                employeeId={row.employeeId}
                label={label}
                hint={`Whole or half days, from 0 to ${LEAVE_OPENING_DAYS_MAX}.`}
                unit="days"
                typeKey={cell.typeKey}
                onSaved={() => changed(`${cell.shortName} opening balance saved.`)}
              />
            ) : (
              <OpeningValue
                key={cell.typeKey}
                label={label}
                opening={
                  cell.openingHalfDays === null ? null : formatLeaveDays(cell.openingHalfDays)
                }
                balance={formatLeaveDays(cell.balanceHalfDays)}
              />
            );
          })}
          {row.offset.openingMinutes === null && row.canEnter ? (
            <OpeningField
              employeeId={row.employeeId}
              label="Offset"
              hint="Hours with up to two decimals, like 12.5. 0 or more."
              unit="hours"
              typeKey={null}
              onSaved={() => changed('Offset opening balance saved.')}
            />
          ) : (
            <OpeningValue
              label="Offset"
              opening={
                row.offset.openingMinutes === null
                  ? null
                  : formatOffsetHours(row.offset.openingMinutes)
              }
              balance={formatOffsetHours(row.offset.balanceMinutes)}
            />
          )}
        </FormSection>
        {row.canEnter ? (
          <div className="px-1">
            <Button variant="tinted" onClick={() => setMode('correction')}>
              <Plus aria-hidden="true" className="size-4.5" />
              Add correction
            </Button>
          </div>
        ) : (
          <p className="px-4 text-footnote text-text-secondary">
            You can’t enter opening balances or corrections on your own record. Ask HR to enter
            them.
          </p>
        )}
        {payrollBlock}
      </SheetBody>
      <SheetFooter>
        <SheetClose asChild>
          <Button variant="secondary">Done</Button>
        </SheetClose>
      </SheetFooter>
    </div>
  );
}
