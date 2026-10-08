'use client';

import { useId, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronRight, CircleCheck, Plus, Search, Tag } from 'lucide-react';
import { formatDate, PRODUCT_NAME_MAX_LENGTH } from '@pulse/core';
import type { BrandView } from '@pulse/core/server';
import { Button } from '@pulse/ui/components/button';
import { DestructiveConfirmDialog } from '@pulse/ui/components/confirm-dialog';
import {
  createDataTableColumns,
  DataTable,
  type DataTableColumn,
} from '@pulse/ui/components/data-table';
import { EmptyState } from '@pulse/ui/components/empty-state';
import { FormField, FormSection, Input } from '@pulse/ui/components/form';
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
  createBrandAction,
  restoreBrandAction,
  retireBrandAction,
  updateBrandAction,
} from '@/lib/actions/brands';

// Spec: docs/modules/core.md#managing-master-data and docs/modules/engage.md#deals-and-stages — the
// products list (`brands` in code). A row opens its sheet: the rename form for a live product, or
// its details and Restore for a retired one. Retiring asks first, and is refused while the product
// still has live catalog items. Every product can be renamed or retired, the seeded ones and
// "General" included. The search filters the loaded list by name.

const SUBMIT = ['mod', 'enter'] as const;

/** The product's catalog items on /admin/catalog-items. */
function catalogItemsHref(product: BrandView): string {
  return `/admin/catalog-items?product=${encodeURIComponent(product.id)}`;
}

function itemCountLabel(count: number): string {
  return plural(count, 'live catalog item', 'live catalog items');
}

const column = createDataTableColumns<BrandView>();

const COLUMNS: DataTableColumn<BrandView>[] = column.columns([
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
  column.accessor('liveCatalogItemCount', {
    header: 'Catalog items',
    sortFn: 'basic',
    meta: { align: 'end', width: '10rem' },
  }),
]);

function ProductPhoneRow({ product }: { product: BrandView }) {
  return (
    <>
      <IconTile className="size-11 rounded-xl [&_svg]:size-5">
        <Tag strokeWidth={1.75} />
      </IconTile>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-subheadline font-semibold">{product.name}</span>
          {product.retiredAt ? <Badge>Retired</Badge> : null}
        </span>
        <span className="text-footnote text-text-secondary numeric">
          {itemCountLabel(product.liveCatalogItemCount)}
        </span>
      </span>
    </>
  );
}

export function ProductsManager({
  products,
  showRetired,
}: {
  products: BrandView[];
  showRetired: boolean;
}) {
  const router = useRouter();
  const returnFocus = useReturnFocus();
  const [open, setOpen] = useState(false);
  // Kept while the sheet closes, so its content doesn't change during the animation.
  const [target, setTarget] = useState<BrandView | null>(null);
  // A new form (fresh fields and errors) every time the sheet opens.
  const [session, setSession] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const searchId = useId();

  const search = query.trim().toLocaleLowerCase();
  const shown = useMemo(
    () =>
      search
        ? products.filter((product) => product.name.toLocaleLowerCase().includes(search))
        : products,
    [products, search],
  );

  function openSheet(product: BrandView | null, trigger?: HTMLElement | null) {
    returnFocus.remember(trigger);
    setTarget(product);
    setSession((count) => count + 1);
    setNotice(null);
    setOpen(true);
  }

  function finished(message: string) {
    setOpen(false);
    setNotice(message);
    router.refresh();
  }

  const retiredCount = products.filter((product) => product.retiredAt).length;
  const liveCount = products.length - retiredCount;
  const addButton = (variant: 'primary' | 'tinted') => (
    <Button variant={variant} onClick={(event) => openSheet(null, event.currentTarget)}>
      <Plus aria-hidden="true" className="size-5" />
      Add product
    </Button>
  );

  return (
    <>
      <PageHeader
        title="Products"
        description="The brands the company sells. Catalog items belong to a product."
        actions={addButton('primary')}
      />
      <div className="flex flex-col gap-3">
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
                placeholder="Product name"
                autoComplete="off"
                spellCheck={false}
                maxLength={100}
                className="pl-10"
              />
            </div>
          </div>
          <ShowRetiredSwitch checked={showRetired} />
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
              {plural(liveCount, 'product', 'products')}
              {showRetired ? `, ${retiredCount} retired` : null}
            </span>
          )}
        </p>
      </div>
      {shown.length > 0 ? (
        <DataTable
          caption="Products"
          captionHidden
          columns={COLUMNS}
          data={shown}
          getRowId={(product) => product.id}
          initialSorting={[{ id: 'name', desc: false }]}
          selectedRowId={open ? target?.id : null}
          rowActionLabel={(product) =>
            product.retiredAt ? `Details for ${product.name}` : `Edit ${product.name}`
          }
          onRowSelect={(product, element) => openSheet(product, element)}
          renderPhoneRow={(product) => <ProductPhoneRow product={product} />}
        />
      ) : search ? (
        <EmptyState
          icon={<Search strokeWidth={1.75} />}
          title="No products match"
          description={
            showRetired
              ? 'Try another name.'
              : 'Try another name, or turn on “Show retired” to search retired products too.'
          }
          action={
            <Button variant="tinted" onClick={() => setQuery('')}>
              Clear search
            </Button>
          }
        />
      ) : (
        <EmptyState
          icon={<Tag strokeWidth={1.75} />}
          title="No products yet"
          description="Add the brands the company sells. Catalog items, deals and stock refer to them."
          action={addButton('tinted')}
        />
      )}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent aria-describedby={undefined} onCloseAutoFocus={returnFocus.onCloseAutoFocus}>
          {target?.retiredAt ? (
            <RetiredProduct
              key={session}
              product={target}
              onRestored={() => finished(`${target.name} restored.`)}
            />
          ) : (
            <ProductForm
              key={session}
              product={target}
              onSaved={(name) => finished(target ? `${name} saved.` : `${name} added.`)}
              onRetired={(name) => finished(`${name} retired.`)}
            />
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

/** A link to the product's catalog items, shown in its sheet. */
function CatalogItemsLink({ product }: { product: BrandView }) {
  return (
    <Link
      href={catalogItemsHref(product)}
      className="flex min-h-11 items-center justify-between gap-3 px-4 py-3 text-body text-text-primary transition-colors duration-fast hover:bg-bg-grouped focus-visible:-outline-offset-2 md:text-subheadline"
    >
      <span className="numeric">{itemCountLabel(product.liveCatalogItemCount)}</span>
      <span className="inline-flex items-center gap-1 font-medium text-accent">
        View catalog items
        <ChevronRight aria-hidden="true" className="size-4" />
      </span>
    </Link>
  );
}

/** Add or rename a product. */
function ProductForm({
  product,
  onSaved,
  onRetired,
}: {
  product: BrandView | null;
  onSaved: (name: string) => void;
  onRetired: (name: string) => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const nameRef = useRef('');
  const save = useActionSubmit<unknown>(product ? updateBrandAction : createBrandAction, () =>
    onSaved(nameRef.current),
  );

  useShortcut(SUBMIT, () => submitFormFromShortcut(formRef.current), { scope: formRef });

  return (
    <form
      ref={formRef}
      noValidate
      onSubmit={(event) => {
        nameRef.current = String(new FormData(event.currentTarget).get('name') ?? '').trim();
        void save.onSubmit(event);
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <SheetHeader
        title={product ? product.name : 'Add product'}
        leading={
          <IconTile className="size-11 rounded-xl [&_svg]:size-5">
            <Tag strokeWidth={1.75} />
          </IconTile>
        }
      />
      <SheetBody>
        {product ? <input type="hidden" name="id" value={product.id} /> : null}
        <FormAlert message={save.formError} />
        <FormSection
          title="Product"
          footer="Names are unique, ignoring capitals, retired products included."
        >
          <FormField label="Name" required error={save.fieldErrors.name}>
            <Input
              name="name"
              defaultValue={product?.name ?? ''}
              maxLength={PRODUCT_NAME_MAX_LENGTH}
              autoComplete="off"
              autoFocus={!product}
              required
            />
          </FormField>
        </FormSection>
        {product ? (
          <FormSection
            title="Catalog items"
            footer="A product can’t be retired while it has live catalog items."
          >
            <CatalogItemsLink product={product} />
          </FormSection>
        ) : null}
      </SheetBody>
      <SheetFooter>
        {product ? <RetireProductButton product={product} onRetired={onRetired} /> : null}
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
          {product ? 'Save' : 'Add product'}
          <ShortcutHint keys={SUBMIT} tone="on-fill" className="hidden sm:inline-flex" />
        </Button>
      </SheetFooter>
    </form>
  );
}

/** Retire, after the destructive confirmation. A refused retire is shown in the dialog. */
function RetireProductButton({
  product,
  onRetired,
}: {
  product: BrandView;
  onRetired: (name: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const retire = useActionSubmit(retireBrandAction, () => onRetired(product.name));

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
        title={`Retire ${product.name}?`}
        description="It can’t be picked for new catalog items, deals or suppliers, and its name stays taken. Records that already use it keep it. You can restore it later from “Show retired”."
        confirmLabel="Retire product"
        error={retire.formError}
        onConfirm={async () => {
          const ok = await retire.run({ id: product.id });
          // Keeps the dialog open, showing why, when the retire was refused.
          if (!ok) throw new Error('Retire refused');
        }}
      />
    </>
  );
}

/** A retired product: its details, and Restore. */
function RetiredProduct({ product, onRestored }: { product: BrandView; onRestored: () => void }) {
  const restore = useActionSubmit(restoreBrandAction, onRestored);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SheetHeader
        title={product.name}
        leading={
          <IconTile className="size-11 rounded-xl [&_svg]:size-5">
            <Tag strokeWidth={1.75} />
          </IconTile>
        }
      />
      <SheetBody>
        <FormAlert message={restore.formError} />
        <FormSection
          title="Product"
          footer={
            product.retiredAt
              ? `Retired on ${formatDate(product.retiredAt)}. Restore it to rename it or pick it again.`
              : undefined
          }
        >
          <ReadOnlyField label="Name">{product.name}</ReadOnlyField>
        </FormSection>
      </SheetBody>
      <SheetFooter>
        <SheetClose asChild>
          <Button variant="secondary" className="pr-3">
            Close
            <ShortcutHint keys={['escape']} className="hidden sm:inline-flex" />
          </Button>
        </SheetClose>
        <Button loading={restore.pending} onClick={() => void restore.run({ id: product.id })}>
          Restore product
        </Button>
      </SheetFooter>
    </div>
  );
}
