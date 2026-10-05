import type { Metadata } from 'next';
import { Suspense } from 'react';
import { type CurrentUser, listDepartments } from '@pulse/core/server';
import { requireAdminPage } from '@/lib/auth';
import { firstParam, type SearchParams } from '@/lib/keyset-paging';
import { DepartmentsLoading } from './departments-loading';
import { DepartmentsManager } from './departments-manager';

export const metadata: Metadata = { title: 'Departments' };

// Spec: docs/modules/core.md#managing-departments-and-positions — HR and the System Administrator
// add, edit, retire and restore departments. Anyone else gets the no-access state (HTTP 403). The
// guard comes first, before anything that can suspend; the list loads inside the page's own
// boundary (docs/CODE_STYLE.md#pages-server-actions-and-route-handlers). `?retired=1` lists
// retired departments too. Loading errors go to the (pulse) error boundary.
export default async function DepartmentsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireAdminPage('hrOrSystemAdministrator');
  return (
    <Suspense fallback={<DepartmentsLoading />}>
      <Departments user={user} searchParams={searchParams} />
    </Suspense>
  );
}

async function Departments({
  user,
  searchParams,
}: {
  user: CurrentUser;
  searchParams: Promise<SearchParams>;
}) {
  const showRetired = firstParam(await searchParams, 'retired') === '1';
  const departments = await listDepartments(user, { includeRetired: showRetired });

  return <DepartmentsManager departments={departments} showRetired={showRetired} />;
}
