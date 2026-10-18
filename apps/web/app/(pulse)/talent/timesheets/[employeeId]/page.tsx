import type { Metadata } from 'next';
import { forbidden, notFound } from 'next/navigation';
import { AccessDeniedError, ActionError, OBJECT_ID_PATTERN } from '@pulse/core';
import { getTimesheetView } from '@pulse/talent/server';
import { ErrorState } from '@pulse/ui/components/error-state';
import { PageHeader } from '@pulse/ui/components/page-header';
import { requireCurrentUser } from '@/lib/auth';
import { firstParam, type SearchParams } from '@/lib/keyset-paging';
import { TimesheetScreen } from '../../timesheet-ui/timesheet-screen';

export const metadata: Metadata = { title: 'Timesheet' };

// Spec: docs/modules/talent.md#work-schedules-and-daily-time-entries-build-step-24 ("Screens",
// decisions 221, 222 and 231) and SECURITY.md#exceptions-to-module-access ("Supervisors see their
// team's timesheets") — another employee's timesheet, read-only: no clock, no Add entry, no edit
// sheet. Talent Read opens anyone's; a supervisor in the employee's `reportingTo` opens it whatever
// their module access, and gets only the employee's directory fields. `?cutOff=` picks the cut-off.
// From step 2.7 (docs/modules/talent.md#timesheet-approval-the-dtr-and-the-offset-balance-build-
// step-27, decision 285) anyone who is or was an approver of that cut-off's timesheet opens it
// read-only too (directory fields only without Talent Read): the approval's link lands here, the
// banner shows the status and, for the pending step's approvers, "Open in Approvals"; nothing is
// decided on this page.
//
// The guard is the service itself (`getTimesheetView` decides who may see whom), so it is awaited
// first, before anything that can suspend, and outside any Suspense boundary: a refusal is a real
// HTTP 403 with the no-access state, and an unknown employee or cut-off a real 404. Changing the
// cut-off then loads in a transition. Nothing here is logged or cached.
export default async function EmployeeTimesheetPage({
  params,
  searchParams,
}: {
  params: Promise<{ employeeId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireCurrentUser();
  const { employeeId } = await params;
  if (!OBJECT_ID_PATTERN.test(employeeId)) notFound();
  const cutOff = firstParam(await searchParams, 'cutOff') ?? null;

  let view;
  try {
    view = await getTimesheetView(user, employeeId, { cutOff });
  } catch (error) {
    if (error instanceof AccessDeniedError) forbidden();
    if (error instanceof ActionError) {
      return (
        <>
          <PageHeader title="Timesheet" />
          <ErrorState title="This timesheet can’t open" description={error.message} />
        </>
      );
    }
    throw error;
  }
  if (!view) notFound();
  return <TimesheetScreen key={view.timesheet.periodStart} view={view} />;
}
