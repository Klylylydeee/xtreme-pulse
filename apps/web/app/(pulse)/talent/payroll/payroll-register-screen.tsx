'use client';

import { useId, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Eye, Landmark, ShieldCheck } from 'lucide-react';
import { formatDate } from '@pulse/core';
import type {
  PayrollRegisterGroup,
  PayrollRegisterRow,
  PayrollRegisterView,
} from '@pulse/talent/server';
import { Button, buttonVariants } from '@pulse/ui/components/button';
import {
  createDataTableColumns,
  DataTable,
  type DataTableColumn,
} from '@pulse/ui/components/data-table';
import { EmptyState } from '@pulse/ui/components/empty-state';
import { PageHeader } from '@pulse/ui/components/page-header';
import { FormAlert } from '@/components/form-alert';
import { plural } from '@/components/org-structure';
import { showPayrollRegisterAction } from '@/lib/actions/talent-payroll-runs';
import { PAYROLL_HREF } from '@/lib/navigation';
import { pesoText } from './payroll-format';

// Spec: docs/modules/talent.md#payroll-review-approval-and-payslips-build-step-210 ("The payroll
// register", "Screens": `/talent/payroll/<runId>/register`) and
// docs/DESIGN_SYSTEM.md#layout--components ("Payroll review and payslips on a phone": a list
// grouped by bank on a phone and a data table on a desktop, counts first, then after "Show
// register" each person's bank, account name, account number and net pay in tabular numerals, with
// each bank's total) — a finalized run's register.
//
// - Before "Show register": the bank groups (UnionBank, RCBC, then "No bank account on file") with
//   their counts, and the note "Viewing account numbers is recorded in the audit log."
// - "Show register" calls the reveal action (a `reveal` on the run, field `register`, is written
//   first) and holds what it answers in this component's state only: a reload hides it again.
// - A run not finalized shows the server's "The register is available once the run is finalized."
// Exports (PDF, Excel, a bank upload file) are step 2.16's.

const SHOW_FAILED = 'The register couldn’t load. Check your connection and try again.';
const GONE = 'This payroll run no longer exists. Reload the page.';

function PhoneRegisterRow({ row }: { row: PayrollRegisterRow }) {
  return (
    <span className="flex min-w-0 flex-1 items-start justify-between gap-3">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-subheadline font-semibold break-words">{row.name}</span>
        <span className="text-footnote text-text-secondary numeric">{row.employeeNumber}</span>
        {row.accountNumber ? (
          <>
            <span className="text-footnote break-words text-text-secondary">
              {[row.bankLabel, row.accountName].filter(Boolean).join(' · ')}
            </span>
            <span className="text-subheadline break-all numeric">{row.accountNumber}</span>
          </>
        ) : (
          <span className="text-footnote text-text-secondary">Paid by other means</span>
        )}
      </span>
      <span className="shrink-0 text-right text-subheadline font-semibold numeric">
        {pesoText(row.netPayCentavos)}
      </span>
    </span>
  );
}

function GroupTable({ group }: { group: PayrollRegisterGroup }) {
  const titleId = useId();
  const columns = useMemo((): DataTableColumn<PayrollRegisterRow>[] => {
    const column = createDataTableColumns<PayrollRegisterRow>();
    return column.columns([
      column.accessor('name', {
        header: 'Name',
        sortFn: 'text',
        cell: (info) => (
          <span className="flex min-w-40 flex-col gap-0.5 py-1">
            <span className="font-medium">{info.row.original.name}</span>
            <span className="numeric text-footnote text-text-secondary">
              {info.row.original.employeeNumber}
            </span>
          </span>
        ),
      }),
      column.accessor((row) => row.bankLabel ?? '', {
        id: 'bank',
        header: 'Bank',
        sortFn: 'text',
        cell: (info) => info.getValue() || '—',
        meta: { width: '8rem' },
      }),
      column.accessor((row) => row.accountName ?? '', {
        id: 'accountName',
        header: 'Account name',
        sortFn: 'text',
        cell: (info) => info.getValue() || '—',
      }),
      column.accessor((row) => row.accountNumber ?? '', {
        id: 'accountNumber',
        header: 'Account number',
        sortFn: 'text',
        cell: (info) => <span className="numeric">{info.getValue() || '—'}</span>,
      }),
      column.accessor('netPayCentavos', {
        header: 'Net pay',
        sortFn: 'basic',
        cell: (info) => pesoText(info.getValue()),
        meta: { align: 'end' as const, width: '9rem' },
      }),
    ]);
  }, []);
  return (
    <section aria-labelledby={titleId} className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-4">
        <h2 id={titleId} className="text-headline">
          {group.label}
        </h2>
        <p className="text-footnote text-text-secondary numeric">
          {plural(group.count, 'employee', 'employees')}
          {group.totalNetPayCentavos !== null ? ` · ${pesoText(group.totalNetPayCentavos)}` : ''}
        </p>
      </div>
      <DataTable
        caption={`${group.label}: the employees paid there`}
        captionHidden
        columns={columns}
        data={group.rows}
        getRowId={(row) => row.lineId}
        renderPhoneRow={(row) => <PhoneRegisterRow row={row} />}
      />
    </section>
  );
}

export function PayrollRegisterScreen({ view }: { view: PayrollRegisterView }) {
  const [shown, setShown] = useState<PayrollRegisterView | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const countsId = useId();

  async function show() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await showPayrollRegisterAction(null, { runId: view.runId });
      if (!result.ok) setError(result.formError ?? result.fieldErrors.runId ?? SHOW_FAILED);
      else if (!result.data) setError(GONE);
      else if (!result.data.shown) setError(result.data.unavailableMessage ?? SHOW_FAILED);
      else setShown(result.data);
    } catch {
      setError(SHOW_FAILED);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  const groups = shown?.groups ?? view.groups;
  return (
    <>
      <div className="flex flex-col gap-3">
        <Link
          href={`${PAYROLL_HREF}/${view.runId}`}
          className={buttonVariants({ variant: 'plain', className: '-ml-3 w-fit text-accent' })}
        >
          <ArrowLeft aria-hidden="true" className="size-4.5" />
          Payroll run
        </Link>
        <PageHeader
          title="Payroll register"
          description={
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1 numeric">
              <span>{view.periodText}</span>
              <span aria-hidden="true">·</span>
              <span>{view.runNumber}</span>
              <span aria-hidden="true">·</span>
              <span>Paid {formatDate(view.payDate)}</span>
            </span>
          }
        />
      </div>

      {!view.available ? (
        <EmptyState
          icon={<Landmark strokeWidth={1.75} />}
          title="Not available yet"
          description={view.unavailableMessage ?? undefined}
          action={
            <Link
              href={`${PAYROLL_HREF}/${view.runId}`}
              className={buttonVariants({ variant: 'tinted' })}
            >
              Open the run
            </Link>
          }
        />
      ) : (
        <>
          <section aria-labelledby={countsId} className="flex flex-col gap-2">
            <h2 id={countsId} className="sr-only">
              Employees by bank
            </h2>
            <ul className="grid grid-cols-2 gap-3 xl:grid-cols-4">
              {groups.map((group) => (
                <li
                  key={group.key}
                  className="flex min-w-0 flex-col gap-1 rounded-card bg-surface p-4 shadow-card md:p-5"
                >
                  <span className="text-subheadline font-semibold break-words text-text-secondary">
                    {group.label}
                  </span>
                  <span className="numeric text-display">{group.count}</span>
                  {group.totalNetPayCentavos !== null ? (
                    <span className="text-footnote text-text-secondary numeric">
                      {pesoText(group.totalNetPayCentavos)}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>

          {shown ? (
            <>
              {shown.groups.map((group) => (
                <GroupTable key={group.key} group={group} />
              ))}
              {shown.totalNetPayCentavos !== null ? (
                <dl className="flex min-h-11 items-center justify-between gap-4 rounded-card bg-surface px-4 py-2.5 shadow-card">
                  <dt className="text-subheadline font-semibold">Total net pay</dt>
                  <dd className="shrink-0 text-right text-subheadline font-semibold numeric">
                    {pesoText(shown.totalNetPayCentavos)}
                  </dd>
                </dl>
              ) : null}
            </>
          ) : (
            <div className="flex flex-col gap-2 rounded-card bg-surface px-4 py-3 shadow-card sm:flex-row sm:items-center sm:justify-between">
              <p className="flex items-start gap-2 text-footnote text-text-secondary">
                <ShieldCheck aria-hidden="true" className="mt-px size-4 shrink-0" />
                <span>Account numbers and net pay are hidden. {view.revealNote}</span>
              </p>
              <Button
                variant="secondary"
                onClick={() => void show()}
                loading={pending}
                className="w-full sm:w-auto"
              >
                <Eye aria-hidden="true" className="size-4.5" />
                Show register
              </Button>
            </div>
          )}
          <FormAlert message={error} />
        </>
      )}
    </>
  );
}
