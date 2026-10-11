import type { Metadata } from 'next';
import { Suspense } from 'react';
import {
  canEditReportingLines,
  canSeeSeparatedPeople,
  type CurrentUser,
  listDirectory,
  listDirectoryDepartments,
  ROLE_DEPARTMENT_CODES,
} from '@pulse/core/server';
import { requireCurrentUser } from '@/lib/auth';
import { firstParam, type SearchParams } from '@/lib/keyset-paging';
import { DirectoryLoading } from './directory-loading';
import { DirectoryManager } from './directory-manager';

export const metadata: Metadata = { title: 'Directory' };

const SEARCH_MAX_LENGTH = 100;

// Spec: docs/modules/core.md#company-directory — the company directory (build step 1.11). A Pulse
// Core page: every signed-in user, no module access needed (SECURITY.md#rules). What each person
// sees is decided by the directory services, never by this page: directory fields only, built
// field by field, and separated people only for HR and System Administrators who ask for them
// (`?separated=1`; the service ignores the flag for anyone else). The guard comes first, before
// anything that can suspend; the list loads inside the page's own boundary
// (docs/CODE_STYLE.md#pages-server-actions-and-route-handlers). The filters live in the URL
// (`?q=`, `?department=`, `?separated=1`), and `?person=<employeeId>` opens that person's card
// (read on the client, so it also works when the page is already open; the command bar links
// there). Loading errors go to the (pulse) error boundary. Nothing here is audit-logged, logged
// or cached (decision 152).
export default async function DirectoryPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireCurrentUser();
  return (
    <Suspense fallback={<DirectoryLoading />}>
      <Directory user={user} searchParams={searchParams} />
    </Suspense>
  );
}

async function Directory({
  user,
  searchParams,
}: {
  user: CurrentUser;
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const search = (firstParam(params, 'q') ?? '').trim().slice(0, SEARCH_MAX_LENGTH);
  const departmentId = (firstParam(params, 'department') ?? '').trim() || null;
  const canSeeSeparated = canSeeSeparatedPeople(user);
  const showSeparated = canSeeSeparated && firstParam(params, 'separated') === '1';

  const [people, departments] = await Promise.all([
    listDirectory(user, { search, departmentId, separated: showSeparated }),
    listDirectoryDepartments(),
  ]);

  return (
    <DirectoryManager
      people={people}
      departments={departments}
      search={search}
      departmentId={departmentId}
      showSeparated={showSeparated}
      boardDepartmentCode={ROLE_DEPARTMENT_CODES.board}
      viewer={{
        employeeId: user.employee?.id ?? null,
        canEditReportingLines: canEditReportingLines(user),
        canSeeSeparatedPeople: canSeeSeparated,
      }}
    />
  );
}
