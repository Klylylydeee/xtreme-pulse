import type { Metadata } from 'next';
import { forbidden, notFound } from 'next/navigation';
import { AccessDeniedError, OBJECT_ID_PATTERN } from '@pulse/core';
import { getChangeRequestView } from '@pulse/talent/server';
import { PageHeader } from '@pulse/ui/components/page-header';
import { requireCurrentUser } from '@/lib/auth';
import { ChangeRequestDetails } from './change-request-details';

export const metadata: Metadata = { title: 'Change request' };

// Spec: docs/modules/talent.md#onboarding-checklist-and-change-requests-build-step-26 ("Who sees a
// change request", "Screens"; decisions 274 and 275 in docs/BUILD_PLAN.md) and
// SECURITY.md#sensitive-data — one change request, read-only: the employee, the section, when it
// was sent, the employee's note, and each changed field with Current and Proposed (Previous and
// Applied once approved). Deciding stays on Approvals ("Open in Approvals").
//
// The guard is the service itself (`getChangeRequestView` opens the request for its requester, its
// approvers, the System Administrator and Talent Read users who may see that section), so it is
// awaited first, outside any Suspense boundary: anyone else gets a real HTTP 403 with the no-access
// state, and an unknown request a real 404. Government ID numbers and the account number arrive
// masked (last 4); Reveal goes through the reveal action, access-checked and audit-logged as
// `talent.changeRequest`. Nothing here is logged or cached.
export default async function ChangeRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireCurrentUser();
  const { id } = await params;
  if (!OBJECT_ID_PATTERN.test(id)) notFound();

  let view;
  try {
    view = await getChangeRequestView(user, id);
  } catch (error) {
    if (error instanceof AccessDeniedError) forbidden();
    throw error;
  }
  if (!view) notFound();

  return (
    <>
      <PageHeader
        title="Change request"
        description={`${view.sectionLabel} · ${view.employee.name}`}
      />
      <ChangeRequestDetails view={view} />
    </>
  );
}
