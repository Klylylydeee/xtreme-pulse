import type { Metadata } from 'next';
import { listDepartments } from '@pulse/core/server';
import { requireHROrSystemAdministrator } from '@/lib/auth';
import { firstParam, type SearchParams } from '@/lib/keyset-paging';
import { DepartmentsManager } from './departments-manager';

export const metadata: Metadata = { title: 'Departments' };

// Spec: docs/modules/core.md#managing-departments-and-positions — HR and the System Administrator
// add, edit, retire and restore departments. Until module access arrives in step 1.6, anyone else
// gets "not found". `?retired=1` lists retired departments too. Loading errors go to the (pulse)
// error boundary.
export default async function DepartmentsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireHROrSystemAdministrator();
  const showRetired = firstParam(await searchParams, 'retired') === '1';
  const departments = await listDepartments(user, { includeRetired: showRetired });

  return <DepartmentsManager departments={departments} showRetired={showRetired} />;
}
