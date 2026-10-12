'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { ChevronRight, RotateCw, UserCheck } from 'lucide-react';
import { formatDate } from '@pulse/core';
import { type BelowMinimumWageList, WORK_REGION_LABELS, type WorkRegion } from '@pulse/talent';
import { Button } from '@pulse/ui/components/button';
import { EmptyState } from '@pulse/ui/components/empty-state';
import { ErrorState } from '@pulse/ui/components/error-state';
import { SheetBody, SheetHeader } from '@pulse/ui/components/sheet';
import { Skeleton } from '@pulse/ui/components/skeleton';
import { listEmployeesBelowMinimumWageAction } from '@/lib/actions/talent-payroll';

// Spec: docs/modules/talent.md#payroll-settings-and-allowances-build-step-23 ("When a new wage
// order takes effect", decision 207 in docs/BUILD_PLAN.md) — "View list" on a minimum wage
// version: the active employees in its region paid below it, by name, with their number,
// department and position, each linking to their record. Never an amount. Talent Read and HR,
// Accounting or the System Administrator (the action and the service check). Not audit-logged.

export interface BelowWageTarget {
  versionId: string;
  region: WorkRegion;
  wageOrder: string;
}

type ListState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'gone' }
  | { status: 'ready'; list: BelowMinimumWageList };

const LOAD_FAILED = 'The list couldn’t load. Check your connection and try again.';

/** Loads the list for a target, keeping only the latest answer. */
export function useBelowWageList() {
  const [target, setTarget] = useState<BelowWageTarget | null>(null);
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const request = useRef(0);

  async function load(next: BelowWageTarget) {
    const id = (request.current += 1);
    setTarget(next);
    setState({ status: 'loading' });
    try {
      const result = await listEmployeesBelowMinimumWageAction(null, {
        versionId: next.versionId,
        region: next.region,
      });
      if (id !== request.current) return;
      if (!result.ok) {
        setState({ status: 'error', message: result.formError ?? LOAD_FAILED });
      } else if (result.data === null) {
        setState({ status: 'gone' });
      } else {
        setState({ status: 'ready', list: result.data });
      }
    } catch {
      if (id === request.current) setState({ status: 'error', message: LOAD_FAILED });
    }
  }

  return { target, state, load };
}

export function BelowMinimumWageSheet({
  target,
  state,
  onRetry,
}: {
  target: BelowWageTarget;
  state: ListState;
  onRetry: () => void;
}) {
  const region = WORK_REGION_LABELS[target.region];
  return (
    <>
      <SheetHeader
        title={`Below ${target.wageOrder}`}
        description={
          state.status === 'ready'
            ? `Active employees in ${region} paid below this wage order on ${formatDate(state.list.checkedOn)}. Amounts aren’t shown.`
            : `Active employees in ${region} paid below this wage order. Amounts aren’t shown.`
        }
      />
      <SheetBody aria-busy={state.status === 'loading' || undefined}>
        {state.status === 'loading' ? (
          <div role="status" className="flex flex-col gap-2">
            <span className="sr-only">Loading the list…</span>
            <div
              aria-hidden="true"
              className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card"
            >
              {Array.from({ length: 4 }, (_, index) => (
                <div key={index} className="flex min-h-16 flex-col justify-center gap-2 px-4 py-3">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-56 max-w-full" />
                </div>
              ))}
            </div>
          </div>
        ) : state.status === 'error' ? (
          <ErrorState
            variant="inline"
            headingLevel={3}
            title="The list didn’t load"
            description={state.message}
            action={
              <Button variant="tinted" onClick={onRetry}>
                <RotateCw aria-hidden="true" className="size-4.5" />
                Try again
              </Button>
            }
          />
        ) : state.status === 'gone' ? (
          <ErrorState
            variant="inline"
            headingLevel={3}
            title="This wage order isn’t on file any more"
            description="Reload the page to see the current minimum wages."
          />
        ) : state.list.rows.length === 0 ? (
          <EmptyState
            variant="inline"
            headingLevel={3}
            icon={<UserCheck strokeWidth={1.75} />}
            title="No one is paid below it"
            description={`Every active employee in ${region} is paid at least this wage order.`}
          />
        ) : (
          <div className="flex flex-col gap-2">
            <p className="numeric px-4 text-footnote text-text-secondary">
              {state.list.rows.length} {state.list.rows.length === 1 ? 'employee' : 'employees'}
            </p>
            <ul className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
              {state.list.rows.map((row) => {
                const detail = [row.position?.name, row.department?.name]
                  .filter(Boolean)
                  .join(' · ');
                return (
                  <li key={row.employeeId}>
                    <Link
                      href={row.href}
                      className="flex min-h-16 items-center gap-3 px-4 py-3 transition-colors duration-fast hover:bg-accent-subtle focus-visible:outline-offset-[-2px]"
                    >
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="truncate text-subheadline font-semibold text-accent">
                          {row.name}
                        </span>
                        <span className="truncate text-footnote text-text-secondary">
                          <span className="numeric">{row.employeeNumber}</span>
                          {detail ? ` · ${detail}` : null}
                        </span>
                      </span>
                      <ChevronRight
                        aria-hidden="true"
                        className="size-4.5 shrink-0 text-text-secondary"
                      />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </SheetBody>
    </>
  );
}
