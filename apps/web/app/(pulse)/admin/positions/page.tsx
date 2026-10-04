import type { Metadata } from 'next';
import { listDepartments, listPositions } from '@pulse/core/server';
import { requireHROrSystemAdministrator } from '@/lib/auth';
import { firstParam, type SearchParams } from '@/lib/keyset-paging';
import { type DepartmentOption, PositionsManager } from './positions-manager';

export const metadata: Metadata = { title: 'Positions' };

// Spec: docs/modules/core.md#managing-departments-and-positions — HR and the System Administrator
// add, edit, retire and restore positions. Until module access arrives in step 1.6, anyone else
// gets "not found". `?department=<id>` shows one department's positions; `?retired=1` lists
// retired positions too. Loading errors go to the (pulse) error boundary.
export default async function PositionsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireHROrSystemAdministrator();
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
