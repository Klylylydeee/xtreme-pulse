'use client';

import { type FormEvent, useState } from 'react';
import { Ban, TriangleAlert } from 'lucide-react';
import { centavosToDecimalString, type Centavos } from '@pulse/core';
import type { RemittanceAgency } from '@pulse/talent';
import { Button } from '@pulse/ui/components/button';
import { FormField, FormSection, Input, Textarea } from '@pulse/ui/components/form';
import { SheetBody, SheetClose, SheetFooter, SheetHeader } from '@pulse/ui/components/sheet';
import { FormAlert } from '@/components/form-alert';
import { useActionSubmit } from '@/components/org-structure';
import {
  correctRemittancePaymentAction,
  recordRemittancePaymentAction,
  voidRemittancePaymentAction,
} from '@/lib/actions/talent-remittances';

// Spec: docs/modules/talent.md#employer-contributions-and-remittances-build-step-211 ("Payments")
// and docs/DESIGN_SYSTEM.md#feedback--motion (non-blocking warnings) — the report page's payment
// sheets, for Talent Write and HR, Accounting or the System Administrator (the page shows them
// only then; the actions and services check again).
//
// - "Record payment" and "Correct payment": the paid date, the reference number (1–60), the amount
//   paid in pesos and an optional note ("Don't type amounts or ID numbers in the note."); a
//   correction also needs its reason. An amount other than the amount due comes back as the
//   server's warning, shown in `warning-text` with "Save anyway".
// - "Void payment": a required reason; the report goes back to "Generated".
// Nothing here is logged.

const SAVE_FAILED = 'The payment wasn’t saved. Check your connection and try again.';
const VOID_FAILED = 'The payment wasn’t voided. Check your connection and try again.';
const REFERENCE_MAX = 60;
const NOTE_MAX = 300;
const REASON_MAX = 300;

export interface PaymentDefaults {
  paidOn: string;
  referenceNumber: string;
  /** The amount in centavos, or null for none (typed in pesos). */
  amountCentavos: Centavos | null;
  note: string | null;
}

export function PaymentSheet({
  agency,
  month,
  version,
  correctingId,
  defaults,
  today,
  noteHint,
  onDone,
}: {
  agency: RemittanceAgency;
  month: string;
  /** The report's version the page shows (recording). */
  version: number;
  /** The live payment being corrected, or null when recording. */
  correctingId: string | null;
  defaults: PaymentDefaults | null;
  today: string;
  noteHint: string;
  onDone: () => void;
}) {
  const [paidOn, setPaidOn] = useState(defaults?.paidOn ?? today);
  const [referenceNumber, setReferenceNumber] = useState(defaults?.referenceNumber ?? '');
  const [amount, setAmount] = useState(
    defaults?.amountCentavos != null ? centavosToDecimalString(defaults.amountCentavos) : '',
  );
  const [note, setNote] = useState(defaults?.note ?? '');
  const [reason, setReason] = useState('');
  const [warning, setWarning] = useState<string | null>(null);
  const [networkError, setNetworkError] = useState<string | null>(null);
  const record = useActionSubmit(recordRemittancePaymentAction, (data) => {
    if (data.status === 'saved') onDone();
    else setWarning(data.message);
  });
  const correct = useActionSubmit(correctRemittancePaymentAction, (data) => {
    if (data.status === 'saved') onDone();
    else setWarning(data.message);
  });
  const save = correctingId ? correct : record;
  const errors = save.fieldErrors;

  async function submit(confirmAmount: boolean) {
    setNetworkError(null);
    const input = {
      agency,
      month,
      paidOn,
      referenceNumber,
      amountCentavos: amount,
      note: note.trim() === '' ? undefined : note,
      confirmAmount,
    };
    try {
      if (correctingId) await correct.run({ ...input, paymentId: correctingId, reason });
      else await record.run({ ...input, version });
    } catch {
      setNetworkError(SAVE_FAILED);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setWarning(null);
    void submit(false);
  }

  return (
    <form noValidate onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
      <SheetHeader
        title={correctingId ? 'Correct payment' : 'Record payment'}
        description={
          correctingId
            ? 'The correction is saved as a new entry; the one it replaces stays in the history.'
            : 'The date and reference of the payment made on the agency’s portal or at the bank.'
        }
      />
      <SheetBody>
        <FormAlert message={save.formError ?? networkError} />
        {warning ? (
          <div className="flex flex-col gap-3 rounded-card bg-surface px-4 py-3 shadow-card">
            <p className="flex items-start gap-2 text-footnote font-medium text-warning-text">
              <TriangleAlert aria-hidden="true" className="mt-px size-4 shrink-0" strokeWidth={2} />
              <span>{warning}</span>
            </p>
            <Button
              variant="secondary"
              className="w-fit"
              loading={save.pending}
              onClick={() => void submit(true)}
            >
              Save anyway
            </Button>
          </div>
        ) : null}
        <FormSection title="Payment">
          <FormField label="Paid on" required error={errors.paidOn}>
            <Input
              type="date"
              value={paidOn}
              max={today}
              min={`${month}-01`}
              onChange={(event) => {
                setPaidOn(event.target.value);
                setWarning(null);
              }}
              required
              className="numeric sm:max-w-56"
            />
          </FormField>
          <FormField
            label="Reference number"
            required
            hint="The PRN, the eFPS or eBIRForms confirmation, or the bank’s reference."
            error={errors.referenceNumber}
          >
            <Input
              value={referenceNumber}
              maxLength={REFERENCE_MAX}
              onChange={(event) => setReferenceNumber(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              required
            />
          </FormField>
          <FormField
            label="Amount paid"
            required
            hint="In pesos, like 7,185.00."
            error={errors.amountCentavos}
          >
            <Input
              value={amount}
              inputMode="decimal"
              onChange={(event) => {
                setAmount(event.target.value);
                setWarning(null);
              }}
              autoComplete="off"
              required
              className="numeric sm:max-w-56"
            />
          </FormField>
          <FormField label="Note" hint={noteHint} error={errors.note}>
            <Textarea
              value={note}
              maxLength={NOTE_MAX}
              onChange={(event) => setNote(event.target.value)}
            />
          </FormField>
          {correctingId ? (
            <FormField label="Reason for the correction" required error={errors.reason}>
              <Textarea
                value={reason}
                maxLength={REASON_MAX}
                onChange={(event) => setReason(event.target.value)}
                required
              />
            </FormField>
          ) : null}
        </FormSection>
      </SheetBody>
      <SheetFooter>
        <SheetClose asChild>
          <Button variant="secondary">Cancel</Button>
        </SheetClose>
        <Button type="submit" loading={save.pending}>
          {correctingId ? 'Save correction' : 'Record payment'}
        </Button>
      </SheetFooter>
    </form>
  );
}

export function VoidPaymentSheet({
  agency,
  month,
  paymentId,
  onDone,
}: {
  agency: RemittanceAgency;
  month: string;
  paymentId: string;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [networkError, setNetworkError] = useState<string | null>(null);
  const save = useActionSubmit(voidRemittancePaymentAction, onDone);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setNetworkError(null);
    try {
      await save.run({ agency, month, paymentId, reason });
    } catch {
      setNetworkError(VOID_FAILED);
    }
  }

  return (
    <form
      noValidate
      onSubmit={(event) => void submit(event)}
      className="flex min-h-0 flex-1 flex-col"
    >
      <SheetHeader
        title="Void payment?"
        description="The payment stays in the history marked void, and the report is back to Generated, so it can be regenerated and paid again."
      />
      <SheetBody>
        <FormAlert message={save.formError ?? networkError} />
        <FormSection title="Void">
          <FormField label="Reason" required error={save.fieldErrors.reason}>
            <Textarea
              value={reason}
              maxLength={REASON_MAX}
              onChange={(event) => setReason(event.target.value)}
              required
            />
          </FormField>
        </FormSection>
      </SheetBody>
      <SheetFooter>
        <SheetClose asChild>
          <Button variant="secondary">Cancel</Button>
        </SheetClose>
        <Button type="submit" variant="destructive" loading={save.pending}>
          <Ban aria-hidden="true" className="size-4.5" />
          Void payment
        </Button>
      </SheetFooter>
    </form>
  );
}
