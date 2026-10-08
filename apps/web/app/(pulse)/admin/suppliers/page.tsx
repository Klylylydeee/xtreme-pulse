import type { Metadata } from 'next';
import { Suspense } from 'react';
import { type CurrentUser, listBrandOptions, listSuppliers } from '@pulse/core/server';
import { requireAdminPage } from '@/lib/auth';
import { firstParam, type SearchParams } from '@/lib/keyset-paging';
import { SuppliersLoading } from './suppliers-loading';
import { SuppliersManager } from './suppliers-manager';

export const metadata: Metadata = { title: 'Suppliers' };

// Spec: docs/modules/core.md#managing-master-data and docs/modules/supply.md#suppliers — the System
// Administrator adds, edits, retires and restores suppliers. Anyone else, HR included, gets the
// no-access state (HTTP 403). The guard comes first, before anything that can suspend; the list
// and the live products for the "Products supplied" picker load inside the page's own boundary
// (docs/CODE_STYLE.md#pages-server-actions-and-route-handlers). `?retired=1` lists retired
// suppliers too. Loading errors go to the (pulse) error boundary.
export default async function SuppliersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireAdminPage('systemAdministrator');
  return (
    <Suspense fallback={<SuppliersLoading />}>
      <Suppliers user={user} searchParams={searchParams} />
    </Suspense>
  );
}

async function Suppliers({
  user,
  searchParams,
}: {
  user: CurrentUser;
  searchParams: Promise<SearchParams>;
}) {
  const showRetired = firstParam(await searchParams, 'retired') === '1';
  const [suppliers, products] = await Promise.all([
    listSuppliers(user, { includeRetired: showRetired }),
    listBrandOptions(),
  ]);

  return <SuppliersManager suppliers={suppliers} products={products} showRetired={showRetired} />;
}
