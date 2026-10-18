import type { Metadata } from 'next';
import { Suspense } from 'react';
import type { CurrentUser } from '@pulse/core/server';
import { getTimesheetsList } from '@pulse/talent/server';
import { requireModulePage } from '@/lib/auth';
import { firstParam, type SearchParams } from '@/lib/keyset-paging';
import { TimesheetsList, TimesheetsListUnavailable } from '../timesheets-list/timesheets-list';
import { TimesheetsListLoading } from '../timesheets-list/timesheets-list-loading';

export const metadata: Metadata = { title: 'Timesheets' };

// Spec: docs/modules/talent.md#timesheet-approval-the-dtr-and-the-offset-balance-build-step-27
// ("Screens", `/talent/timesheets`) and decision 294 in docs/BUILD_PLAN.md — the timesheets list:
// a cut-off picker (`?cutOff=<period start>`, the latest ended cut-off by default), tiles counting
// each status, each a filter (`?status=`), and one row per employee linking to their timesheet.
// Talent Read (*Assumption*, HANDOFF item 135; SECURITY.md#resolving-and-enforcing-build-step-16):
// the guard runs first, before anything that can suspend, and the service checks again
// (`assertCanSeeTimesheetsList`). The list loads inside the page's own boundary; loading errors go
// to the (pulse) error boundary. Directory fields, the timesheet type and the status only: nothing
// sensitive, logged or cached. Its PDF and Excel exports come in step 2.16.
export default async function TimesheetsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireModulePage('talent', 'read');
  return (
    <Suspense fallback={<TimesheetsListLoading />}>
      <Timesheets user={user} searchParams={searchParams} />
    </Suspense>
  );
}

async function Timesheets({
  user,
  searchParams,
}: {
  user: CurrentUser;
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const cutOff = (firstParam(params, 'cutOff') ?? '').trim() || null;
  const status = (firstParam(params, 'status') ?? '').trim() || null;
  const view = await getTimesheetsList(user, { cutOff, status });
  // Null: the asked cut-off isn't an ended one, or no cut-off has ended yet.
  if (!view) return <TimesheetsListUnavailable askedCutOff={cutOff !== null} />;
  return <TimesheetsList view={view} />;
}
