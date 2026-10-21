'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { CircleAlert, FileText } from 'lucide-react';
import { formatPeso } from '@pulse/core';
import type { OwnPayslipRow } from '@pulse/talent/server';
import { Button } from '@pulse/ui/components/button';
import { MaskedField, type MaskedFieldRevealResult } from '@pulse/ui/components/masked-field';
import { revealSensitiveAction } from '@/lib/actions/sensitive';
import { openPayslipAction } from '@/lib/actions/talent-payslips';

// Spec: docs/modules/talent.md#payroll-review-approval-and-payslips-build-step-210 ("Payslips":
// self-service) and docs/DESIGN_SYSTEM.md ("Payslips in self-service") — the Payslips section of
// `/talent/me` (anchor `#payslips`, where the `talent.payslipReady` notification lands): the
// signed-in employee's payslips of finalized runs, newest first. Each row has a date tile for the
// pay date, the period and run number, "Net pay ••••" with Reveal (step 2.9's generic
// `talent.payrollRunEmployee` reveal through the one reveal action, which checks the reveal rules
// and writes the `reveal` entry before decrypting; it answers only for a finalized run's line) and
// "Open payslip".
//
// "Open payslip" asks the server for the PDF's file route URL (`openPayslipAction`, which renders
// the PDF first when the job hasn't yet) and then navigates this tab to it. The file route sends a
// PDF as a download (`Content-Disposition: attachment`), so the page stays put while the browser
// saves it or hands it to the phone's PDF viewer; navigating after the round trip is never caught
// by a popup blocker, as opening a new window after an `await` would be. The file route checks
// access again and writes the `reveal` entry (field `file`) before sending anything.
//
// Nothing here takes an employee id: the rows come from the signed-in user's own employee, and
// the actions take only a line id, checked on the server.

const OPEN_FAILED = 'The payslip didn’t open. Check your connection and try again.';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A revealed net pay arrives as whole centavos (below zero only when HR settles it). */
function formatRevealedNetPay(value: string): string {
  return /^-?\d+$/.test(value) ? formatPeso(Number(value)) : value;
}

function revealNetPay(row: OwnPayslipRow) {
  return async (): Promise<MaskedFieldRevealResult> => {
    const result = await revealSensitiveAction(null, {
      ownerType: row.netPay.ownerType,
      ownerId: row.netPay.ownerId,
      field: row.netPay.field,
    });
    return result.ok
      ? { ok: true, data: formatRevealedNetPay(result.data) }
      : { ok: false, formError: result.formError };
  };
}

export function OwnPayslips({ payslips }: { payslips: OwnPayslipRow[] }) {
  const titleId = useId();
  const sectionRef = useRef<HTMLElement>(null);

  // The section streams in after the page, so the browser's own jump to `#payslips` (a
  // notification's link) can run before it exists; jump once it's here.
  useEffect(() => {
    if (window.location.hash === '#payslips') {
      sectionRef.current?.scrollIntoView({ block: 'start' });
    }
  }, []);

  return (
    <section
      ref={sectionRef}
      id="payslips"
      aria-labelledby={titleId}
      className="flex scroll-mt-20 flex-col gap-2"
    >
      <h3
        id={titleId}
        className="flex min-h-11 items-center pl-4 text-footnote font-semibold text-text-secondary"
      >
        Payslips
      </h3>
      {payslips.length === 0 ? (
        <p className="rounded-card bg-surface px-4 py-3 text-subheadline text-text-secondary shadow-card">
          No payslips yet. Each one shows here once its payroll is approved.
        </p>
      ) : (
        <ol
          aria-labelledby={titleId}
          className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card"
        >
          {payslips.map((row) => (
            <PayslipRow key={row.lineId} row={row} />
          ))}
        </ol>
      )}
    </section>
  );
}

function PayslipRow({ row }: { row: OwnPayslipRow }) {
  const errorId = useId();
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function open() {
    setOpening(true);
    setError(null);
    try {
      const result = await openPayslipAction(null, { lineId: row.lineId });
      if (result.ok) {
        window.location.assign(result.data.href);
      } else {
        setError(result.formError ?? OPEN_FAILED);
      }
    } catch {
      setError(OPEN_FAILED);
    } finally {
      setOpening(false);
    }
  }

  return (
    <li className="flex flex-col gap-1 py-2.5">
      <div className="flex min-h-16 items-center gap-3 px-4">
        <PayDateTile payDate={row.payDate} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="numeric text-subheadline font-semibold break-words">
            {row.periodText}
          </span>
          <span className="text-footnote break-words text-text-secondary">
            Paid <span className="numeric">{row.payDateText}</span> ·{' '}
            <span className="numeric">{row.runNumber}</span>
          </span>
        </span>
      </div>
      <MaskedField label="Net pay" lastFour="" reveal={revealNetPay(row)} />
      <div className="flex flex-col gap-1 px-1">
        <div className="flex flex-wrap items-center gap-1">
          <Button
            variant="plain"
            className="px-3"
            loading={opening}
            onClick={open}
            aria-label={`Open payslip for ${row.periodText}`}
            aria-describedby={error ? errorId : undefined}
          >
            {opening ? null : <FileText aria-hidden="true" className="size-4.5" />}
            {opening && !row.ready ? 'Preparing payslip…' : 'Open payslip'}
          </Button>
        </div>
        <div aria-live="polite">
          {error ? (
            <p
              id={errorId}
              className="flex items-start gap-1.5 px-3 text-footnote font-medium text-destructive-text"
            >
              <CircleAlert aria-hidden="true" className="mt-px size-4 shrink-0" />
              <span>{error}</span>
            </p>
          ) : null}
        </div>
      </div>
    </li>
  );
}

/** The pay date as a tile: the month over the day. */
function PayDateTile({ payDate }: { payDate: string }) {
  const [, month, day] = payDate.split('-');
  return (
    <span
      aria-hidden="true"
      className="flex size-12 shrink-0 flex-col items-center justify-center rounded-lg bg-accent-subtle text-accent"
    >
      <span className="text-caption font-medium uppercase">{MONTHS[Number(month) - 1]}</span>
      <span className="text-headline leading-none numeric">{Number(day)}</span>
    </span>
  );
}
