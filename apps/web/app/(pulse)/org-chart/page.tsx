import type { Metadata } from 'next';
import { Suspense } from 'react';
import {
  canEditReportingLines,
  canSeeSeparatedPeople,
  type CurrentUser,
  getOrgChart,
  listDirectoryDepartments,
  ROLE_DEPARTMENT_CODES,
} from '@pulse/core/server';
import { requireCurrentUser } from '@/lib/auth';
import { firstParam, type SearchParams } from '@/lib/keyset-paging';
import { OrgChartLoading } from './org-chart-loading';
import { OrgChartView } from './org-chart-view';

export const metadata: Metadata = { title: 'Org chart' };

// Spec: docs/modules/core.md#org-chart — the org chart (build step 1.11), built from reporting
// lines. A Pulse Core page: every signed-in user, no module access needed (SECURITY.md#rules).
// Active people only, for everyone, with directory-level fields only (the service builds them);
// a line to a separated or inactive supervisor isn't drawn. The department filter
// (`?department=`) is applied on the server: that department's members and the lines among them.
// The name search (`?q=`) and the open card (`?person=<employeeId>`) are read on the client: the
// search highlights cards without changing the layout. The guard comes first, before anything that
// can suspend; the chart loads inside the page's own boundary
// (docs/CODE_STYLE.md#pages-server-actions-and-route-handlers). Loading errors go to the (pulse)
// error boundary. Nothing here is audit-logged, logged or cached (decision 152).
export default async function OrgChartPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireCurrentUser();
  return (
    <Suspense fallback={<OrgChartLoading />}>
      <OrgChart user={user} searchParams={searchParams} />
    </Suspense>
  );
}

async function OrgChart({
  user,
  searchParams,
}: {
  user: CurrentUser;
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const departmentId = (firstParam(params, 'department') ?? '').trim() || null;
  const [nodes, departments] = await Promise.all([
    getOrgChart({ departmentId }),
    listDirectoryDepartments(),
  ]);

  return (
    <OrgChartView
      // A new department is a new chart: fresh zoom and scroll.
      key={departmentId ?? 'all'}
      nodes={nodes}
      departments={departments}
      departmentId={departmentId}
      boardDepartmentCode={ROLE_DEPARTMENT_CODES.board}
      viewer={{
        employeeId: user.employee?.id ?? null,
        canEditReportingLines: canEditReportingLines(user),
        canSeeSeparatedPeople: canSeeSeparatedPeople(user),
      }}
    />
  );
}
