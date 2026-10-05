import type { Metadata } from 'next';
import { Suspense } from 'react';
import { type CurrentUser, listDepartments, listPositions } from '@pulse/core/server';
import { requireAdminPage } from '@/lib/auth';
import { firstParam, type SearchParams } from '@/lib/keyset-paging';
import { PositionsLoading } from './positions-loading';
import { type DepartmentOption, PositionsManager } from './positions-manager';

export const metadata: Metadata = { title: 'Positions' };

// Spec: docs/modules/core.md#managing-departments-and-positions — HR and the System Administrator
// add, edit, retire and restore positions. Anyone else gets the no-access state (HTTP 403). The
// guard comes first, before anything that can suspend; the list loads inside the page's own
// boundary (docs/CODE_STYLE.md#pages-server-actions-and-route-handlers). `?department=<id>` shows
// one department's positions; `?retired=1` lists retired positions too. Loading errors go to the
// (pulse) error boundary.
export default async function PositionsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireAdminPage('hrOrSystemAdministrator');
  return (
    <Suspense fallback={<PositionsLoading />}>
      <Positions user={user} searchParams={searchParams} />
    </Suspense>
  );
}

async function Positions({
  user,
  searchParams,
}: {
  user: CurrentUser;
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const showRetired = firstParam(params, 'retired') === '1';
  const departmentId = (firstParam(params, 'department') ?? '').trim() || null;

  const [positions, departments] = await Promise.all([
    listPositions(user, { departmentId, includeRetired: showRetired }),
    // Retired ones too, so a filter on a retired department still names it.
    listDepartments(user, { includeRetired: true }),
  ]);
  const departmentOptions: DepartmentOption[] = departments.map((department) => ({
    id: department.id,
    name: department.name,
    code: department.code,
    retired: department.retiredAt !== null,
  }));

  return (
    <PositionsManager
      positions={positions}
      departments={departmentOptions}
      departmentId={departmentId}
      showRetired={showRetired}
    />
  );
}
