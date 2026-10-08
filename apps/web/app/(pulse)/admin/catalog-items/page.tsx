import type { Metadata } from 'next';
import { Suspense } from 'react';
import { type CurrentUser, listBrands, listCatalogItems } from '@pulse/core/server';
import { requireAdminPage } from '@/lib/auth';
import { firstParam, type SearchParams } from '@/lib/keyset-paging';
import { CatalogItemsLoading } from './catalog-items-loading';
import { CatalogItemsManager, type ProductOption } from './catalog-items-manager';

export const metadata: Metadata = { title: 'Catalog items' };

// Spec: docs/modules/core.md#managing-master-data — the System Administrator adds, edits, retires
// and restores catalog items (docs/modules/supply.md#stock). Anyone else, HR included, gets the
// no-access state (HTTP 403). The guard comes first, before anything that can suspend; the list
// loads inside the page's own boundary (docs/CODE_STYLE.md#pages-server-actions-and-route-handlers).
// `?product=<id>` shows one product's items; `?retired=1` lists retired items too. Loading errors go
// to the (pulse) error boundary.
export default async function CatalogItemsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireAdminPage('systemAdministrator');
  return (
    <Suspense fallback={<CatalogItemsLoading />}>
      <CatalogItems user={user} searchParams={searchParams} />
    </Suspense>
  );
}

async function CatalogItems({
  user,
  searchParams,
}: {
  user: CurrentUser;
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const showRetired = firstParam(params, 'retired') === '1';
  const productId = (firstParam(params, 'product') ?? '').trim() || null;

  const [items, products] = await Promise.all([
    listCatalogItems(user, { brandId: productId, includeRetired: showRetired }),
    // Retired ones too, so a filter on a retired product still names it.
    listBrands(user, { includeRetired: true }),
  ]);
  const productOptions: ProductOption[] = products.map((product) => ({
    id: product.id,
    name: product.name,
    retired: product.retiredAt !== null,
  }));

  return (
    <CatalogItemsManager
      items={items}
      products={productOptions}
      productId={productId}
      showRetired={showRetired}
    />
  );
}
