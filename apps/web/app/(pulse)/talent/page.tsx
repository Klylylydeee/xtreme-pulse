import type { Metadata } from 'next';
import { Suspense } from 'react';
import { EMPLOYMENT_STATUSES, type EmploymentStatus } from '@pulse/core';
import { type CurrentUser, listBrandOptions, listDirectoryDepartments } from '@pulse/core/server';
import { getExpiryAlertSettings, listEmployeeRecords } from '@pulse/talent/server';
import { requireModulePage } from '@/lib/auth';
import { getUploadHints } from '@/lib/upload-hints';
import { firstParam, type SearchParams } from '@/lib/keyset-paging';
import { EmployeesLoading } from './employees-loading';
import { EmployeesManager } from './employees-manager';

export const metadata: Metadata = { title: 'Employees' };

const SEARCH_MAX_LENGTH = 100;

function statusParam(value: string | undefined): EmploymentStatus | null {
  return EMPLOYMENT_STATUSES.find((status) => status === value) ?? null;
}

// Spec: docs/modules/talent.md#the-employee-record-build-step-21 — the employee list (build step
// 2.1, decision 168). Talent Read (SECURITY.md#resolving-and-enforcing-build-step-16): the guard
// runs first, before anything that can suspend; the list loads inside the page's own boundary
// (docs/CODE_STYLE.md#pages-server-actions-and-route-handlers), and loading errors go to the
// (pulse) error boundary. The list comes from the employee record service, built from Core's
// identities: no sensitive field, date of birth or civil status is ever in it. The filters live
// in the URL (`?q=`, `?department=`, `?status=`, `?separated=1`), and `?employee=<employeeId>`
// opens that record in the inspector (read on the client). The inspector loads each record
// through a Server Action that checks Talent Read again, and the service builds each section only
// for a viewer who may see it (SECURITY.md#sensitive-data). Nothing here is logged or cached.
// From step 2.2 the page also loads what the inspector's sheets need (Core's products for a
// certification, the upload limits) and the expiry alert lead days, whose Settings sheet a Talent
// Owner opens from the header.
export default async function TalentPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireModulePage('talent', 'read');
  return (
    <Suspense fallback={<EmployeesLoading />}>
      <Employees user={user} searchParams={searchParams} />
    </Suspense>
  );
}

async function Employees({
  user,
  searchParams,
}: {
  user: CurrentUser;
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const search = (firstParam(params, 'q') ?? '').trim().slice(0, SEARCH_MAX_LENGTH);
  const departmentId = (firstParam(params, 'department') ?? '').trim() || null;
  const status = statusParam(firstParam(params, 'status'));
  const showSeparated = firstParam(params, 'separated') === '1';

  const [list, departments, brands, uploads, expirySettings] = await Promise.all([
    listEmployeeRecords(user, { q: search, departmentId, status, separated: showSeparated }),
    listDirectoryDepartments(),
    listBrandOptions(),
    getUploadHints(),
    getExpiryAlertSettings(user),
  ]);

  return (
    <EmployeesManager
      rows={list.rows}
      stats={list.stats}
      departments={departments}
      search={search}
      departmentId={departmentId}
      status={status}
      showSeparated={showSeparated}
      tools={{ brands, uploads }}
      expirySettings={expirySettings}
    />
  );
}
