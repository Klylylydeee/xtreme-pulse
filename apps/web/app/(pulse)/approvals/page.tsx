import type { Metadata } from 'next';
import { Suspense } from 'react';
import { now } from '@pulse/core';
import {
  countApprovalsWaiting,
  type CurrentUser,
  listApprovalsDecided,
  listApprovalsWaiting,
} from '@pulse/core/server';
import { registerApprovalTypes } from '@/lib/approval-types';
import { requireCurrentUser } from '@/lib/auth';
import { firstParam, type SearchParams } from '@/lib/keyset-paging';
import { ApprovalsLoading } from './approvals-loading';
import { ApprovalsManager, type ApprovalsView } from './approvals-manager';

export const metadata: Metadata = { title: 'Approvals' };

/** Requests per page; "Load more" adds the next page. */
const PAGE_SIZE = 20;

// Spec: docs/modules/core.md#approvals-list — the Approvals list (build step 1.9). A Pulse Core
// page: every signed-in user, no module access needed (SECURITY.md#rules). What each person sees is
// checked by the approvals services, never by this page: the segments list only requests that name
// the user, the inspector reads one only for its approvers, requester or a System Administrator,
// and only a named approver of the pending step can decide. The guard comes first, before anything
// that can suspend; the list loads inside the page's own boundary
// (docs/CODE_STYLE.md#pages-server-actions-and-route-handlers). The segment lives in the URL
// (`?view=decided`; Waiting for you without it), and `?request=<id>` opens a request's inspector
// (read on the client, so it also works when the page is already open; notifications link there).
// Loading errors go to the (pulse) error boundary. Reading is not audit-logged.
export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireCurrentUser();
  return (
    <Suspense fallback={<ApprovalsLoading />}>
      <Approvals user={user} searchParams={searchParams} />
    </Suspense>
  );
}

async function Approvals({
  user,
  searchParams,
}: {
  user: CurrentUser;
  searchParams: Promise<SearchParams>;
}) {
  registerApprovalTypes();
  const params = await searchParams;
  const view: ApprovalsView = firstParam(params, 'view') === 'decided' ? 'decided' : 'waiting';
  const list = view === 'waiting' ? listApprovalsWaiting : listApprovalsDecided;
  const [page, waitingCount] = await Promise.all([
    list(user, { limit: PAGE_SIZE }),
    countApprovalsWaiting(user.id),
  ]);

  return (
    <ApprovalsManager
      // A new segment starts its list afresh; a refresh of the same one keeps the loaded pages.
      key={view}
      view={view}
      initialPage={page}
      waitingCount={waitingCount}
      reference={now()}
    />
  );
}
