import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ListChecks } from 'lucide-react';
import { type CurrentUser, listBrandOptions } from '@pulse/core/server';
import {
  getOwnChangeRequestStates,
  getOwnOnboarding,
  getOwnRecordView,
} from '@pulse/talent/server';
import { EmptyState } from '@pulse/ui/components/empty-state';
import { PageHeader } from '@pulse/ui/components/page-header';
import { Skeleton } from '@pulse/ui/components/skeleton';
import { requireCurrentUser } from '@/lib/auth';
import { getUploadHints } from '@/lib/upload-hints';
import { OnboardingChecklist } from './onboarding-checklist';

export const metadata: Metadata = { title: 'Onboarding' };

const DESCRIPTION =
  'Finish setting up your profile. Nothing here stops you from working: skip it and come back any time.';

// Spec: docs/modules/talent.md#onboarding-checklist-and-change-requests-build-step-26 ("Screens":
// `/talent/onboarding`; decisions 257, 258, 261 and 275 in docs/BUILD_PLAN.md),
// SECURITY.md#exceptions-to-module-access and docs/DESIGN_SYSTEM.md#feedback--motion
// ("Onboarding progress") — the employee's own onboarding checklist, self-service outside module
// access: every signed-in user with an employee, no Pulse Talent access needed. It takes no
// employee id from the request: `getOwnOnboarding` derives the signed-in user's own checklist only.
//
// The guard (a signed-in user) runs first, before anything that can suspend; the bootstrap system
// account, which has no employee, gets an empty state. The checklist loads inside the page's own
// boundary, and loading errors go to the (pulse) error boundary. Required but not enforced: "Skip
// for now" goes to Home, and nothing here blocks anything. Each item's action opens the same sheet
// as on My record. Nothing here is logged or cached.
export default async function OnboardingPage() {
  const user = await requireCurrentUser();
  if (!user.employee) {
    return (
      <>
        <PageHeader title="Onboarding" />
        <EmptyState
          icon={<ListChecks strokeWidth={1.75} />}
          title="No onboarding checklist"
          description="This account isn’t linked to an employee, so it has no onboarding checklist."
        />
      </>
    );
  }
  return (
    <>
      <PageHeader title="Onboarding" description={DESCRIPTION} />
      <Suspense fallback={<OnboardingLoading />}>
        <Onboarding user={user} />
      </Suspense>
    </>
  );
}

async function Onboarding({ user }: { user: CurrentUser }) {
  const [onboarding, view, states, uploads, brands] = await Promise.all([
    getOwnOnboarding(user),
    getOwnRecordView(user),
    getOwnChangeRequestStates(user),
    getUploadHints(),
    listBrandOptions(),
  ]);
  if (!onboarding || !view || !states) {
    return (
      <EmptyState
        icon={<ListChecks strokeWidth={1.75} />}
        title="No onboarding checklist"
        description="This account isn’t linked to an employee, so it has no onboarding checklist."
      />
    );
  }
  return (
    <OnboardingChecklist
      onboarding={onboarding}
      view={view}
      states={states}
      uploads={uploads}
      brands={brands}
    />
  );
}

function OnboardingLoading() {
  return (
    <div role="status" aria-live="polite" className="flex w-full max-w-2xl flex-col gap-5">
      <span className="sr-only">Loading your checklist…</span>
      <div
        aria-hidden="true"
        className="flex flex-col gap-3 rounded-card bg-surface p-4 shadow-card"
      >
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-2 w-full" />
      </div>
      {Array.from({ length: 2 }, (_, group) => (
        <div
          key={group}
          aria-hidden="true"
          className="flex flex-col divide-y divide-separator rounded-card bg-surface shadow-card"
        >
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="flex items-center gap-3 px-4 py-3">
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-5 w-16" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
