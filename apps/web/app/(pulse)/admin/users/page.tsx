import type { Metadata } from 'next';
import { businessToday, dateHiredRange } from '@pulse/core';
import {
  listDepartments,
  listPositions,
  listUsers,
  ROLE_DEPARTMENT_CODES,
} from '@pulse/core/server';
import { requireHROrSystemAdministrator } from '@/lib/auth';
import { firstParam, type SearchParams } from '@/lib/keyset-paging';
import type { UserDepartmentOption, UserPositionOption } from './user-sheet';
import { UsersManager } from './users-manager';

export const metadata: Metadata = { title: 'Users' };

// Spec: docs/modules/core.md#managing-user-accounts — HR and the System Administrator create and
// edit user accounts. Until module access arrives in step 1.6, anyone else gets "not found". The
// list filters live in the URL: `?q=` (name, employee number or email), `?department=<id>` and
// `?separated=1` (show Resigned, Terminated and Retired users). Loading errors go to the (pulse)
// error boundary.
export default async function UsersPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requireHROrSystemAdministrator();
  const params = await searchParams;
  const search = (firstParam(params, 'q') ?? '').trim().slice(0, 100);
  const departmentId = (firstParam(params, 'department') ?? '').trim() || null;
  const showSeparated = firstParam(params, 'separated') === '1';

  const [users, departments, positions] = await Promise.all([
    listUsers(user, { search, departmentId, separated: showSeparated }),
    // Retired ones too, so an employee still in a retired department shows its name.
    listDepartments(user, { includeRetired: true }),
    listPositions(user, { includeRetired: true }),
  ]);

  const departmentOptions: UserDepartmentOption[] = departments.map((department) => ({
    id: department.id,
    name: department.name,
    code: department.code,
    retired: department.retiredAt !== null,
    isBoard: department.code === ROLE_DEPARTMENT_CODES.board,
  }));
  const positionOptions: UserPositionOption[] = positions.map((position) => ({
    id: position.id,
    name: position.name,
    departmentId: position.departmentId,
    retired: position.retiredAt !== null,
  }));
  const today = businessToday();

  return (
    <UsersManager
      users={users}
      departments={departmentOptions}
      positions={positionOptions}
      search={search}
      departmentId={departmentId}
      showSeparated={showSeparated}
      today={today}
      dateHiredRange={dateHiredRange(today)}
    />
  );
}
