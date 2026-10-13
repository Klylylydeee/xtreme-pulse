'use client';

import { type ReactNode, useRef, useState } from 'react';
import Link from 'next/link';
import { CircleCheck, ExternalLink, Receipt } from 'lucide-react';
import { formatDate, formatPeso } from '@pulse/core';
import {
  formatMerchantTin,
  RECEIPT_NOT_CLAIMED,
  RECEIPT_NUMBER_MAX_LENGTH,
  type ReceiptCheckView,
} from '@pulse/talent';
import { Button, buttonVariants } from '@pulse/ui/components/button';
import { FormField, FormSection, Input } from '@pulse/ui/components/form';
import { SheetBody, SheetClose, SheetFooter, SheetHeader } from '@pulse/ui/components/sheet';
import { FormAlert } from '@/components/form-alert';
import { useActionSubmit } from '@/components/org-structure';
import { checkReceiptAction } from '@/lib/actions/talent-receipts';

// Spec: docs/modules/talent.md#reimbursements-build-step-25 ("Check a receipt"; decisions 241,
// 245 and 252 in docs/BUILD_PLAN.md) and docs/RUNBOOK.md#a-receipt-was-rejected-as-a-duplicate —
// the "Check a receipt" sheet on `/talent`, for Talent Read (the page needs it, and the action and
// the service check it again).
//
// - A merchant TIN and a receipt or invoice number, as printed (dashes, spaces, letter case and
//   leading zeros don't matter; no branch code is the head office), give the live claim, if any:
//   the claimant's name and employee number, the receipt date, type and amount, and a link to the
//   timesheet; or "Petty cash voucher" from step 5.11.
// - The result names the receipt it is for (the canonical TIN and receipt key), and editing a
//   field clears it, so it never reads as the answer for other figures.
// - Errors come back inline. Nothing here is sensitive, logged or audit-logged (decision 246).

const CHECK_FAILED = 'The receipt wasn’t checked. Check your connection and try again.';

type Outcome = { claim: ReceiptCheckView | null } | null;

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
          <dd className="text-subheadline break-words text-text-primary sm:text-right">
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function ClaimResult({ claim }: { claim: ReceiptCheckView | null }) {
  if (claim === null) {
    return (
      <p className="flex items-start gap-2 rounded-card bg-surface px-4 py-3 text-footnote font-medium text-text-primary shadow-card">
        <CircleCheck aria-hidden="true" className="mt-px size-4 shrink-0 text-success-text" />
        <span>{RECEIPT_NOT_CLAIMED}</span>
      </p>
    );
  }
  const receipt = (
    <span className="numeric break-all">
      {formatMerchantTin(claim.merchantTin)} · {claim.receiptKey}
    </span>
  );
  if (claim.kind === 'pettyCashVoucher') {
    return (
      <div className="flex flex-col gap-2">
        <h3 className="px-4 text-subheadline font-semibold text-text-primary">
          Claimed on a petty cash voucher
        </h3>
        <Facts
          rows={[
            { term: 'Claimed as', value: 'Petty cash voucher' },
            { term: 'Receipt', value: receipt },
            { term: 'Claimed on', value: formatDate(claim.claimedAt) },
          ]}
        />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <h3 className="px-4 text-subheadline font-semibold text-text-primary">
        Claimed as a reimbursement
      </h3>
      <Facts
        rows={[
          {
            term: 'Claimed by',
            value: (
              <>
                {claim.claimant.name} ·{' '}
                <span className="numeric">{claim.claimant.employeeNumber}</span>
              </>
            ),
          },
          { term: 'Receipt date', value: formatDate(claim.receiptDate) },
          { term: 'Type', value: claim.typeName },
          {
            term: 'Amount',
            value: <span className="numeric">{formatPeso(claim.amountCentavos)}</span>,
          },
          { term: 'Receipt', value: receipt },
          { term: 'Claimed on', value: formatDate(claim.claimedAt) },
        ]}
      />
      <div className="px-1">
        <Link
          href={claim.timesheetHref}
          className={buttonVariants({ variant: 'tinted', className: 'w-full sm:w-auto' })}
        >
          <ExternalLink aria-hidden="true" className="size-4.5" />
          Open timesheet
        </Link>
      </div>
    </div>
  );
}

/** "Check a receipt": who claimed a merchant TIN and receipt or invoice number. */
export function CheckReceiptSheet() {
  const formRef = useRef<HTMLFormElement>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [networkError, setNetworkError] = useState<string | null>(null);
  const check = useActionSubmit(checkReceiptAction, (claim) => setOutcome({ claim }));
  const errors = check.fieldErrors;

  async function submit(form: HTMLFormElement) {
    setNetworkError(null);
    setOutcome(null);
    try {
      const ok = await check.run(new FormData(form));
      if (!ok) {
        requestAnimationFrame(() => {
          form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
        });
      }
    } catch {
      setNetworkError(CHECK_FAILED);
    }
  }

  // Editing a field clears the answer, which was for the figures sent.
  function edited() {
    if (outcome !== null) setOutcome(null);
  }

  return (
    <form
      ref={formRef}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit(event.currentTarget);
      }}
      className="flex min-h-0 flex-1 flex-col"
      aria-busy={check.pending || undefined}
    >
      <SheetHeader
        title="Check a receipt"
        description="Find who claimed a receipt, by its merchant TIN and its receipt or invoice number."
      />
      <SheetBody>
        <FormAlert message={check.formError ?? networkError} />
        <FormSection
          title="Receipt"
          footer="Type them as printed: dashes, spaces, letter case and leading zeros don’t matter."
        >
          <FormField
            label="Merchant TIN"
            required
            error={errors.merchantTin}
            hint="9, 12 or 14 digits. A TIN with no branch code is the head office."
          >
            <Input
              name="merchantTin"
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              maxLength={24}
              required
              onChange={edited}
              className="numeric sm:max-w-64"
            />
          </FormField>
          <FormField label="Receipt or invoice number" required error={errors.receiptNumber}>
            <Input
              name="receiptNumber"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={RECEIPT_NUMBER_MAX_LENGTH}
              required
              onChange={edited}
              className="numeric sm:max-w-64"
            />
          </FormField>
        </FormSection>
        <div role="status" aria-live="polite" className="empty:hidden">
          {outcome ? <ClaimResult claim={outcome.claim} /> : null}
        </div>
      </SheetBody>
      <SheetFooter>
        <SheetClose asChild>
          <Button variant="secondary">Close</Button>
        </SheetClose>
        <Button type="submit" loading={check.pending}>
          <Receipt aria-hidden="true" className="size-4.5" />
          Check
        </Button>
      </SheetFooter>
    </form>
  );
}
