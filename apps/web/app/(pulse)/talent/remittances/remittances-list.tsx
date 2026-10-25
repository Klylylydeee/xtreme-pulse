import Link from 'next/link';
import { ArrowLeft, CalendarClock, ChevronRight, Landmark } from 'lucide-react';
import type { RemittanceListRow, RemittanceListView } from '@pulse/talent/server';
import { cn } from '@pulse/ui';
import { buttonVariants } from '@pulse/ui/components/button';
import { EmptyState } from '@pulse/ui/components/empty-state';
import { PageHeader } from '@pulse/ui/components/page-header';
import { RemittanceStatusBadges } from './remittance-badges';

// Spec: docs/modules/talent.md#employer-contributions-and-remittances-build-step-211 ("Screens":
// `/talent/remittances`) and docs/DESIGN_SYSTEM.md#layout--components ("Remittances on a phone":
// one inset grouped section per month, newest first, titled "October 2026"; each agency a row at
// least 64px tall with its name, "Due Nov 30, 2026" and a text badge, and once paid "Paid Nov 27,
// 2026 · <reference>") — the remittances page. No amount and no ID number is on it.

const DESCRIPTION =
  'Monthly SSS, PhilHealth, Pag-IBIG and BIR 1601-C remittances from the finalized payroll runs, with their due dates and payments.';

function AgencyRow({ row }: { row: RemittanceListRow }) {
  return (
    <li>
      <Link
        href={row.href}
        aria-label={`${row.agencyLabel}, ${row.statusLabel}${row.overdue ? ', overdue' : ''}, ${row.dueText}${row.paidText ? `, ${row.paidText}` : ''}`}
        className={cn(
          'flex min-h-16 w-full items-center gap-3 px-4 py-3 transition-colors duration-fast',
          'hover:bg-accent-subtle/40 focus-visible:outline-offset-[-2px] md:px-5',
        )}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-subheadline font-semibold">{row.agencyLabel}</span>
            <RemittanceStatusBadges
              status={row.status}
              label={row.statusLabel}
              overdue={row.overdue}
            />
          </span>
          <span className="text-footnote text-text-secondary numeric">{row.dueText}</span>
          {row.paidText ? (
            <span className="text-footnote break-words text-text-secondary numeric">
              {row.paidText}
            </span>
          ) : null}
        </span>
        <ChevronRight aria-hidden="true" className="size-4.5 shrink-0 text-text-tertiary" />
      </Link>
    </li>
  );
}

export function RemittancesList({ view }: { view: RemittanceListView }) {
  return (
    <>
      <div className="flex flex-col gap-3">
        <Link
          href="/talent"
          className={buttonVariants({ variant: 'plain', className: '-ml-3 w-fit text-accent' })}
        >
          <ArrowLeft aria-hidden="true" className="size-4.5" />
          Employees
        </Link>
        <PageHeader title="Remittances" description={DESCRIPTION} />
      </div>

      {view.goLiveRequiredMessage ? (
        <EmptyState
          icon={<CalendarClock strokeWidth={1.75} />}
          title={view.goLiveRequiredMessage}
          description="Remittances start with the month the first payroll cut-off is paid in. A Talent Owner in HR sets the go-live date in Payroll settings › Leave."
          action={
            <Link href="/talent/payroll-settings" className={buttonVariants({ variant: 'tinted' })}>
              Payroll settings
            </Link>
          }
        />
      ) : view.months.length === 0 ? (
        <EmptyState
          icon={<Landmark strokeWidth={1.75} />}
          title="No remittance months yet"
          description="The first month appears once its first payroll cut-off is paid."
        />
      ) : (
        view.months.map((group) => (
          <section
            key={group.month}
            aria-labelledby={`remittances-${group.month}`}
            className="flex flex-col gap-2"
          >
            <h2
              id={`remittances-${group.month}`}
              className="px-4 text-footnote font-semibold text-text-secondary"
            >
              {group.label}
            </h2>
            <ul className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
              {group.agencies.map((row) => (
                <AgencyRow key={row.agency} row={row} />
              ))}
            </ul>
          </section>
        ))
      )}
    </>
  );
}
