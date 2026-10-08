import type { Metadata } from 'next';
import { Suspense } from 'react';
import { type CurrentUser, listClients } from '@pulse/core/server';
import { requireAdminPage } from '@/lib/auth';
import { firstParam, type SearchParams } from '@/lib/keyset-paging';
import { ClientsLoading } from './clients-loading';
import { ClientsManager } from './clients-manager';

export const metadata: Metadata = { title: 'Clients' };

// Spec: docs/modules/core.md#managing-master-data and docs/modules/engage.md#clients-sites-and-contacts
// — the System Administrator adds, edits, retires and restores clients, and manages each client's
// sites and contacts. Anyone else, HR included, gets the no-access state (HTTP 403). The guard
// comes first, before anything that can suspend; the list loads inside the page's own boundary
// (docs/CODE_STYLE.md#pages-server-actions-and-route-handlers). `?retired=1` lists retired clients
// too. Loading errors go to the (pulse) error boundary.
export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireAdminPage('systemAdministrator');
  return (
    <Suspense fallback={<ClientsLoading />}>
      <Clients user={user} searchParams={searchParams} />
    </Suspense>
  );
}

async function Clients({
  user,
  searchParams,
}: {
  user: CurrentUser;
  searchParams: Promise<SearchParams>;
}) {
  const showRetired = firstParam(await searchParams, 'retired') === '1';
  const clients = await listClients(user, { includeRetired: showRetired });
  return <ClientsManager clients={clients} showRetired={showRetired} />;
}
