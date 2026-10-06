import type { Metadata } from 'next';
import { Suspense } from 'react';
import {
  type CurrentUser,
  isSystemAdministrator,
  listDepartments,
  listPositions,
  listUserAccess,
} from '@pulse/core/server';
import { requireAdminPage } from '@/lib/auth';
import { firstParam, type SearchParams } from '@/lib/keyset-paging';
import { AccessLoading } from './access-loading';
import { type AccessFilterOption, AccessManager } from './access-manager';

export const metadata: Metadata = { title: 'User access' };

// Spec: docs/modules/core.md#user-access-page — HR and the System Administrator set each active
// user's module access. Checked by role (decision 54): anyone else gets the no-access state (HTTP
// 403), and the access service checks the role again itself. The guard comes first, before
// anything that can suspend; the list loads inside the page's own boundary
// (docs/CODE_STYLE.md#pages-server-actions-and-route-handlers). The filters live in the URL:
// `?q=` (name or employee number), `?department=<id>` and `?position=<id>`; `?user=<id>` opens that
// user's sheet (read on the client, so it also works when the page is already open). Loading
// errors go to the (pulse) error boundary.
export default async function UserAccessPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireAdminPage('hrOrSystemAdministrator');
  return (
    <Suspense fallback={<AccessLoading />}>
      <UserAccess user={user} searchParams={searchParams} />
    </Suspense>
  );
}

async function UserAccess({
  user,
  searchParams,
}: {
  user: CurrentUser;
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const search = (firstParam(params, 'q') ?? '').trim().slice(0, 100);
  const departmentId = (firstParam(params, 'department') ?? '').trim() || null;
  const positionId = (firstParam(params, 'position') ?? '').trim() || null;

  const [list, departments, positions] = await Promise.all([
    listUserAccess(user, { search, departmentId, positionId }),
    // Retired ones too, so a filter set to one still shows its name.
    listDepartments(user, { includeRetired: true }),
    listPositions(user, { includeRetired: true }),
  ]);

  const departmentOptions: AccessFilterOption[] = departments.map((department) => ({
    id: department.id,
    name: `${department.name} (${department.code})`,
    retired: department.retiredAt !== null,
    departmentId: null,
  }));
  const positionOptions: AccessFilterOption[] = positions.map((position) => ({
    id: position.id,
    name: position.name,
    retired: position.retiredAt !== null,
    departmentId: position.departmentId,
  }));

  return (
    <AccessManager
      list={list}
      departments={departmentOptions}
      positions={positionOptions}
      search={search}
      departmentId={departmentId}
      positionId={positionId}
      actorIsSystemAdministrator={isSystemAdministrator(user)}
    />
  );
}
