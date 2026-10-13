'use client';

import {
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useRouter } from 'next/navigation';
import { ExternalLink, FileText, RotateCw, Trash2 } from 'lucide-react';
import { formatDate, formatPeso } from '@pulse/core';
import {
  CLIENT_TRACKING_NOTE,
  filingWindowNote,
  formatMerchantTin,
  MERCHANT_MAX_LENGTH,
  PROJECT_PICKER_NOTE,
  RECEIPT_NUMBER_MAX_LENGTH,
  RECEIPT_PICKER_LABEL,
  RECEIPT_REQUIRED,
  REIMBURSEMENT_DESCRIPTION_MAX_LENGTH,
  type ReimbursementLineView,
  type ReimbursementsSectionView,
  type ReimbursementTypeOption,
  ROUTE_MAX_LENGTH,
  type TimesheetClientOption,
} from '@pulse/talent';
import { Button } from '@pulse/ui/components/button';
import { DestructiveConfirmDialog } from '@pulse/ui/components/confirm-dialog';
import { FormField, FormSection, Input, Select, Textarea } from '@pulse/ui/components/form';
import { SheetBody, SheetClose, SheetFooter, SheetHeader } from '@pulse/ui/components/sheet';
import {
  ariaKeyShortcuts,
  ShortcutHint,
  submitFormFromShortcut,
  useShortcut,
} from '@pulse/ui/components/shortcut-hint';
import { cn } from '@pulse/ui/lib/utils';
import { FormAlert } from '@/components/form-alert';
import { useActionSubmit } from '@/components/org-structure';
import {
  addReimbursementAction,
  deleteReimbursementAction,
  updateReimbursementAction,
} from '@/lib/actions/talent-reimbursements';
import type { UploadHint } from '@/lib/upload-hints';
import { OverLimitBadge } from './badges';
import { overLimitText, ReceiptThumbnail } from './reimbursement-list';
import { longDayText } from './format';

// Spec: docs/modules/talent.md#reimbursements-build-step-25 ("Reimbursement lines", "Checks",
// "Screens") and docs/DESIGN_SYSTEM.md#layout--components ("Timesheets on a phone":
// Reimbursements) — the reimbursement sheet, full height on a phone, in inset grouped sections.
//
// - **The form** ("Add reimbursement", or a line on the own open timesheet). The receipt comes
//   first: a native file field "Take a photo or choose a file" with no `capture` attribute, so a
//   phone offers the camera and the files, naming the accepted types and size limit, with a
//   preview. Then the type, a native date input limited to the filing window ("Receipts dated
//   <from> – <to>"), the merchant, the merchant TIN (`inputmode="numeric"`), the receipt or invoice
//   number (a duplicate shows here), the amount in pesos (`inputmode="decimal"`), the client with
//   "For tracking only…", the disabled project picker, pick-up and drop-off when the type needs
//   them, and the description. The type sets which fields are required; the server checks every
//   rule again with the version in effect on the receipt date. Editing leaves the stored receipt
//   unless a new one is chosen; "Delete reimbursement" asks first.
// - **The detail** (anyone else, or a timesheet no longer open): the line read-only, with "Open
//   receipt".
//
// Amounts travel as typed and the action reads them with `parsePesos` (no floating point). A stale
// save comes back as a form error with a reload. Nothing is logged.

const SAVE = ['mod', 's'] as const;
const SAVE_FAILED = 'The reimbursement wasn’t saved. Check your connection and try again.';
const DELETE_FAILED = 'The reimbursement wasn’t deleted. Check your connection and try again.';
const TIN_PLACEHOLDER = '000-000-000-00000';

export type ReimbursementFormMode = { kind: 'add' } | { kind: 'edit'; line: ReimbursementLineView };

/** "Open receipt": an image opens in the browser; a PDF opens in the device's viewer. */
function OpenReceiptLink({ line }: { line: ReimbursementLineView }) {
  return (
    <Button variant="secondary" asChild className="self-start">
      <a
        href={line.receipt.isPdf ? line.receipt.url : line.receipt.inlineUrl}
        target="_blank"
        rel="noopener noreferrer"
      >
        <ExternalLink aria-hidden="true" className="size-4" />
        Open receipt
        <span className="sr-only">, opens in a new tab</span>
      </a>
    </Button>
  );
}

/** The receipt's larger preview: the image, or a PDF tile. */
function ReceiptPreview({
  src,
  isPdf,
  name,
}: {
  src: string | null;
  isPdf: boolean;
  name?: string;
}) {
  if (isPdf || !src) {
    return (
      <span className="flex items-center gap-3 rounded-lg bg-bg-grouped px-3 py-2.5 text-subheadline">
        <FileText
          aria-hidden="true"
          className="size-5 shrink-0 text-text-secondary"
          strokeWidth={1.75}
        />
        <span className="min-w-0 truncate">{name ?? 'PDF receipt'}</span>
      </span>
    );
  }
  return (
    <span className="flex max-h-64 justify-center overflow-hidden rounded-lg border border-separator bg-bg-grouped">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt="Receipt preview"
        decoding="async"
        className="max-h-64 w-auto object-contain"
      />
    </span>
  );
}

/** The types the sheet offers: today's active ones, and the line's own type when it isn't one. */
function typeOptionsFor(
  types: readonly ReimbursementTypeOption[],
  line: ReimbursementLineView | null,
): ReimbursementTypeOption[] {
  const offered = types.filter((type) => type.active || type.key === line?.typeKey);
  if (line && !offered.some((type) => type.key === line.typeKey)) {
    offered.push({
      key: line.typeKey,
      name: line.typeName,
      active: false,
      requiresRoute: line.pickUp !== null || line.dropOff !== null,
      requiresDescription: false,
      requiresClient: false,
      limit: null,
    });
  }
  return offered;
}

export function ReimbursementForm({
  mode,
  timesheetId,
  section,
  clients,
  receiptUpload,
  onDone,
}: {
  mode: ReimbursementFormMode;
  timesheetId: string;
  section: ReimbursementsSectionView;
  clients: readonly TimesheetClientOption[];
  /** The accepted types and size limit, from today's upload settings. */
  receiptUpload: UploadHint;
  /** Saved or deleted. */
  onDone: () => void;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const line = mode.kind === 'edit' ? mode.line : null;
  const filingWindow = section.window;
  const typeOptions = typeOptionsFor(section.types ?? [], line);

  const [typeKey, setTypeKey] = useState(line?.typeKey ?? typeOptions[0]?.key ?? '');
  const [receiptDate, setReceiptDate] = useState<string>(
    line?.receiptDate ?? filingWindow?.to ?? '',
  );
  const [merchant, setMerchant] = useState(line?.merchant ?? '');
  const [merchantTin, setMerchantTin] = useState(line ? formatMerchantTin(line.merchantTin) : '');
  const [receiptNumber, setReceiptNumber] = useState(line?.receiptNumber ?? '');
  const [amount, setAmount] = useState(
    line ? formatPeso(line.amountCentavos, { symbol: false }) : '',
  );
  const [clientId, setClientId] = useState(line?.client?.id ?? '');
  const [pickUp, setPickUp] = useState(line?.pickUp ?? '');
  const [dropOff, setDropOff] = useState(line?.dropOff ?? '');
  const [description, setDescription] = useState(line?.description ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({});
  const [networkError, setNetworkError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const create = useActionSubmit(addReimbursementAction, onDone);
  const update = useActionSubmit(updateReimbursementAction, onDone);
  const remove = useActionSubmit(deleteReimbursementAction, onDone);
  const save = mode.kind === 'add' ? create : update;

  useShortcut(SAVE, () => submitFormFromShortcut(formRef.current), { scope: formRef });

  // The chosen photo's preview, released when another is chosen or the sheet closes.
  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );

  const type = typeOptions.find((option) => option.key === typeKey) ?? null;
  const requiresRoute = type?.requiresRoute ?? false;
  const requiresDescription = type?.requiresDescription ?? false;
  const requiresClient = type?.requiresClient ?? false;

  // A line's own client may be retired since; keep it as an option so the sheet shows it.
  const clientOptions =
    line?.client && !clients.some((client) => client.id === line.client?.id)
      ? [...clients, line.client]
      : clients;

  const errors = { ...save.fieldErrors, ...localErrors };
  const formError =
    save.formError ??
    errors.timesheetId ??
    errors.reimbursementId ??
    errors.version ??
    networkError;

  function focusFirstError() {
    requestAnimationFrame(() => {
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    });
  }

  function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const picked = event.target.files?.[0];
    const chosen = picked && picked.size > 0 ? picked : null;
    setFile(chosen);
    setPreviewUrl(chosen?.type.startsWith('image/') ? URL.createObjectURL(chosen) : null);
    setLocalErrors((current) => {
      const rest = { ...current };
      delete rest.receipt;
      return rest;
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNetworkError(null);
    if (mode.kind === 'add' && !file) {
      save.reset();
      setLocalErrors({ receipt: RECEIPT_REQUIRED });
      focusFirstError();
      return;
    }
    setLocalErrors({});

    const data = new FormData();
    if (mode.kind === 'add') data.set('timesheetId', timesheetId);
    else {
      data.set('reimbursementId', mode.line.id);
      data.set('version', String(mode.line.version));
    }
    data.set('typeKey', typeKey);
    data.set('receiptDate', receiptDate);
    data.set('merchant', merchant);
    data.set('merchantTin', merchantTin);
    data.set('receiptNumber', receiptNumber);
    data.set('amountCentavos', amount);
    data.set('clientId', clientId);
    // Pick-up and drop-off only for a type that needs them (the server keeps them only then).
    data.set('pickUp', requiresRoute ? pickUp : '');
    data.set('dropOff', requiresRoute ? dropOff : '');
    data.set('description', description);
    if (file) data.set('receipt', file);

    try {
      const ok = await save.run(data);
      if (!ok) focusFirstError();
    } catch {
      setNetworkError(SAVE_FAILED);
    }
  }

  async function confirmDelete() {
    if (!line) return;
    setDeleteError(null);
    let ok = false;
    try {
      ok = await remove.run({ reimbursementId: line.id, version: line.version });
    } catch {
      setDeleteError(DELETE_FAILED);
      throw new Error('delete failed');
    }
    if (!ok) throw new Error('delete refused');
  }

  const windowHint = filingWindow
    ? filingWindowNote(formatDate(filingWindow.from), formatDate(filingWindow.to))
    : undefined;

  return (
    <form
      ref={formRef}
      noValidate
      onSubmit={submit}
      className="flex min-h-0 flex-1 flex-col"
      aria-busy={save.pending || undefined}
    >
      <SheetHeader
        title={mode.kind === 'add' ? 'Add reimbursement' : 'Edit reimbursement'}
        description={line ? longDayText(line.receiptDate) : windowHint}
      />
      <SheetBody>
        <FormAlert message={formError} />
        {formError && mode.kind === 'edit' ? (
          <Button
            variant="secondary"
            onClick={() => {
              router.refresh();
              onDone();
            }}
            className="self-start"
          >
            <RotateCw aria-hidden="true" className="size-4" />
            Reload timesheet
          </Button>
        ) : null}

        <FormSection title="Receipt">
          {line && !file ? (
            <div className="flex items-center gap-3 px-4 py-3">
              <ReceiptThumbnail line={line} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-subheadline">Current receipt</span>
                <span className="text-footnote text-text-secondary">
                  {line.receipt.isPdf ? 'PDF' : 'Photo'}
                </span>
              </span>
              <OpenReceiptLink line={line} />
            </div>
          ) : null}
          <FormField
            label={line ? 'Replace the receipt' : RECEIPT_PICKER_LABEL}
            required={!line}
            hint={
              line
                ? `${receiptUpload.hint} Leave it empty to keep the current receipt.`
                : receiptUpload.hint
            }
            error={errors.receipt}
          >
            {/* No `capture` attribute: a phone offers the camera and the files. */}
            <Input
              type="file"
              name="receipt"
              accept={receiptUpload.accept || undefined}
              disabled={!receiptUpload.accept}
              onChange={chooseFile}
              className={cn(
                'h-auto min-h-11 cursor-pointer py-1.5',
                'file:mr-3 file:h-8 file:cursor-pointer file:rounded-md file:border-0 file:bg-accent-subtle file:px-3 file:text-subheadline file:font-semibold file:text-accent',
              )}
            />
          </FormField>
          {file ? (
            <div className="px-4 py-3">
              <ReceiptPreview
                src={previewUrl}
                isPdf={!file.type.startsWith('image/')}
                name={file.name}
              />
            </div>
          ) : null}
        </FormSection>

        <FormSection title="Expense">
          <FormField label="Type" required error={errors.typeKey}>
            <Select
              name="typeKey"
              value={typeKey}
              onChange={(event) => setTypeKey(event.target.value)}
            >
              {typeKey === '' ? <option value="">Choose the type</option> : null}
              {typeOptions.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.active ? option.name : `${option.name} (no longer used)`}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Receipt date" required hint={windowHint} error={errors.receiptDate}>
            <Input
              type="date"
              name="receiptDate"
              value={receiptDate}
              min={filingWindow?.from}
              max={filingWindow?.to}
              onChange={(event) => setReceiptDate(event.target.value)}
              className="numeric sm:max-w-60"
            />
          </FormField>
          <FormField label="Merchant" required error={errors.merchant}>
            <Input
              name="merchant"
              value={merchant}
              maxLength={MERCHANT_MAX_LENGTH}
              autoComplete="off"
              onChange={(event) => setMerchant(event.target.value)}
            />
          </FormField>
          <FormField
            label="Merchant TIN"
            required
            hint="As printed on the receipt: 9, 12 or 14 digits."
            error={errors.merchantTin}
          >
            <Input
              name="merchantTin"
              value={merchantTin}
              inputMode="numeric"
              autoComplete="off"
              placeholder={TIN_PLACEHOLDER}
              maxLength={24}
              onChange={(event) => setMerchantTin(event.target.value)}
              className="numeric sm:max-w-60"
            />
          </FormField>
          <FormField label="Receipt or invoice number" required error={errors.receiptNumber}>
            <Input
              name="receiptNumber"
              value={receiptNumber}
              maxLength={RECEIPT_NUMBER_MAX_LENGTH}
              autoComplete="off"
              onChange={(event) => setReceiptNumber(event.target.value)}
              className="sm:max-w-60"
            />
          </FormField>
          <FormField
            label="Amount (₱)"
            required
            hint="In pesos, for example 1,234.50."
            error={errors.amountCentavos}
          >
            <Input
              name="amountCentavos"
              value={amount}
              inputMode="decimal"
              autoComplete="off"
              onChange={(event) => setAmount(event.target.value)}
              className="numeric sm:max-w-60"
            />
          </FormField>
          {line?.overLimit ? (
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 px-4 py-3">
              <OverLimitBadge />
              <span className="text-footnote text-warning-text numeric">
                {overLimitText(line.overLimit)}
              </span>
            </div>
          ) : null}
        </FormSection>

        <FormSection title="Client" footer={CLIENT_TRACKING_NOTE}>
          <FormField label="Client" required={requiresClient} error={errors.clientId}>
            <Select
              name="clientId"
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
            >
              <option value="">No client</option>
              {clientOptions.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Project" hint={PROJECT_PICKER_NOTE}>
            <Select disabled value="">
              <option value="">No project</option>
            </Select>
          </FormField>
        </FormSection>

        <FormSection title="Details">
          {requiresRoute ? (
            <>
              <FormField label="Pick-up" required error={errors.pickUp}>
                <Input
                  name="pickUp"
                  value={pickUp}
                  maxLength={ROUTE_MAX_LENGTH}
                  onChange={(event) => setPickUp(event.target.value)}
                />
              </FormField>
              <FormField label="Drop-off" required error={errors.dropOff}>
                <Input
                  name="dropOff"
                  value={dropOff}
                  maxLength={ROUTE_MAX_LENGTH}
                  onChange={(event) => setDropOff(event.target.value)}
                />
              </FormField>
            </>
          ) : null}
          <FormField
            label="Description"
            required={requiresDescription}
            hint={requiresDescription ? 'What the expense was for.' : 'Optional.'}
            error={errors.description}
          >
            <Textarea
              name="description"
              value={description}
              maxLength={REIMBURSEMENT_DESCRIPTION_MAX_LENGTH}
              onChange={(event) => setDescription(event.target.value)}
            />
          </FormField>
        </FormSection>

        {line ? (
          <DestructiveConfirmDialog
            trigger={
              <Button variant="secondary" className="self-start text-destructive-text">
                <Trash2 aria-hidden="true" className="size-4" />
                Delete reimbursement
              </Button>
            }
            title="Delete this reimbursement?"
            description="It’s removed from your timesheet, and its receipt can be claimed again. The audit log keeps a record of it."
            confirmLabel="Delete reimbursement"
            onConfirm={confirmDelete}
            error={remove.formError ?? deleteError}
          />
        ) : null}
      </SheetBody>
      <SheetFooter>
        <SheetClose asChild>
          <Button variant="secondary" className="pr-3">
            Cancel
            <ShortcutHint keys={['escape']} className="hidden sm:inline-flex" />
          </Button>
        </SheetClose>
        <Button
          type="submit"
          loading={save.pending}
          aria-keyshortcuts={ariaKeyShortcuts(SAVE)}
          className="pr-3"
        >
          {mode.kind === 'add' ? 'Add reimbursement' : 'Save'}
          <ShortcutHint keys={SAVE} tone="on-fill" className="hidden sm:inline-flex" />
        </Button>
      </SheetFooter>
    </form>
  );
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 px-4 py-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
      <dt className="text-footnote text-text-secondary">{label}</dt>
      <dd className="min-w-0 text-subheadline break-words sm:text-right">{children}</dd>
    </div>
  );
}

/** A line read-only, for Talent Read, a supervisor, or a timesheet no longer open. */
export function ReimbursementDetail({ line }: { line: ReimbursementLineView }) {
  return (
    <>
      <SheetHeader title={line.merchant} description={longDayText(line.receiptDate)} />
      <SheetBody>
        {line.receipt.isPdf ? (
          <ReceiptPreview src={null} isPdf name="PDF receipt" />
        ) : (
          <ReceiptPreview src={line.receipt.inlineUrl} isPdf={false} />
        )}
        <OpenReceiptLink line={line} />
        {line.overLimit ? (
          <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <OverLimitBadge />
            <span className="text-footnote text-warning-text numeric">
              {overLimitText(line.overLimit)}
            </span>
          </p>
        ) : null}
        <dl className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
          <DetailRow label="Type">{line.typeName}</DetailRow>
          <DetailRow label="Amount">
            <span className="font-semibold numeric">{formatPeso(line.amountCentavos)}</span>
          </DetailRow>
          <DetailRow label="Merchant TIN">
            <span className="numeric">{formatMerchantTin(line.merchantTin)}</span>
          </DetailRow>
          <DetailRow label="Receipt or invoice number">
            <span className="numeric">{line.receiptNumber}</span>
          </DetailRow>
          <DetailRow label="Client">{line.client?.name ?? 'No client'}</DetailRow>
          {line.pickUp ? <DetailRow label="Pick-up">{line.pickUp}</DetailRow> : null}
          {line.dropOff ? <DetailRow label="Drop-off">{line.dropOff}</DetailRow> : null}
          {line.description ? <DetailRow label="Description">{line.description}</DetailRow> : null}
        </dl>
        {line.client ? (
          <p className="px-4 text-footnote text-text-secondary">{CLIENT_TRACKING_NOTE}</p>
        ) : null}
      </SheetBody>
    </>
  );
}
