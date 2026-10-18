import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { CalendarClock } from 'lucide-react';
import { AccessDeniedError, ActionError } from '@pulse/core';
import type { CurrentUser } from '@pulse/core/server';
import { getOwnTimesheetView } from '@pulse/talent/server';
import { EmptyState } from '@pulse/ui/components/empty-state';
import { ErrorState } from '@pulse/ui/components/error-state';
import { PageHeader } from '@pulse/ui/components/page-header';
import { requireCurrentUser } from '@/lib/auth';
import { firstParam, type SearchParams } from '@/lib/keyset-paging';
import { getUploadHints } from '@/lib/upload-hints';
import { TimesheetLoading } from '../timesheet-ui/timesheet-loading';
import { TimesheetScreen } from '../timesheet-ui/timesheet-screen';

export const metadata: Metadata = { title: 'Timesheet' };

// Spec: docs/modules/talent.md#work-schedules-and-daily-time-entries-build-step-24 ("Screens",
// decision 231) and SECURITY.md#exceptions-to-module-access ("The own timesheet") — the employee's
// own timesheet, self-service outside module access: every signed-in user with an employee, no
// Pulse Talent access needed. It takes no employee id from the request: `getOwnTimesheetView`
// loads the signed-in user's own employee only. `?cutOff=YYYY-MM-DD` (a period start) picks the
// cut-off; one before the date hired, after today's, or not a period start is not found. From step
// 2.7 the view also carries the status banner, the submit sheet ("Submit timesheet" after the
// cut-off ends), the DTR and the offset credit; the reminders and the submit sheet link here with
// `?cutOff=` (and `#day-<date>` or `#reimbursement-<id>`).
//
// The guard (a signed-in user) runs first, before anything that can suspend; the bootstrap system
// account, which has no employee, gets an empty state, as on My record. The view loads inside the
// page's own boundary; a refusal the employee can act on (no position, no pay schedule) shows as
// an error state with its message, and other errors go to the (pulse) error boundary. Nothing
// here is logged or cached.
export default async function OwnTimesheetPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireCurrentUser();
  if (!user.employee) {
    return (
      <>
        <PageHeader title="Timesheet" />
        <EmptyState
          icon={<CalendarClock strokeWidth={1.75} />}
          title="No timesheet"
          description="This account isn’t linked to an employee, so it has no timesheet."
        />
      </>
    );
  }
  return (
    <Suspense fallback={<TimesheetLoading label="Loading your timesheet…" />}>
      <OwnTimesheet user={user} searchParams={searchParams} />
    </Suspense>
  );
}

async function OwnTimesheet({
  user,
  searchParams,
}: {
  user: CurrentUser;
  searchParams: Promise<SearchParams>;
}) {
  const cutOff = firstParam(await searchParams, 'cutOff') ?? null;
  let view;
  let uploads;
  try {
    // The receipt field names today's accepted types and size limit (every upload type is a
    // photo or a PDF, so the document hint fits receipts).
    [view, uploads] = await Promise.all([getOwnTimesheetView(user, { cutOff }), getUploadHints()]);
  } catch (error) {
    if (error instanceof ActionError || error instanceof AccessDeniedError) {
      return (
        <>
          <PageHeader title="Timesheet" />
          <ErrorState title="Your timesheet can’t open" description={error.message} />
        </>
      );
    }
    throw error;
  }
  if (!view) notFound();
  return (
    <TimesheetScreen
      key={view.timesheet.periodStart}
      view={view}
      receiptUpload={uploads.document}
    />
  );
}
