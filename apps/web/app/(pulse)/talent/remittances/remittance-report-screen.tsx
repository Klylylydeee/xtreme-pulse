'use client';

import { type ReactNode, useId, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Ban,
  Eye,
  FileDown,
  FileSpreadsheet,
  FileText,
  Info,
  Landmark,
  PencilLine,
  Plus,
  RotateCw,
  ShieldCheck,
  TriangleAlert,
  Upload,
} from 'lucide-react';
import { type Centavos, formatDate, formatDateTime, formatPeso } from '@pulse/core';
import {
  REMITTANCE_DIFFERS_LABEL,
  REMITTANCE_MISSING_ID_TILE_LABEL,
  type RemittanceAgency,
  type RemittanceExportFormat,
} from '@pulse/talent';
import type {
  RemittanceAmountRow,
  RemittanceAmountsView,
  RemittancePaymentEntryView,
  RemittanceReportPageView,
} from '@pulse/talent/server';
import { cn } from '@pulse/ui';
import { Button, buttonVariants } from '@pulse/ui/components/button';
import {
  createDataTableColumns,
  DataTable,
  type DataTableColumn,
} from '@pulse/ui/components/data-table';
import { EmptyState } from '@pulse/ui/components/empty-state';
import { PageHeader } from '@pulse/ui/components/page-header';
import {
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetFooter,
  SheetHeader,
} from '@pulse/ui/components/sheet';
import { useReturnFocus } from '@pulse/ui/hooks/use-return-focus';
import { FormAlert } from '@/components/form-alert';
import { plural, useActionSubmit } from '@/components/org-structure';
import {
  exportRemittanceReportAction,
  generateRemittanceReportAction,
  showRemittanceAmountsAction,
} from '@/lib/actions/talent-remittances';
import { REMITTANCES_HREF } from '@/lib/navigation';
import { RemittanceStatusBadges } from './remittance-badges';
import { PaymentSheet, VoidPaymentSheet } from './remittance-payment-sheets';

// Spec: docs/modules/talent.md#employer-contributions-and-remittances-build-step-211 ("Screens":
// `/talent/remittances/<YYYY-MM>/<agency>`, "Reports", "Exports", "Payments") and
// docs/DESIGN_SYSTEM.md#layout--components ("Remittances on a phone") — one agency's month.
//
// - The large title ("SSS · October 2026"), the status and due date, the source runs as links, the
//   go-live note and the placeholder warning in callouts; a month not complete names the cut-off
//   still to finalize. "Generate report" (or "Regenerate", while not paid) for HR.
// - Tiles (Employees, "Differs from the schedule", "Missing or unverified ID"), each a filter of
//   the people once shown. Amounts are hidden behind one secondary button, "Show amounts" ("Viewing
//   amounts is recorded in the audit log."); they are held in this component's state only, for the
//   report version they belong to: a reload hides them again. The rows show the ID's last 4 digits.
// - Exports: three secondary buttons that wrap on a phone; the upload sheet warns in
//   `warning-text` while the layout isn't verified. Each downloads in the same tab.
// - The payment section: "Record payment", or the live payment with "Correct" and "Void", the
//   history and the Fiscal placeholder line.

const SHOW_FAILED = 'The amounts couldn’t load. Check your connection and try again.';
const EXPORT_FAILED = 'The file couldn’t be prepared. Check your connection and try again.';
const GENERATE_FAILED = 'The report wasn’t generated. Check your connection and try again.';

type Filter = 'all' | 'differs' | 'missingId';

const ENTRY_LABELS: Record<RemittancePaymentEntryView['kind'], string> = {
  payment: 'Payment',
  correction: 'Correction',
  void: 'Void',
};

function Callout({ tone, children }: { tone: 'warning' | 'neutral'; children: ReactNode }) {
  return (
    <p
      className={cn(
        'flex items-start gap-2 rounded-card bg-surface px-4 py-3 text-footnote shadow-card',
        tone === 'warning' ? 'font-medium text-warning-text' : 'text-text-secondary',
      )}
    >
      {tone === 'warning' ? (
        <TriangleAlert aria-hidden="true" className="mt-px size-4 shrink-0" strokeWidth={2} />
      ) : (
        <Info aria-hidden="true" className="mt-px size-4 shrink-0" />
      )}
      <span>{children}</span>
    </p>
  );
}

function Tile({
  label,
  count,
  pressed,
  onPress,
}: {
  label: string;
  count: number;
  pressed: boolean;
  onPress: (() => void) | null;
}) {
  const body = (
    <>
      <span className="text-subheadline font-semibold break-words text-text-secondary">
        {label}
      </span>
      <span className="numeric text-display">{count}</span>
    </>
  );
  const className =
    'flex min-h-11 min-w-0 flex-col items-start gap-1 rounded-card bg-surface p-4 text-left shadow-card md:p-5';
  return onPress ? (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onPress}
      className={cn(className, 'transition-colors duration-fast hover:bg-accent-subtle/40', {
        'ring-2 ring-accent': pressed,
      })}
    >
      {body}
    </button>
  ) : (
    <div className={className}>{body}</div>
  );
}

function AmountList({ rows }: { rows: { label: string; amount: Centavos; strong?: boolean }[] }) {
  return (
    <dl className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
      {rows.map((row) => (
        <div
          key={row.label}
          className="flex min-h-11 items-center justify-between gap-4 px-4 py-2.5"
        >
          <dt className={cn('text-subheadline', row.strong && 'font-semibold')}>{row.label}</dt>
          <dd
            className={cn(
              'shrink-0 text-right text-subheadline numeric',
              row.strong && 'font-semibold',
            )}
          >
            {formatPeso(row.amount)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The month's totals, per agency. */
function Totals({ agency, amounts }: { agency: RemittanceAgency; amounts: RemittanceAmountsView }) {
  const t = amounts.totals;
  if (agency === 'bir1601c') {
    return (
      <AmountList
        rows={amounts.birItems.map((item) => ({
          label: `${item.item} ${item.description}`,
          amount: item.amountCentavos,
          strong: item.item === '25',
        }))}
      />
    );
  }
  const rows =
    agency === 'sss'
      ? [
          { label: 'Employee share, regular SS', amount: t.employee.regularCentavos },
          { label: 'Employee share, MPF', amount: t.employee.mpfCentavos },
          { label: 'Employer share, regular SS', amount: t.employer.regularCentavos },
          { label: 'Employer share, MPF', amount: t.employer.mpfCentavos },
          { label: 'EC', amount: t.ecCentavos },
        ]
      : [
          {
            label: agency === 'philhealth' ? 'PS (employees)' : 'Employee share',
            amount: t.employee.totalCentavos,
          },
          {
            label: agency === 'philhealth' ? 'ES (employer)' : 'Employer share',
            amount: t.employer.totalCentavos,
          },
        ];
  return (
    <AmountList
      rows={[...rows, { label: 'Amount due', amount: t.amountDueCentavos, strong: true }]}
    />
  );
}

function rowAmounts(agency: RemittanceAgency, row: RemittanceAmountRow) {
  if (agency === 'bir1601c') {
    return [
      { label: 'Compensation', amount: row.bir?.totalCompensationCentavos ?? 0 },
      { label: 'Taxable', amount: row.bir?.taxableCentavos ?? 0 },
      { label: 'Tax withheld', amount: row.totalCentavos },
    ];
  }
  return [
    { label: agency === 'sss' ? 'Salary credit' : 'Basis', amount: row.basisCentavos },
    { label: 'Employee', amount: row.employee.totalCentavos },
    { label: 'Employer', amount: row.employer.totalCentavos },
    ...(agency === 'sss' ? [{ label: 'EC', amount: row.ecCentavos }] : []),
    { label: 'Total', amount: row.totalCentavos },
  ];
}

function PhonePersonRow({ agency, row }: { agency: RemittanceAgency; row: RemittanceAmountRow }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="text-subheadline font-semibold break-words">{row.name}</span>
      <span className="text-footnote text-text-secondary numeric">
        {row.employeeNumber} · {row.maskedId ?? 'No ID on file'}
      </span>
      {row.notes.length > 0 ? (
        <span className="text-footnote font-medium break-words text-warning-text">
          {row.notes.join(' · ')}
        </span>
      ) : null}
      <span className="grid grid-cols-2 gap-x-4 gap-y-0.5">
        {rowAmounts(agency, row).map((cell) => (
          <span key={cell.label} className="contents">
            <span className="text-footnote text-text-secondary">{cell.label}</span>
            <span className="text-right text-footnote numeric">{formatPeso(cell.amount)}</span>
          </span>
        ))}
      </span>
    </span>
  );
}

function PeopleTable({ agency, rows }: { agency: RemittanceAgency; rows: RemittanceAmountRow[] }) {
  const columns = useMemo((): DataTableColumn<RemittanceAmountRow>[] => {
    const column = createDataTableColumns<RemittanceAmountRow>();
    const sample = rows[0];
    const amountColumns = sample
      ? rowAmounts(agency, sample).map((cell, index) =>
          column.accessor((row) => rowAmounts(agency, row)[index]?.amount ?? 0, {
            id: `amount-${index}`,
            header: cell.label,
            sortFn: 'basic',
            cell: (info) => formatPeso(info.getValue()),
            meta: { align: 'end' as const, width: '8rem' },
          }),
        )
      : [];
    return column.columns([
      column.accessor('name', {
        header: 'Name',
        sortFn: 'text',
        cell: (info) => (
          <span className="flex min-w-40 flex-col gap-0.5 py-1">
            <span className="font-medium">{info.row.original.name}</span>
            <span className="numeric text-footnote text-text-secondary">
              {info.row.original.employeeNumber} · {info.row.original.maskedId ?? 'No ID on file'}
            </span>
            {info.row.original.notes.length > 0 ? (
              <span className="text-footnote font-medium text-warning-text">
                {info.row.original.notes.join(' · ')}
              </span>
            ) : null}
          </span>
        ),
      }),
      ...amountColumns,
    ]);
  }, [agency, rows]);
  return (
    <DataTable
      caption="The people in the report and their amounts"
      captionHidden
      columns={columns}
      data={rows}
      getRowId={(row) => row.employeeId}
      renderPhoneRow={(row) => <PhonePersonRow agency={agency} row={row} />}
      empty={
        <EmptyState
          icon={<Landmark strokeWidth={1.75} />}
          title="No one matches this filter"
          description="Choose the Employees tile to see everyone again."
          variant="inline"
        />
      }
    />
  );
}

function PaymentEntry({
  entry,
  amount,
}: {
  entry: RemittancePaymentEntryView;
  amount: Centavos | null;
}) {
  return (
    <li className="flex flex-col gap-0.5 px-4 py-3">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-subheadline font-semibold">{ENTRY_LABELS[entry.kind]}</span>
        <span className="text-footnote text-text-secondary numeric">
          {formatDateTime(new Date(entry.recordedAt))}
          {entry.recordedByName ? ` · ${entry.recordedByName}` : ''}
        </span>
      </span>
      {entry.kind === 'void' ? null : (
        <span className="text-footnote break-words numeric">
          Paid {formatDate(entry.paidOn)} · {entry.referenceNumber}
          {amount !== null ? ` · ${formatPeso(amount)}` : ''}
        </span>
      )}
      {entry.reason ? (
        <span className="text-footnote break-words text-text-secondary">
          Reason: {entry.reason}
        </span>
      ) : null}
      {entry.note ? (
        <span className="text-footnote break-words text-text-secondary">Note: {entry.note}</span>
      ) : null}
    </li>
  );
}

type OpenSheet =
  | { kind: 'record' }
  | { kind: 'correct' }
  | { kind: 'void' }
  | { kind: 'upload' }
  | { kind: 'generate' }
  | null;

export function RemittanceReportScreen({ view }: { view: RemittanceReportPageView }) {
  const router = useRouter();
  const tilesId = useId();
  const [amounts, setAmounts] = useState<RemittanceAmountsView | null>(null);
  const [showing, setShowing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<RemittanceExportFormat | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [sheet, setSheet] = useState<OpenSheet>(null);
  const [session, setSession] = useState(0);
  const focus = useReturnFocus();
  const busy = useRef(false);
  const report = view.report;
  const shown = amounts && report && amounts.version === report.version ? amounts : null;
  const paymentAmount = (id: string) =>
    shown?.payments.find((payment) => payment.id === id)?.amountCentavos ?? null;

  function open(next: NonNullable<OpenSheet>, trigger: HTMLElement) {
    focus.remember(trigger);
    setSession((count) => count + 1);
    setSheet(next);
  }

  async function show() {
    if (busy.current) return;
    busy.current = true;
    setShowing(true);
    setError(null);
    try {
      const result = await showRemittanceAmountsAction(null, {
        agency: view.agency,
        month: view.month,
      });
      if (!result.ok) setError(result.formError ?? SHOW_FAILED);
      else if (!result.data) router.refresh();
      else setAmounts(result.data);
    } catch {
      setError(SHOW_FAILED);
    } finally {
      busy.current = false;
      setShowing(false);
    }
  }

  async function download(format: RemittanceExportFormat): Promise<string | null> {
    if (!report) return null;
    setExporting(format);
    setError(null);
    try {
      const result = await exportRemittanceReportAction(null, {
        agency: view.agency,
        month: view.month,
        format,
        version: report.version,
      });
      if (!result.ok) return result.formError ?? EXPORT_FAILED;
      window.location.assign(result.data.href);
      return null;
    } catch {
      return EXPORT_FAILED;
    } finally {
      setExporting(null);
    }
  }

  const people = (shown?.rows ?? []).filter((row) =>
    filter === 'differs'
      ? row.flags.differsFromSchedule
      : filter === 'missingId'
        ? row.flags.missingId || row.flags.unverifiedId
        : true,
  );
  const toggle = (next: Filter) => () => setFilter((current) => (current === next ? 'all' : next));
  const canRegenerate = view.canGenerate && report !== null && view.status === 'generated';
  const canGenerateNow = view.canGenerate && view.status === 'ready';

  return (
    <>
      <div className="flex flex-col gap-3">
        <Link
          href={REMITTANCES_HREF}
          className={buttonVariants({ variant: 'plain', className: '-ml-3 w-fit text-accent' })}
        >
          <ArrowLeft aria-hidden="true" className="size-4.5" />
          Remittances
        </Link>
        <PageHeader
          title={view.title}
          description={
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1 numeric">
              <RemittanceStatusBadges
                status={view.status}
                label={view.statusLabel}
                overdue={view.overdue}
              />
              <span>{view.dueText}</span>
            </span>
          }
          actions={
            canGenerateNow ? (
              <Button onClick={(event) => open({ kind: 'generate' }, event.currentTarget)}>
                <Plus aria-hidden="true" className="size-4.5" />
                Generate report
              </Button>
            ) : null
          }
        />
      </div>

      {view.incompleteMessage ? <Callout tone="neutral">{view.incompleteMessage}</Callout> : null}
      {view.goLiveNote ? <Callout tone="neutral">{view.goLiveNote}</Callout> : null}
      {report?.placeholderWarning ? (
        <Callout tone="warning">{report.placeholderWarning}</Callout>
      ) : null}

      {view.sourceRuns.length > 0 ? (
        <section aria-label="Source runs" className="flex flex-col gap-2">
          <h2 className="px-4 text-footnote font-semibold text-text-secondary">Payroll runs</h2>
          <ul className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
            {view.sourceRuns.map((run) => (
              <li key={run.runId}>
                <Link
                  href={run.href}
                  className="flex min-h-11 items-center justify-between gap-3 px-4 py-2.5 text-subheadline text-accent hover:bg-accent-subtle/40"
                >
                  <span className="numeric">{run.periodText}</span>
                  <span className="text-footnote text-text-secondary numeric">{run.number}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {report ? (
        <>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-footnote text-text-secondary numeric">
              Generated {formatDateTime(new Date(report.generatedAt))}
              {report.generatedByName ? ` by ${report.generatedByName}` : ''} · version{' '}
              {report.version}
            </p>
            {canRegenerate ? (
              <Button
                variant="secondary"
                className="w-full sm:w-auto"
                onClick={(event) => open({ kind: 'generate' }, event.currentTarget)}
              >
                <RotateCw aria-hidden="true" className="size-4.5" />
                Regenerate
              </Button>
            ) : null}
          </div>

          <section aria-labelledby={tilesId} className="flex flex-col gap-2">
            <h2 id={tilesId} className="sr-only">
              Counts
            </h2>
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
              <Tile
                label="Employees"
                count={report.employeeCount}
                pressed={filter === 'all' && shown !== null}
                onPress={shown ? () => setFilter('all') : null}
              />
              <Tile
                label={REMITTANCE_DIFFERS_LABEL}
                count={report.flagCounts.differsFromSchedule}
                pressed={filter === 'differs'}
                onPress={shown ? toggle('differs') : null}
              />
              <Tile
                label={REMITTANCE_MISSING_ID_TILE_LABEL}
                count={report.flagCounts.missingId + report.flagCounts.unverifiedId}
                pressed={filter === 'missingId'}
                onPress={shown ? toggle('missingId') : null}
              />
            </div>
          </section>

          {shown ? (
            <>
              <section aria-label="Totals" className="flex flex-col gap-2">
                <h2 className="px-4 text-footnote font-semibold text-text-secondary">
                  {view.agency === 'bir1601c' ? 'BIR Form 1601-C items' : 'Totals'}
                </h2>
                <Totals agency={view.agency} amounts={shown} />
                {shown.item22Difference ? (
                  <Callout tone="warning">{shown.item22Difference}</Callout>
                ) : null}
              </section>
              <section aria-label="People" className="flex flex-col gap-2">
                <h2 className="px-4 text-footnote font-semibold text-text-secondary">
                  {plural(people.length, 'person', 'people')}
                </h2>
                <PeopleTable agency={view.agency} rows={people} />
              </section>
            </>
          ) : (
            <div className="flex flex-col gap-2 rounded-card bg-surface px-4 py-3 shadow-card sm:flex-row sm:items-center sm:justify-between">
              <p className="flex items-start gap-2 text-footnote text-text-secondary">
                <ShieldCheck aria-hidden="true" className="mt-px size-4 shrink-0" />
                <span>Amounts and ID numbers are hidden. {view.revealNote}</span>
              </p>
              <Button
                variant="secondary"
                onClick={() => void show()}
                loading={showing}
                className="w-full sm:w-auto"
              >
                <Eye aria-hidden="true" className="size-4.5" />
                Show amounts
              </Button>
            </div>
          )}

          <section aria-label="Exports" className="flex flex-col gap-2">
            <h2 className="px-4 text-footnote font-semibold text-text-secondary">Exports</h2>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                loading={exporting === 'pdf'}
                onClick={() => void download('pdf').then((message) => setError(message))}
              >
                <FileText aria-hidden="true" className="size-4.5" />
                PDF
              </Button>
              <Button
                variant="secondary"
                loading={exporting === 'xlsx'}
                onClick={() => void download('xlsx').then((message) => setError(message))}
              >
                <FileSpreadsheet aria-hidden="true" className="size-4.5" />
                Excel
              </Button>
              {report.upload ? (
                <Button
                  variant="secondary"
                  onClick={(event) => open({ kind: 'upload' }, event.currentTarget)}
                >
                  <Upload aria-hidden="true" className="size-4.5" />
                  {report.upload.buttonLabel}
                </Button>
              ) : null}
            </div>
            {report.noUploadText ? (
              <p className="px-4 text-footnote text-text-secondary">{report.noUploadText}</p>
            ) : null}
          </section>
        </>
      ) : null}

      <FormAlert message={error} />

      {report ? (
        <section aria-label="Payment" className="flex flex-col gap-2">
          <h2 className="px-4 text-footnote font-semibold text-text-secondary">Payment</h2>
          {view.livePayment ? (
            <div className="flex flex-col gap-3 rounded-card bg-surface px-4 py-3 shadow-card">
              <p className="text-subheadline font-semibold numeric">
                Paid {formatDate(view.livePayment.paidOn)} · {view.livePayment.referenceNumber}
                {paymentAmount(view.livePayment.id) !== null
                  ? ` · ${formatPeso(paymentAmount(view.livePayment.id) ?? 0)}`
                  : ''}
              </p>
              {view.canRecordPayment ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    onClick={(event) => open({ kind: 'correct' }, event.currentTarget)}
                  >
                    <PencilLine aria-hidden="true" className="size-4.5" />
                    Correct
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={(event) => open({ kind: 'void' }, event.currentTarget)}
                  >
                    <Ban aria-hidden="true" className="size-4.5" />
                    Void
                  </Button>
                </div>
              ) : null}
            </div>
          ) : view.canRecordPayment && view.status === 'generated' ? (
            <div className="flex flex-col gap-2 rounded-card bg-surface px-4 py-3 shadow-card sm:flex-row sm:items-center sm:justify-between">
              <p className="text-footnote text-text-secondary">Not paid yet.</p>
              <Button
                onClick={(event) => open({ kind: 'record' }, event.currentTarget)}
                className="w-full sm:w-auto"
              >
                Record payment
              </Button>
            </div>
          ) : (
            <p className="px-4 text-footnote text-text-secondary">Not paid yet.</p>
          )}
          {view.paymentHistory.length > 0 ? (
            <ul className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
              {view.paymentHistory.map((entry) => (
                <PaymentEntry key={entry.id} entry={entry} amount={paymentAmount(entry.id)} />
              ))}
            </ul>
          ) : null}
          <p className="px-4 text-footnote text-text-secondary">{view.fiscalPlaceholderText}</p>
        </section>
      ) : null}

      <Sheet open={sheet !== null} onOpenChange={(next) => (next ? null : setSheet(null))}>
        <SheetContent aria-describedby={undefined} onCloseAutoFocus={focus.onCloseAutoFocus}>
          {sheet?.kind === 'generate' ? (
            <GenerateSheet
              key={session}
              view={view}
              onDone={() => {
                setSheet(null);
                setAmounts(null);
                router.refresh();
              }}
            />
          ) : null}
          {sheet?.kind === 'upload' && report?.upload ? (
            <UploadSheet
              key={session}
              warning={report.upload.warning}
              refusal={report.upload.refusal}
              formatLabel={report.upload.formatLabel}
              onDownload={() => download('upload')}
            />
          ) : null}
          {(sheet?.kind === 'record' || sheet?.kind === 'correct') && report ? (
            <PaymentSheet
              key={session}
              agency={view.agency}
              month={view.month}
              version={report.version}
              correctingId={sheet.kind === 'correct' ? (view.livePayment?.id ?? null) : null}
              defaults={
                sheet.kind === 'correct' && view.livePayment
                  ? {
                      paidOn: view.livePayment.paidOn,
                      referenceNumber: view.livePayment.referenceNumber,
                      amountCentavos: paymentAmount(view.livePayment.id),
                      note: view.livePayment.note,
                    }
                  : null
              }
              today={todayInManila()}
              noteHint={view.noteHint}
              onDone={() => {
                setSheet(null);
                router.refresh();
              }}
            />
          ) : null}
          {sheet?.kind === 'void' && view.livePayment ? (
            <VoidPaymentSheet
              key={session}
              agency={view.agency}
              month={view.month}
              paymentId={view.livePayment.id}
              onDone={() => {
                setSheet(null);
                router.refresh();
              }}
            />
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  );
}

/** Today's Manila day, for the paid date's default and limit. */
function todayInManila(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function GenerateSheet({ view, onDone }: { view: RemittanceReportPageView; onDone: () => void }) {
  const [networkError, setNetworkError] = useState<string | null>(null);
  const save = useActionSubmit(generateRemittanceReportAction, onDone);
  const regenerate = view.report !== null;

  async function submit() {
    setNetworkError(null);
    try {
      await save.run({
        agency: view.agency,
        month: view.month,
        ...(view.report ? { version: view.report.version } : {}),
      });
    } catch {
      setNetworkError(GENERATE_FAILED);
    }
  }

  return (
    <>
      <SheetHeader
        title={regenerate ? 'Regenerate the report?' : 'Generate the report?'}
        description={`${view.title}, from the month’s finalized payroll runs and today’s government IDs and company details.`}
      />
      <SheetBody>
        <FormAlert message={save.formError ?? networkError} />
        <p className="text-subheadline text-text-secondary">
          {regenerate
            ? 'The report is rebuilt and its version raised. Files exported from this version stay stored but are no longer offered.'
            : 'The report holds what the runs deducted, overrides included. Generating changes no one’s pay.'}
        </p>
      </SheetBody>
      <SheetFooter>
        <SheetClose asChild>
          <Button variant="secondary">Cancel</Button>
        </SheetClose>
        <Button onClick={() => void submit()} loading={save.pending}>
          {regenerate ? 'Regenerate' : 'Generate report'}
        </Button>
      </SheetFooter>
    </>
  );
}

function UploadSheet({
  warning,
  refusal,
  formatLabel,
  onDownload,
}: {
  warning: string | null;
  refusal: string | null;
  formatLabel: string;
  onDownload: () => Promise<string | null>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setPending(true);
    setError(null);
    try {
      setError(await onDownload());
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <SheetHeader title="Upload file" description={formatLabel} />
      <SheetBody>
        <FormAlert message={error ?? refusal} />
        {warning ? (
          <p className="flex items-start gap-2 rounded-card bg-surface px-4 py-3 text-footnote font-medium text-warning-text shadow-card">
            <TriangleAlert aria-hidden="true" className="mt-px size-4 shrink-0" strokeWidth={2} />
            <span>{warning}</span>
          </p>
        ) : null}
        <p className="text-subheadline text-text-secondary">
          The file holds every employee’s full ID number and amounts. Upload it on the agency’s
          portal; Pulse doesn’t send anything to the agency.
        </p>
      </SheetBody>
      <SheetFooter>
        <SheetClose asChild>
          <Button variant="secondary">Cancel</Button>
        </SheetClose>
        <Button onClick={() => void download()} loading={pending} disabled={refusal !== null}>
          <FileDown aria-hidden="true" className="size-4.5" />
          Download
        </Button>
      </SheetFooter>
    </>
  );
}
