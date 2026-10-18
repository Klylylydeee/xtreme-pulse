import type { Metadata } from 'next';
import { forbidden, notFound, redirect } from 'next/navigation';
import { AccessDeniedError, ActionError, OBJECT_ID_PATTERN } from '@pulse/core';
import { OWN_TIME_OFF_HREF } from '@pulse/talent';
import { getEmployeeTimeOff } from '@pulse/talent/server';
import { ErrorState } from '@pulse/ui/components/error-state';
import { PageHeader } from '@pulse/ui/components/page-header';
import { requireCurrentUser } from '@/lib/auth';
import { TimeOffScreen } from '../../time-off-ui/time-off-screen';

export const metadata: Metadata = { title: 'Time off' };

// Spec: docs/modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28
// ("Screens", "Who may see what"; decision 319) and SECURITY.md#exceptions-to-module-access ("The
// own time off and the team's") — another employee's time off, read-only: the balances and the
// requests, with no "File time off" and no actions. Talent Read opens anyone's; a `reportingTo`
// supervisor, or anyone who is or was an approver on one of the employee's requests, opens it
// whatever their module access, with directory fields only. A confidential type reads "Leave",
// with no type, attachment or reason, to anyone but the employee, HR and the System Administrator
// (the service decides). Reached from My team and the inspector's Time off section.
//
// The guard is the service itself (`getEmployeeTimeOff` decides who may see whom), so it is awaited
// first, outside any Suspense boundary: a refusal is a real HTTP 403 with the no-access state, and
// an unknown employee a real 404. The signed-in user's own id goes to the own page, which has the
// request sheet. Nothing here is logged or cached.
export default async function EmployeeTimeOffPage({
  params,
}: {
  params: Promise<{ employeeId: string }>;
}) {
  const user = await requireCurrentUser();
  const { employeeId } = await params;
  if (!OBJECT_ID_PATTERN.test(employeeId)) notFound();
  if (user.employee?.id === employeeId) redirect(OWN_TIME_OFF_HREF);

  let view;
  try {
    view = await getEmployeeTimeOff(user, employeeId);
  } catch (error) {
    if (error instanceof AccessDeniedError) forbidden();
    if (error instanceof ActionError) {
      return (
        <>
          <PageHeader title="Time off" />
          <ErrorState title="This time off can’t open" description={error.message} />
        </>
      );
    }
    throw error;
  }
  if (!view) notFound();
  return <TimeOffScreen view={view} />;
}
