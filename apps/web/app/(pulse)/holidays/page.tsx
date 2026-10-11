import type { Metadata } from 'next';
import { Suspense } from 'react';
import { businessYear, holidayYearSchema, now } from '@pulse/core';
import {
  canManageHolidays,
  type CurrentUser,
  listHolidays,
  listHolidayYears,
} from '@pulse/core/server';
import { requireCurrentUser } from '@/lib/auth';
import { firstParam, type SearchParams } from '@/lib/keyset-paging';
import { HolidaysLoading } from './holidays-loading';
import { HolidaysManager } from './holidays-manager';

export const metadata: Metadata = { title: 'Holidays' };

// Spec: docs/modules/core.md#holiday-calendar — the holiday calendar (build step 1.10). A Pulse
// Core page: every signed-in user, no module access needed (SECURITY.md#rules). What each person
// sees is decided by the holiday services, never by this page: someone who isn't HR or a System
// Administrator gets confirmed holidays only, filtered in the query, so a draft never reaches their
// browser. HR and System Administrators also get the drafts and the controls (`canManageHolidays`);
// every action checks the role again, and so does each service. The guard comes first, before
// anything that can suspend; the list loads inside the page's own boundary
// (docs/CODE_STYLE.md#pages-server-actions-and-route-handlers). The year lives in the URL
// (`?year=2027`; the current Manila year without it). Loading errors go to the (pulse) error
// boundary. Reading is not audit-logged.
export default async function HolidaysPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireCurrentUser();
  return (
    <Suspense fallback={<HolidaysLoading />}>
      <Holidays user={user} searchParams={searchParams} />
    </Suspense>
  );
}

async function Holidays({
  user,
  searchParams,
}: {
  user: CurrentUser;
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const currentYear = businessYear(now());
  const parsedYear = holidayYearSchema.safeParse(firstParam(params, 'year'));
  const year = parsedYear.success ? parsedYear.data : currentYear;
  const canManage = canManageHolidays(user);

  const [holidays, years] = await Promise.all([
    listHolidays(user, { year }),
    listHolidayYears(user),
  ]);
  // The picker offers every year with a holiday the user can see, plus this year and next (the
  // years HR prepares), and the one being shown.
  const yearOptions = [...new Set([...years, currentYear, currentYear + 1, year])].sort(
    (a, b) => b - a,
  );

  return (
    <HolidaysManager
      // A new year starts afresh (filter, sheet and notices); a refresh of the same year keeps them.
      key={year}
      year={year}
      currentYear={currentYear}
      yearOptions={yearOptions}
      holidays={holidays}
      canManage={canManage}
    />
  );
}
