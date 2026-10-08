'use client';

import { useId, useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Boxes, CircleCheck, Plus, Search, Tag } from 'lucide-react';
import {
  DEFAULT_WARRANTY_MONTHS,
  formatDate,
  ITEM_DESCRIPTION_MAX_LENGTH,
  ITEM_KIND_LABELS,
  ITEM_KINDS,
  type ItemKind,
  NON_STOCK_WARRANTY_MONTHS,
  PART_NUMBER_MAX_LENGTH,
  UNIT_MAX_LENGTH,
  UNIT_SUGGESTIONS,
  WARRANTY_MONTHS_MAX,
} from '@pulse/core';
import type { CatalogItemView } from '@pulse/core/server';
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
import { SegmentedControl } from '@pulse/ui/components/segmented-control';
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
  createCatalogItemAction,
  restoreCatalogItemAction,
  retireCatalogItemAction,
  updateCatalogItemAction,
} from '@/lib/actions/catalog-items';

// Spec: docs/modules/core.md#managing-master-data and docs/modules/supply.md#stock — the catalog
// items list, filtered by product (from the URL) and by a search on part number or description (on
// the loaded list). A row opens its sheet: the edit form for a live item (part number, description,
// unit and default warranty; the product and item kind are fixed), or its details and Restore for a
// retired one. An item is added only under a live product; choosing non-stock sets the default
// warranty to 0, which can still be changed.

/** A product in the filter and the add form. */
export interface ProductOption {
  id: string;
  name: string;
  retired: boolean;
}

const SUBMIT = ['mod', 'enter'] as const;

const KIND_SEGMENTS = ITEM_KINDS.map((value) => ({ value, label: ITEM_KIND_LABELS[value] }));

/** The default warranty the form proposes for an item kind (non-stock: none). */
function defaultWarrantyFor(kind: ItemKind): number {
  return kind === 'nonStock' ? NON_STOCK_WARRANTY_MONTHS : DEFAULT_WARRANTY_MONTHS;
}

function productLabel(item: CatalogItemView): string {
  return item.brandName ?? 'Unknown product';
}

function warrantyLabel(months: number): string {
  return plural(months, 'month', 'months');
}

/** True when the item's part number or description contains the search (already lowercased). */
function matches(item: CatalogItemView, search: string): boolean {
  return (
    item.partNumber.toLocaleLowerCase().includes(search) ||
    item.description.toLocaleLowerCase().includes(search)
  );
}

const column = createDataTableColumns<CatalogItemView>();

const COLUMNS: DataTableColumn<CatalogItemView>[] = column.columns([
  column.accessor((item) => productLabel(item), {
    id: 'product',
    header: 'Product',
    sortFn: 'text',
    cell: (info) => (
      <span className="flex items-center gap-2">
        <span className="whitespace-nowrap">{info.getValue()}</span>
        {info.row.original.brandRetired ? <Badge>Retired</Badge> : null}
      </span>
    ),
  }),
  column.accessor('partNumber', {
    header: 'Part number',
    sortFn: 'text',
    cell: (info) => (
      <span className="flex items-center gap-2">
        <span className="font-medium whitespace-nowrap">{info.getValue()}</span>
        {info.row.original.retiredAt ? <Badge>Retired</Badge> : null}
      </span>
    ),
  }),
  column.accessor('description', {
    header: 'Description',
    sortFn: 'text',
    cell: (info) => (
      <span className="line-clamp-2 min-w-48" title={info.getValue()}>
        {info.getValue()}
      </span>
    ),
  }),
  column.accessor('unit', {
    header: 'Unit',
    sortFn: 'text',
    meta: { width: '6rem' },
  }),
  column.accessor('itemKind', {
    header: 'Kind',
    sortFn: 'text',
    cell: (info) => <Badge>{ITEM_KIND_LABELS[info.row.original.itemKind]}</Badge>,
    meta: { width: '8rem' },
  }),
  column.accessor('defaultWarrantyMonths', {
    header: 'Warranty (months)',
    sortFn: 'basic',
    meta: { align: 'end', width: '10rem' },
  }),
]);

function CatalogItemPhoneRow({ item }: { item: CatalogItemView }) {
  return (
    <>
      <IconTile className="size-11 rounded-xl [&_svg]:size-5">
        <Boxes strokeWidth={1.75} />
      </IconTile>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-subheadline font-semibold">{item.partNumber}</span>
          {item.retiredAt ? <Badge>Retired</Badge> : null}
        </span>
        <span className="truncate text-footnote text-text-secondary">
          {productLabel(item)}
          {item.brandRetired ? ' (retired)' : null}
        </span>
        <span className="truncate text-footnote text-text-secondary">{item.description}</span>
        <span className="flex items-center gap-2 text-footnote text-text-secondary">
          <Badge>{ITEM_KIND_LABELS[item.itemKind]}</Badge>
          <span className="numeric">
            {item.unit} · {warrantyLabel(item.defaultWarrantyMonths)} warranty
          </span>
        </span>
      </span>
    </>
  );
}

export function CatalogItemsManager({
  items,
  products,
  productId,
  showRetired,
}: {
  items: CatalogItemView[];
  products: ProductOption[];
  /** The product filter, from the URL. */
  productId: string | null;
  showRetired: boolean;
}) {
  const router = useRouter();
  const returnFocus = useReturnFocus();
  const [open, setOpen] = useState(false);
  // Kept while the sheet closes, so its content doesn't change during the animation.
  const [target, setTarget] = useState<CatalogItemView | null>(null);
  // A new form (fresh fields and errors) every time the sheet opens.
  const [session, setSession] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filtering, startFiltering] = useTransition();
  const searchId = useId();
  const filterId = useId();

  const liveProducts = products.filter((product) => !product.retired);
  const filterProduct = productId
    ? (products.find((product) => product.id === productId) ?? null)
    : null;
  // The filter lists live products, and retired ones while they are shown (or picked).
  const filterOptions = products.filter(
    (product) => !product.retired || showRetired || product.id === productId,
  );
  const canAdd = liveProducts.length > 0;

  const search = query.trim().toLocaleLowerCase();
  const shown = useMemo(
    () => (search ? items.filter((item) => matches(item, search)) : items),
    [items, search],
  );

  function openSheet(item: CatalogItemView | null, trigger?: HTMLElement | null) {
    returnFocus.remember(trigger);
    setTarget(item);
    setSession((count) => count + 1);
    setNotice(null);
    setOpen(true);
  }

  function finished(message: string) {
    setOpen(false);
    setNotice(message);
    router.refresh();
  }

  function filterBy(id: string) {
    const params = new URLSearchParams(window.location.search);
    if (id) params.set('product', id);
    else params.delete('product');
    const queryString = params.toString();
    startFiltering(() => {
      router.replace(`/admin/catalog-items${queryString ? `?${queryString}` : ''}`, {
        scroll: false,
      });
    });
  }

  const retiredCount = items.filter((item) => item.retiredAt).length;
  const liveCount = items.length - retiredCount;
  const addButton = (variant: 'primary' | 'tinted') => (
    <Button
      variant={variant}
      disabled={!canAdd}
      onClick={(event) => openSheet(null, event.currentTarget)}
    >
      <Plus aria-hidden="true" className="size-5" />
      Add catalog item
    </Button>
  );

  return (
    <>
      <PageHeader
        title="Catalog items"
        description="The part numbers under each product, with their unit, item kind and default warranty."
        actions={canAdd ? addButton('primary') : undefined}
      />
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
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
                placeholder="Part number or description"
                autoComplete="off"
                spellCheck={false}
                maxLength={100}
                className="pl-10"
              />
            </div>
          </div>
          <div className="flex w-full flex-col gap-1.5 sm:w-64">
            <label htmlFor={filterId} className="text-footnote font-semibold text-text-secondary">
              Product
            </label>
            <Select
              id={filterId}
              value={productId ?? ''}
              onChange={(event) => filterBy(event.target.value)}
              disabled={filtering}
              aria-busy={filtering || undefined}
            >
              <option value="">All products</option>
              {filterProduct === null && productId ? (
                <option value={productId}>Unknown product</option>
              ) : null}
              {filterOptions.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name}
                  {product.retired ? ', retired' : ''}
                </option>
              ))}
            </Select>
          </div>
          <ShowRetiredSwitch checked={showRetired} className="sm:ml-auto" />
        </div>
        <p role="status" className="text-footnote text-text-secondary">
          {notice ? (
            <span className="inline-flex items-center gap-1.5 font-medium text-success-text">
              <CircleCheck aria-hidden="true" className="size-4 shrink-0" />
              {notice}
            </span>
          ) : (
            <span className="numeric">
              {search ? `${shown.length} of ` : null}
              {plural(liveCount, 'catalog item', 'catalog items')}
              {showRetired ? `, ${retiredCount} retired` : null}
            </span>
          )}
        </p>
      </div>
      {shown.length > 0 ? (
        <DataTable
          caption="Catalog items"
          captionHidden
          columns={COLUMNS}
          data={shown}
          getRowId={(item) => item.id}
          selectedRowId={open ? target?.id : null}
          rowActionLabel={(item) =>
            item.retiredAt
              ? `Details for ${productLabel(item)} ${item.partNumber}`
              : `Edit ${productLabel(item)} ${item.partNumber}`
          }
          onRowSelect={(item, element) => openSheet(item, element)}
          renderPhoneRow={(item) => <CatalogItemPhoneRow item={item} />}
          loading={filtering}
        />
      ) : search ? (
        <EmptyState
          icon={<Search strokeWidth={1.75} />}
          title="No catalog items match"
          description={
            showRetired
              ? 'Try another part number or description.'
              : 'Try another part number or description, or turn on “Show retired”.'
          }
          action={
            <Button variant="tinted" onClick={() => setQuery('')}>
              Clear search
            </Button>
          }
        />
      ) : !canAdd && !productId ? (
        <EmptyState
          icon={<Tag strokeWidth={1.75} />}
          title="Add a product first"
          description="Every catalog item belongs to a product. Add the products, then come back to add their items."
          action={
            <Button asChild variant="tinted">
              <Link href="/admin/products">Go to products</Link>
            </Button>
          }
        />
      ) : productId ? (
        <EmptyState
          icon={<Boxes strokeWidth={1.75} />}
          title={
            filterProduct ? `No catalog items under ${filterProduct.name}` : 'No catalog items here'
          }
          description={
            filterProduct && !filterProduct.retired
              ? 'Add one with “Add catalog item”, or show all products.'
              : 'Show all products to see the other catalog items.'
          }
          action={
            <Button variant="tinted" onClick={() => filterBy('')}>
              Show all products
            </Button>
          }
        />
      ) : (
        <EmptyState
          icon={<Boxes strokeWidth={1.75} />}
          title="No catalog items yet"
          description="Add the part numbers the company buys and sells, under their product."
          action={addButton('tinted')}
        />
      )}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent aria-describedby={undefined} onCloseAutoFocus={returnFocus.onCloseAutoFocus}>
          {target?.retiredAt ? (
            <RetiredCatalogItem
              key={session}
              item={target}
              onRestored={() => finished(`${target.partNumber} restored.`)}
            />
          ) : (
            <CatalogItemForm
              key={session}
              item={target}
              products={liveProducts}
              defaultProductId={filterProduct && !filterProduct.retired ? filterProduct.id : ''}
              onSaved={(partNumber) =>
                finished(target ? `${partNumber} saved.` : `${partNumber} added.`)
              }
              onRetired={(partNumber) => finished(`${partNumber} retired.`)}
            />
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

/** Add or edit: product and item kind (both fixed once added), part number, description, unit and warranty. */
function CatalogItemForm({
  item,
  products,
  defaultProductId,
  onSaved,
  onRetired,
}: {
  item: CatalogItemView | null;
  /** Live products, for a new item. */
  products: ProductOption[];
  defaultProductId: string;
  onSaved: (partNumber: string) => void;
  onRetired: (partNumber: string) => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const partNumberRef = useRef('');
  const unitListId = useId();
  const [itemKind, setItemKind] = useState<ItemKind>(item?.itemKind ?? 'serialized');
  const [warranty, setWarranty] = useState(
    String(item?.defaultWarrantyMonths ?? DEFAULT_WARRANTY_MONTHS),
  );
  // Until the warranty is typed in, it follows the item kind's default.
  const [warrantyEdited, setWarrantyEdited] = useState(false);
  const save = useActionSubmit<unknown>(
    item ? updateCatalogItemAction : createCatalogItemAction,
    () => onSaved(partNumberRef.current),
  );

  useShortcut(SUBMIT, () => submitFormFromShortcut(formRef.current), { scope: formRef });

  function chooseKind(next: ItemKind) {
    setItemKind(next);
    // Choosing non-stock sets the warranty to 0 (still editable); docs/modules/supply.md#stock.
    if (next === 'nonStock' || !warrantyEdited) setWarranty(String(defaultWarrantyFor(next)));
  }

  return (
    <form
      ref={formRef}
      noValidate
      onSubmit={(event) => {
        partNumberRef.current = String(
          new FormData(event.currentTarget).get('partNumber') ?? '',
        ).trim();
        void save.onSubmit(event);
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <SheetHeader
        title={item ? item.partNumber : 'Add catalog item'}
        leading={
          <IconTile className="size-11 rounded-xl [&_svg]:size-5">
            <Boxes strokeWidth={1.75} />
          </IconTile>
        }
      />
      <SheetBody>
        {item ? <input type="hidden" name="id" value={item.id} /> : null}
        {item ? null : <input type="hidden" name="itemKind" value={itemKind} />}
        <FormAlert message={save.formError} />
        <FormSection title="Catalog item">
          {item ? (
            <ReadOnlyField
              label="Product"
              hint="A catalog item’s product can’t be changed. To move it, add a new item under the other product."
            >
              <span className="flex flex-wrap items-center gap-2">
                {productLabel(item)}
                {item.brandRetired ? <Badge>Retired</Badge> : null}
              </span>
            </ReadOnlyField>
          ) : (
            <FormField
              label="Product"
              required
              hint="It can’t be changed once the item is added."
              error={save.fieldErrors.brandId}
            >
              <Select
                name="brandId"
                defaultValue={defaultProductId}
                autoFocus={defaultProductId === ''}
                required
              >
                <option value="" disabled>
                  Choose a product
                </option>
                {products.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.name}
                  </option>
                ))}
              </Select>
            </FormField>
          )}
          <FormField
            label="Part number"
            required
            hint="Unique within its product, retired items included."
            error={save.fieldErrors.partNumber}
          >
            <Input
              name="partNumber"
              defaultValue={item?.partNumber ?? ''}
              maxLength={PART_NUMBER_MAX_LENGTH}
              autoComplete="off"
              spellCheck={false}
              autoFocus={!item && defaultProductId !== ''}
              required
            />
          </FormField>
          <FormField label="Description" required error={save.fieldErrors.description}>
            <Textarea
              name="description"
              defaultValue={item?.description ?? ''}
              maxLength={ITEM_DESCRIPTION_MAX_LENGTH}
              required
            />
          </FormField>
          <FormField
            label="Unit"
            required
            hint="For example pc, set or license."
            error={save.fieldErrors.unit}
          >
            <Input
              name="unit"
              defaultValue={item?.unit ?? ''}
              maxLength={UNIT_MAX_LENGTH}
              list={unitListId}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              required
            />
          </FormField>
          <datalist id={unitListId}>
            {UNIT_SUGGESTIONS.map((unit) => (
              <option key={unit} value={unit} />
            ))}
          </datalist>
        </FormSection>
        <FormSection
          title="Item kind"
          footer={
            item
              ? 'The item kind can’t be changed. To change it, add a new item.'
              : 'Serialized items are tracked by serial number, bulk items by quantity. Non-stock items (services and licenses) never go into stock. It can’t be changed once the item is added.'
          }
        >
          {item ? (
            <ReadOnlyField label="Item kind">{ITEM_KIND_LABELS[item.itemKind]}</ReadOnlyField>
          ) : (
            <div className="flex flex-col gap-1.5 px-4 py-3">
              <SegmentedControl
                label="Item kind"
                options={KIND_SEGMENTS}
                value={itemKind}
                onValueChange={chooseKind}
                tone="accent"
                fullWidth
              />
              {save.fieldErrors.itemKind ? (
                <p className="text-footnote font-medium text-destructive-text" role="alert">
                  {save.fieldErrors.itemKind}
                </p>
              ) : null}
            </div>
          )}
        </FormSection>
        <FormSection title="Warranty">
          <FormField
            label="Default warranty (months)"
            hint={`A whole number from 0 to ${WARRANTY_MONTHS_MAX}. Each project’s warranty starts from it, and can be changed there.`}
            error={save.fieldErrors.defaultWarrantyMonths}
          >
            <Input
              name="defaultWarrantyMonths"
              type="number"
              inputMode="numeric"
              min={0}
              max={WARRANTY_MONTHS_MAX}
              step={1}
              value={warranty}
              onChange={(event) => {
                setWarranty(event.target.value);
                setWarrantyEdited(true);
              }}
              className="numeric"
            />
          </FormField>
        </FormSection>
      </SheetBody>
      <SheetFooter>
        {item ? <RetireCatalogItemButton item={item} onRetired={onRetired} /> : null}
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
          {item ? 'Save' : 'Add catalog item'}
          <ShortcutHint keys={SUBMIT} tone="on-fill" className="hidden sm:inline-flex" />
        </Button>
      </SheetFooter>
    </form>
  );
}

/** Retire, after the destructive confirmation. A refused retire is shown in the dialog. */
function RetireCatalogItemButton({
  item,
  onRetired,
}: {
  item: CatalogItemView;
  onRetired: (partNumber: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const retire = useActionSubmit(retireCatalogItemAction, () => onRetired(item.partNumber));

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
        title={`Retire ${item.partNumber}?`}
        description="It can’t be picked for new records, and its part number stays taken under this product. Records that already use it keep it. You can restore it later from “Show retired”."
        confirmLabel="Retire catalog item"
        error={retire.formError}
        onConfirm={async () => {
          const ok = await retire.run({ id: item.id });
          // Keeps the dialog open, showing why, when the retire was refused.
          if (!ok) throw new Error('Retire refused');
        }}
      />
    </>
  );
}

/** A retired catalog item: its details, and Restore. */
function RetiredCatalogItem({
  item,
  onRestored,
}: {
  item: CatalogItemView;
  onRestored: () => void;
}) {
  const restore = useActionSubmit(restoreCatalogItemAction, onRestored);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SheetHeader
        title={item.partNumber}
        leading={
          <IconTile className="size-11 rounded-xl [&_svg]:size-5">
            <Boxes strokeWidth={1.75} />
          </IconTile>
        }
      />
      <SheetBody>
        <FormAlert message={restore.formError} />
        <FormSection
          title="Catalog item"
          footer={
            item.brandRetired
              ? 'Its product is retired. Restore the product first, then this item.'
              : item.retiredAt
                ? `Retired on ${formatDate(item.retiredAt)}. Restore it to edit it or pick it again.`
                : undefined
          }
        >
          <ReadOnlyField label="Product">
            <span className="flex flex-wrap items-center gap-2">
              {productLabel(item)}
              {item.brandRetired ? <Badge>Retired</Badge> : null}
            </span>
          </ReadOnlyField>
          <ReadOnlyField label="Part number">{item.partNumber}</ReadOnlyField>
          <ReadOnlyField label="Description">
            <span className="whitespace-pre-line">{item.description}</span>
          </ReadOnlyField>
          <ReadOnlyField label="Unit">{item.unit}</ReadOnlyField>
          <ReadOnlyField label="Item kind">{ITEM_KIND_LABELS[item.itemKind]}</ReadOnlyField>
          <ReadOnlyField label="Default warranty">
            <span className="numeric">{warrantyLabel(item.defaultWarrantyMonths)}</span>
          </ReadOnlyField>
        </FormSection>
      </SheetBody>
      <SheetFooter>
        <SheetClose asChild>
          <Button variant="secondary" className="pr-3">
            Close
            <ShortcutHint keys={['escape']} className="hidden sm:inline-flex" />
          </Button>
        </SheetClose>
        <Button loading={restore.pending} onClick={() => void restore.run({ id: item.id })}>
          Restore catalog item
        </Button>
      </SheetFooter>
    </div>
  );
}
