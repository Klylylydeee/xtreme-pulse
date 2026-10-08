import type { Metadata } from 'next';
import { Suspense } from 'react';
import { type CurrentUser, listBrands } from '@pulse/core/server';
import { requireAdminPage } from '@/lib/auth';
import { firstParam, type SearchParams } from '@/lib/keyset-paging';
import { ProductsLoading } from './products-loading';
import { ProductsManager } from './products-manager';

export const metadata: Metadata = { title: 'Products' };

// Spec: docs/modules/core.md#managing-master-data — the System Administrator adds, renames, retires
// and restores products (`brands` in code, docs/modules/engage.md#deals-and-stages). Anyone else,
// HR included, gets the no-access state (HTTP 403). The guard comes first, before anything that can
// suspend; the list loads inside the page's own boundary
// (docs/CODE_STYLE.md#pages-server-actions-and-route-handlers). `?retired=1` lists retired products
// too. Loading errors go to the (pulse) error boundary.
export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireAdminPage('systemAdministrator');
  return (
    <Suspense fallback={<ProductsLoading />}>
      <Products user={user} searchParams={searchParams} />
    </Suspense>
  );
}

async function Products({
  user,
  searchParams,
}: {
  user: CurrentUser;
  searchParams: Promise<SearchParams>;
}) {
  const showRetired = firstParam(await searchParams, 'retired') === '1';
  const products = await listBrands(user, { includeRetired: showRetired });

  return <ProductsManager products={products} showRetired={showRetired} />;
}
