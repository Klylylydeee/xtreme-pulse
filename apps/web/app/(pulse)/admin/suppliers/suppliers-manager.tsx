'use client';

import { useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { CircleCheck, Plus, Search, Truck } from 'lucide-react';
import {
  ADDRESS_MAX_LENGTH,
  DEFAULT_SUPPLIER_TYPE,
  formatDate,
  MASTER_NAME_MAX_LENGTH,
  NOTES_MAX_LENGTH,
  SUPPLIER_TYPE_LABELS,
  SUPPLIER_TYPES,
  type SupplierType,
  TERMS_DAYS_MAX,
  TIN_HELP,
} from '@pulse/core';
import type { BrandOption, SupplierView } from '@pulse/core/server';
import { Button } from '@pulse/ui/components/button';
import { DestructiveConfirmDialog } from '@pulse/ui/components/confirm-dialog';
import {
  createDataTableColumns,
  DataTable,
  type DataTableColumn,
} from '@pulse/ui/components/data-table';
import { EmptyState } from '@pulse/ui/components/empty-state';
import { FormField, FormSection, Input, Select, Textarea } from '@pulse/ui/components/form';
import { IconTile } from '@pulse/ui/components/icon-tile';
import { PageHeader } from '@pulse/ui/components/page-header';
import {
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetFooter,
  SheetHeader,
} from '@pulse/ui/components/sheet';
import {
  ariaKeyShortcuts,
  ShortcutHint,
  submitFormFromShortcut,
  useShortcut,
} from '@pulse/ui/components/shortcut-hint';
import { useReturnFocus } from '@pulse/ui/hooks/use-return-focus';
import { FormAlert } from '@/components/form-alert';
import {
  Badge,
  plural,
  ReadOnlyField,
  ShowRetiredSwitch,
  useActionSubmit,
} from '@/components/org-structure';
import {
  createSupplierAction,
  restoreSupplierAction,
  retireSupplierAction,
  updateSupplierAction,
} from '@/lib/actions/suppliers';
import { type ContactRow, SupplierContactsFields } from './supplier-contacts-fields';

// Spec: docs/modules/core.md#managing-master-data and docs/modules/supply.md#suppliers — the
// suppliers list, with search. A row opens its sheet: the edit form for a live supplier (details,
// contacts and products supplied), or its details and Restore for a retired one. Retiring asks
// first. A product retired after it was linked stays on the supplier, checked, with a "Retired"
// badge; only live products can be newly picked.

const SUBMIT = ['mod', 'enter'] as const;

/** "30 days", or null when no payment terms are set. */
function termsLabel(days: number | null): string | null {
  return days === null ? null : plural(days, 'day', 'days');
}

/** A linked product's name, or a placeholder when its record is missing. */
function productName(product: SupplierView['products'][number]): string {
  return product.name ?? 'Unknown product';
}

/** The products for a table cell: the first two names, then a count of the rest. */
function productsSummary(supplier: SupplierView): string | null {
  const names = supplier.products.map(productName);
  if (names.length === 0) return null;
  if (names.length <= 2) return names.join(', ');
  return `${names.slice(0, 2).join(', ')} +${names.length - 2} more`;
}

/** True when the search text matches the supplier's name, TIN, contacts or products. */
function matches(supplier: SupplierView, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  const digits = needle.replace(/[\s-]/g, '');
  return (
    supplier.name.toLocaleLowerCase().includes(needle) ||
    (digits !== '' && /^\d+$/.test(digits) && (supplier.tin ?? '').includes(digits)) ||
    supplier.contacts.some((contact) => contact.name.toLocaleLowerCase().includes(needle)) ||
    supplier.products.some((product) => productName(product).toLocaleLowerCase().includes(needle))
  );
}

const column = createDataTableColumns<SupplierView>();

const COLUMNS: DataTableColumn<SupplierView>[] = column.columns([
  column.accessor('name', {
    header: 'Name',
    sortFn: 'text',
    cell: (info) => (
      <span className="flex min-w-40 items-center gap-2">
        <span className="font-medium">{info.getValue()}</span>
        {info.row.original.retiredAt ? <Badge>Retired</Badge> : null}
      </span>
    ),
  }),
  column.accessor((supplier) => SUPPLIER_TYPE_LABELS[supplier.supplierType], {
    id: 'supplierType',
    header: 'Type',
    sortFn: 'text',
    cell: (info) => <span className="whitespace-nowrap">{info.getValue()}</span>,
    meta: { width: '10rem' },
  }),
  column.accessor((supplier) => supplier.tinDisplay ?? '', {
    id: 'tin',
    header: 'TIN',
    sortFn: 'text',
    cell: (info) =>
      info.getValue() ? (
        <span className="whitespace-nowrap numeric">{info.getValue()}</span>
      ) : (
        <span className="text-text-secondary">None</span>
      ),
    meta: { width: '12rem' },
  }),
  column.accessor((supplier) => supplier.paymentTermsDays ?? -1, {
    id: 'paymentTerms',
    header: 'Payment terms',
    sortFn: 'basic',
    cell: (info) => {
      const label = termsLabel(info.row.original.paymentTermsDays);
      return label ? (
        <span className="whitespace-nowrap">{label}</span>
      ) : (
        <span className="text-text-secondary">Not set</span>
      );
    },
    meta: { align: 'end', width: '9rem' },
  }),
  column.accessor((supplier) => productsSummary(supplier) ?? '', {
    id: 'products',
    header: 'Products',
    sortFn: 'text',
    cell: (info) =>
      info.getValue() ? (
        <span className="line-clamp-2">{info.getValue()}</span>
      ) : (
        <span className="text-text-secondary">None</span>
      ),
  }),
]);

function SupplierPhoneRow({ supplier }: { supplier: SupplierView }) {
  const terms = termsLabel(supplier.paymentTermsDays);
  return (
    <>
      <IconTile className="size-11 rounded-xl [&_svg]:size-5">
        <Truck strokeWidth={1.75} />
      </IconTile>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-subheadline font-semibold">{supplier.name}</span>
          {supplier.retiredAt ? <Badge>Retired</Badge> : null}
        </span>
        <span className="truncate text-footnote text-text-secondary">
          {SUPPLIER_TYPE_LABELS[supplier.supplierType]}
          {supplier.tinDisplay ? (
            <>
              {' · TIN '}
              <span className="numeric">{supplier.tinDisplay}</span>
            </>
          ) : null}
        </span>
        <span className="truncate text-footnote text-text-secondary numeric">
          {plural(supplier.products.length, 'product', 'products')}
          {terms ? ` · ${terms}` : null}
        </span>
      </span>
    </>
  );
}

export function SuppliersManager({
  suppliers,
  products,
  showRetired,
}: {
  suppliers: SupplierView[];
  /** The live products, for the "Products supplied" checkboxes. */
  products: BrandOption[];
  showRetired: boolean;
}) {
  const router = useRouter();
  const returnFocus = useReturnFocus();
  const searchId = useId();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  // Kept while the sheet closes, so its content doesn't change during the animation.
  const [target, setTarget] = useState<SupplierView | null>(null);
  // A new form (fresh fields and errors) every time the sheet opens.
  const [session, setSession] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  function openSheet(supplier: SupplierView | null, trigger?: HTMLElement | null) {
    returnFocus.remember(trigger);
    setTarget(supplier);
    setSession((count) => count + 1);
    setNotice(null);
    setOpen(true);
  }

  function finished(message: string) {
    setOpen(false);
    setNotice(message);
    router.refresh();
  }

  const shown = useMemo(
    () => suppliers.filter((supplier) => matches(supplier, query)),
    [suppliers, query],
  );
  const retiredCount = suppliers.filter((supplier) => supplier.retiredAt).length;
  const liveCount = suppliers.length - retiredCount;

  return (
    <>
      <PageHeader
        title="Suppliers"
        description="The companies Xtreme Works buys from, their contacts and the products they supply."
        actions={
          <Button onClick={(event) => openSheet(null, event.currentTarget)}>
            <Plus aria-hidden="true" className="size-5" />
            Add supplier
          </Button>
        }
      />
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <div className="flex w-full flex-col gap-1.5 sm:w-72">
          <label htmlFor={searchId} className="text-footnote font-semibold text-text-secondary">
            Search
          </label>
          <div className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 size-4.5 -translate-y-1/2 text-text-secondary"
            />
            <Input
              id={searchId}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Name, TIN, contact or product"
              autoComplete="off"
              spellCheck={false}
              maxLength={100}
              className="pl-10"
            />
          </div>
        </div>
        <ShowRetiredSwitch checked={showRetired} />
      </div>
      <p role="status" className="-mt-2 text-footnote text-text-secondary">
        {notice ? (
          <span className="inline-flex items-center gap-1.5 font-medium text-success-text">
            <CircleCheck aria-hidden="true" className="size-4 shrink-0" />
            {notice}
          </span>
        ) : (
          <span className="numeric">
            {query.trim()
              ? `${shown.length} of ${plural(suppliers.length, 'supplier', 'suppliers')}`
              : plural(liveCount, 'supplier', 'suppliers')}
            {showRetired && !query.trim() ? `, ${retiredCount} retired` : null}
          </span>
        )}
      </p>
      {suppliers.length === 0 ? (
        <EmptyState
          icon={<Truck strokeWidth={1.75} />}
          title={showRetired ? 'No suppliers' : 'No suppliers yet'}
          description="Add the distributors, brand principals and subcontractors Xtreme Works buys from."
          action={
            <Button variant="tinted" onClick={(event) => openSheet(null, event.currentTarget)}>
              <Plus aria-hidden="true" className="size-5" />
              Add supplier
            </Button>
          }
        />
      ) : shown.length === 0 ? (
        <EmptyState
          icon={<Search strokeWidth={1.75} />}
          title="No suppliers match"
          description="Try another name, TIN, contact or product."
          action={
            <Button variant="tinted" onClick={() => setQuery('')}>
              Clear search
            </Button>
          }
        />
      ) : (
        <DataTable
          caption="Suppliers"
          captionHidden
          columns={COLUMNS}
          data={shown}
          getRowId={(supplier) => supplier.id}
          initialSorting={[{ id: 'name', desc: false }]}
          selectedRowId={open ? target?.id : null}
          rowActionLabel={(supplier) =>
            supplier.retiredAt ? `Details for ${supplier.name}` : `Edit ${supplier.name}`
          }
          onRowSelect={(supplier, element) => openSheet(supplier, element)}
          renderPhoneRow={(supplier) => <SupplierPhoneRow supplier={supplier} />}
        />
      )}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent aria-describedby={undefined} onCloseAutoFocus={returnFocus.onCloseAutoFocus}>
          {target?.retiredAt ? (
            <RetiredSupplier
              key={session}
              supplier={target}
              onRestored={() => finished(`${target.name} restored.`)}
            />
          ) : (
            <SupplierForm
              key={session}
              supplier={target}
              products={products}
              onSaved={(name) => finished(target ? `${name} saved.` : `${name} added.`)}
              onRetired={(name) => finished(`${name} retired.`)}
            />
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

function SupplierSheetIcon() {
  return (
    <IconTile className="size-11 rounded-xl [&_svg]:size-5">
      <Truck strokeWidth={1.75} />
    </IconTile>
  );
}

/** A product checkbox row: live products, plus linked ones retired since (shown "Retired"). */
interface ProductChoice {
  id: string;
  name: string;
  retired: boolean;
}

/** Add or edit: details, contacts and products supplied. */
function SupplierForm({
  supplier,
  products,
  onSaved,
  onRetired,
}: {
  supplier: SupplierView | null;
  products: BrandOption[];
  onSaved: (name: string) => void;
  onRetired: (name: string) => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const nameRef = useRef('');
  const [supplierType, setSupplierType] = useState<SupplierType>(
    supplier?.supplierType ?? DEFAULT_SUPPLIER_TYPE,
  );
  const [contacts, setContacts] = useState<ContactRow[]>(() =>
    (supplier?.contacts ?? []).map((contact, index) => ({
      key: index + 1,
      name: contact.name,
      position: contact.position ?? '',
      email: contact.email ?? '',
      mobile: contact.mobile ?? '',
    })),
  );
  const [brandIds, setBrandIds] = useState<string[]>(
    () => supplier?.products.map((product) => product.id) ?? [],
  );
  const save = useActionSubmit<unknown>(
    supplier ? updateSupplierAction : createSupplierAction,
    () => onSaved(nameRef.current),
  );

  // The live products by name, then any linked product retired since (kept until unticked).
  const choices: ProductChoice[] = useMemo(() => {
    const live = new Set(products.map((product) => product.id));
    const retiredLinked = (supplier?.products ?? [])
      .filter((product) => !live.has(product.id))
      .map((product) => ({ id: product.id, name: productName(product), retired: true }));
    return [...products.map((product) => ({ ...product, retired: false })), ...retiredLinked];
  }, [products, supplier]);

  useShortcut(SUBMIT, () => submitFormFromShortcut(formRef.current), { scope: formRef });

  function toggleProduct(id: string, checked: boolean) {
    setBrandIds((current) =>
      checked ? [...current, id] : current.filter((brandId) => brandId !== id),
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const text = (key: string) => String(data.get(key) ?? '');
    nameRef.current = text('name').trim();
    const ok = await save.run({
      ...(supplier ? { id: supplier.id } : {}),
      name: text('name'),
      tin: text('tin'),
      address: text('address'),
      paymentTermsDays: text('paymentTermsDays'),
      supplierType,
      notes: text('notes'),
      contacts: contacts.map(({ name, position, email, mobile }) => ({
        name,
        position,
        email,
        mobile,
      })),
      brandIds,
    });
    if (!ok) {
      requestAnimationFrame(() => {
        form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
      });
    }
  }

  const productsError = save.fieldErrors.brandIds;
  const contactsError = save.fieldErrors.contacts;
  const productsErrorId = useId();
  const contactsTitleId = useId();

  return (
    <form
      ref={formRef}
      noValidate
      onSubmit={(event) => void submit(event)}
      className="flex min-h-0 flex-1 flex-col"
    >
      <SheetHeader
        title={supplier ? supplier.name : 'Add supplier'}
        leading={<SupplierSheetIcon />}
      />
      <SheetBody>
        <FormAlert message={save.formError ?? contactsError ?? null} />
        <FormSection title="Supplier">
          <FormField label="Name" required error={save.fieldErrors.name}>
            <Input
              name="name"
              defaultValue={supplier?.name ?? ''}
              maxLength={MASTER_NAME_MAX_LENGTH}
              autoComplete="off"
              autoFocus={!supplier}
              required
            />
          </FormField>
          <FormField label="Supplier type" error={save.fieldErrors.supplierType}>
            <Select
              value={supplierType}
              onChange={(event) => setSupplierType(event.target.value as SupplierType)}
            >
              {SUPPLIER_TYPES.map((type) => (
                <option key={type} value={type}>
                  {SUPPLIER_TYPE_LABELS[type]}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="TIN" hint={`Optional. ${TIN_HELP}`} error={save.fieldErrors.tin}>
            <Input
              name="tin"
              defaultValue={supplier?.tinDisplay ?? ''}
              inputMode="numeric"
              maxLength={30}
              autoComplete="off"
              spellCheck={false}
              className="numeric sm:max-w-60"
            />
          </FormField>
          <FormField
            label="Payment terms (days)"
            hint={`Optional. A whole number of days from 0 to ${TERMS_DAYS_MAX}.`}
            error={save.fieldErrors.paymentTermsDays}
          >
            <Input
              name="paymentTermsDays"
              type="number"
              inputMode="numeric"
              min={0}
              max={TERMS_DAYS_MAX}
              step={1}
              defaultValue={supplier?.paymentTermsDays ?? ''}
              className="tabular-nums sm:max-w-40"
            />
          </FormField>
          <FormField label="Address" error={save.fieldErrors.address}>
            <Textarea
              name="address"
              defaultValue={supplier?.address ?? ''}
              maxLength={ADDRESS_MAX_LENGTH}
              autoComplete="off"
            />
          </FormField>
          <FormField label="Notes" error={save.fieldErrors.notes}>
            <Textarea
              name="notes"
              defaultValue={supplier?.notes ?? ''}
              maxLength={NOTES_MAX_LENGTH}
            />
          </FormField>
        </FormSection>
        <section aria-labelledby={contactsTitleId} className="flex flex-col gap-2">
          <h3 id={contactsTitleId} className="px-4 text-footnote font-semibold text-text-secondary">
            Contacts
          </h3>
          <SupplierContactsFields
            rows={contacts}
            onChange={setContacts}
            errors={save.fieldErrors}
            onRowsRemoved={save.reset}
          />
        </section>
        <FormSection
          title="Products supplied"
          footer={
            choices.length === 0
              ? undefined
              : 'Optional. Retired products can’t be picked; one already linked stays until you untick it.'
          }
        >
          {choices.length === 0 ? (
            <p className="px-4 py-3 text-subheadline text-text-secondary">
              No live products. Add products on the Products page first.
            </p>
          ) : (
            <fieldset
              aria-describedby={productsError ? productsErrorId : undefined}
              aria-invalid={productsError ? true : undefined}
              className="flex min-w-0 flex-col divide-y divide-separator"
            >
              <legend className="sr-only">Products supplied</legend>
              {choices.map((choice) => (
                <label
                  key={choice.id}
                  className="flex min-h-12 cursor-pointer items-center gap-3 px-4 py-2"
                >
                  <input
                    type="checkbox"
                    checked={brandIds.includes(choice.id)}
                    onChange={(event) => toggleProduct(choice.id, event.target.checked)}
                    aria-invalid={productsError ? true : undefined}
                    className="size-5 shrink-0 cursor-pointer accent-accent"
                  />
                  <span className="min-w-0 flex-1 text-body md:text-subheadline">
                    {choice.name}
                  </span>
                  {choice.retired ? <Badge>Retired</Badge> : null}
                </label>
              ))}
            </fieldset>
          )}
        </FormSection>
        <div aria-live="polite" className="-mt-4 empty:hidden">
          {productsError ? (
            <p
              id={productsErrorId}
              className="px-4 text-footnote font-medium text-destructive-text"
            >
              {productsError}
            </p>
          ) : null}
        </div>
      </SheetBody>
      <SheetFooter>
        {supplier ? <RetireSupplierButton supplier={supplier} onRetired={onRetired} /> : null}
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
          {supplier ? 'Save' : 'Add supplier'}
          <ShortcutHint keys={SUBMIT} tone="on-fill" className="hidden sm:inline-flex" />
        </Button>
      </SheetFooter>
    </form>
  );
}

/** Retire, after the destructive confirmation. A refused retire is shown in the dialog. */
function RetireSupplierButton({
  supplier,
  onRetired,
}: {
  supplier: SupplierView;
  onRetired: (name: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const retire = useActionSubmit(retireSupplierAction, () => onRetired(supplier.name));

  return (
    <>
      <Button
        variant="plain"
        onClick={() => {
          retire.reset();
          setConfirming(true);
        }}
        className="mr-auto text-destructive-text hover:bg-bg-grouped hover:text-destructive-text"
      >
        Retire
      </Button>
      <DestructiveConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Retire ${supplier.name}?`}
        description="It can’t be picked for new records, and its name stays reserved. You can restore it later from “Show retired”."
        confirmLabel="Retire supplier"
        error={retire.formError}
        onConfirm={async () => {
          const ok = await retire.run({ id: supplier.id });
          // Keeps the dialog open, showing why, when the retire was refused.
          if (!ok) throw new Error('Retire refused');
        }}
      />
    </>
  );
}

/** A retired supplier: its details, and Restore. */
function RetiredSupplier({
  supplier,
  onRestored,
}: {
  supplier: SupplierView;
  onRestored: () => void;
}) {
  const restore = useActionSubmit(restoreSupplierAction, onRestored);
  const terms = termsLabel(supplier.paymentTermsDays);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SheetHeader title={supplier.name} leading={<SupplierSheetIcon />} />
      <SheetBody>
        <FormAlert message={restore.formError} />
        <FormSection
          title="Supplier"
          footer={
            supplier.retiredAt
              ? `Retired on ${formatDate(supplier.retiredAt)}. Restore it to edit it or pick it again.`
              : undefined
          }
        >
          <ReadOnlyField label="Name">{supplier.name}</ReadOnlyField>
          <ReadOnlyField label="Supplier type">
            {SUPPLIER_TYPE_LABELS[supplier.supplierType]}
          </ReadOnlyField>
          <ReadOnlyField label="TIN">
            <span className="numeric">{supplier.tinDisplay ?? 'None'}</span>
          </ReadOnlyField>
          <ReadOnlyField label="Payment terms">{terms ?? 'Not set'}</ReadOnlyField>
          <ReadOnlyField label="Address">
            <span className="whitespace-pre-line">{supplier.address ?? 'None'}</span>
          </ReadOnlyField>
          <ReadOnlyField label="Notes">
            <span className="whitespace-pre-line">{supplier.notes ?? 'None'}</span>
          </ReadOnlyField>
        </FormSection>
        <FormSection title="Contacts">
          {supplier.contacts.length === 0 ? (
            <p className="px-4 py-3 text-subheadline text-text-secondary">No contacts.</p>
          ) : (
            supplier.contacts.map((contact, index) => (
              <div key={index} className="flex flex-col gap-0.5 px-4 py-3">
                <span className="text-subheadline font-medium text-text-primary">
                  {contact.name}
                </span>
                {contact.position ? (
                  <span className="text-footnote text-text-secondary">{contact.position}</span>
                ) : null}
                {contact.email || contact.mobile ? (
                  <span className="text-footnote break-all text-text-secondary">
                    {[contact.email, contact.mobile].filter(Boolean).join(' · ')}
                  </span>
                ) : null}
              </div>
            ))
          )}
        </FormSection>
        <FormSection title="Products supplied">
          {supplier.products.length === 0 ? (
            <p className="px-4 py-3 text-subheadline text-text-secondary">No products.</p>
          ) : (
            supplier.products.map((product) => (
              <div key={product.id} className="flex min-h-11 items-center gap-2 px-4 py-2">
                <span className="min-w-0 flex-1 text-subheadline text-text-primary">
                  {productName(product)}
                </span>
                {product.retired ? <Badge>Retired</Badge> : null}
              </div>
            ))
          )}
        </FormSection>
      </SheetBody>
      <SheetFooter>
        <SheetClose asChild>
          <Button variant="secondary" className="pr-3">
            Close
            <ShortcutHint keys={['escape']} className="hidden sm:inline-flex" />
          </Button>
        </SheetClose>
        <Button loading={restore.pending} onClick={() => void restore.run({ id: supplier.id })}>
          Restore supplier
        </Button>
      </SheetFooter>
    </div>
  );
}
