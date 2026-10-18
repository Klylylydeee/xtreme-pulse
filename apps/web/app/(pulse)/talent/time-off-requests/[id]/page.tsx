import type { Metadata } from 'next';
import { forbidden, notFound } from 'next/navigation';
import { AccessDeniedError, OBJECT_ID_PATTERN } from '@pulse/core';
import { getTimeOffRequestPage } from '@pulse/talent/server';
import { PageHeader } from '@pulse/ui/components/page-header';
import { requireCurrentUser } from '@/lib/auth';
import { TimeOffRequestDetails } from '../../time-off-ui/request-details';

export const metadata: Metadata = { title: 'Time off request' };

// Spec: docs/modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28 ("Who may
// see what", "Screens": `/talent/time-off-requests/<id>`), SECURITY.md#exceptions-to-module-access
// ("The own time off and the team's") and SECURITY.md#sensitive-data (leave attachments) — one
// time off request, read-only: its days, split, attachment link, reason, status and approval
// history. Approvals link here; deciding stays on Approvals ("Open in Approvals").
//
// The guard is the service itself (`getTimeOffRequestPage` opens the request for the employee,
// Talent Read, a `reportingTo` supervisor, the System Administrator and that request's approvers,
// whatever their module access), so it is awaited first, outside any Suspense boundary: anyone
// else gets a real HTTP 403 with the no-access state, and an unknown request a real 404. A
// confidential type reads "Leave" with no type, attachment or reason to anyone but the employee,
// HR and the System Administrator: the title below uses the service's own label. The attachment
// opens through the file route, which checks access again and audit-logs every open. Nothing here
// is logged or cached.
export default async function TimeOffRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireCurrentUser();
  const { id } = await params;
  if (!OBJECT_ID_PATTERN.test(id)) notFound();

  let view;
  try {
    view = await getTimeOffRequestPage(user, id);
  } catch (error) {
    if (error instanceof AccessDeniedError) forbidden();
    throw error;
  }
  if (!view) notFound();

  const { request } = view;
  const what = request.kind === 'offset' ? 'Offset time off' : (request.typeLabel ?? 'Leave');
  return (
    <>
      <PageHeader
        title={request.number}
        description={view.own ? what : `${what} · ${view.employee.name}`}
      />
      <TimeOffRequestDetails view={view} />
    </>
  );
}
