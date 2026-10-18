import type { Metadata } from 'next';
import { Suspense } from 'react';
import { CalendarHeart } from 'lucide-react';
import { AccessDeniedError, ActionError } from '@pulse/core';
import type { CurrentUser } from '@pulse/core/server';
import { getOwnTimeOff } from '@pulse/talent/server';
import { EmptyState } from '@pulse/ui/components/empty-state';
import { ErrorState } from '@pulse/ui/components/error-state';
import { PageHeader } from '@pulse/ui/components/page-header';
import { requireCurrentUser } from '@/lib/auth';
import { getUploadHints } from '@/lib/upload-hints';
import { TimeOffLoading } from '../time-off-ui/time-off-loading';
import { TimeOffScreen } from '../time-off-ui/time-off-screen';

export const metadata: Metadata = { title: 'Time off' };

// Spec: docs/modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28
// ("Screens"; decision 319) and SECURITY.md#exceptions-to-module-access ("The own time off and the
// team's") — the employee's own time off, self-service outside module access: every signed-in
// user with an employee, no Pulse Talent access needed. It takes no employee id from the request:
// `getOwnTimeOff` loads the signed-in user's own employee only. The balances (VL, SL, offset and
// the statutory types used this year), the requests newest first, and "File time off" with the
// request sheet; `#resend-<id>` and `#cancel-<id>` open those sheets.
//
// The guard (a signed-in user) runs first, before anything that can suspend; the bootstrap system
// account, which has no employee, gets an empty state, as on the own timesheet. The view loads
// inside the page's own boundary; a refusal shows as an error state with its message, and other
// errors go to the (pulse) error boundary. Nothing here is logged or cached.
export default async function OwnTimeOffPage() {
  const user = await requireCurrentUser();
  if (!user.employee) {
    return (
      <>
        <PageHeader title="Time off" />
        <EmptyState
          icon={<CalendarHeart strokeWidth={1.75} />}
          title="No time off"
          description="This account isn’t linked to an employee, so it has no leave or offset time off."
        />
      </>
    );
  }
  return (
    <Suspense fallback={<TimeOffLoading label="Loading your time off…" />}>
      <OwnTimeOff user={user} />
    </Suspense>
  );
}

async function OwnTimeOff({ user }: { user: CurrentUser }) {
  let view;
  let uploads;
  try {
    // The attachment field names today's accepted types and size limit (any allowed type; an
    // image is re-encoded, a PDF stored as it is).
    [view, uploads] = await Promise.all([getOwnTimeOff(user), getUploadHints()]);
  } catch (error) {
    if (error instanceof ActionError || error instanceof AccessDeniedError) {
      return (
        <>
          <PageHeader title="Time off" />
          <ErrorState title="Your time off can’t open" description={error.message} />
        </>
      );
    }
    throw error;
  }
  return <TimeOffScreen view={view} upload={uploads.document} />;
}
