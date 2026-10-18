import type { Metadata } from 'next';
import { forbidden } from 'next/navigation';
import { Suspense } from 'react';
import type { CurrentUser } from '@pulse/core/server';
import { canManageOpeningBalances, getOpeningBalances } from '@pulse/talent/server';
import { requireModulePage } from '@/lib/auth';
import { OpeningBalancesLoading } from './opening-balances-loading';
import { OpeningBalancesManager } from './opening-balances-manager';

export const metadata: Metadata = { title: 'Opening balances' };

// Spec: docs/modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28 ("Opening
// balances", "Screens"; decisions 306–308 in docs/BUILD_PLAN.md), SECURITY.md (the own time off
// and the team's: "The opening balances page needs Talent Write and HR or the System
// Administrator") and docs/DESIGN_SYSTEM.md#layout--components ("Opening balances").
//
// Talent Write **and** HR or the System Administrator: the guard runs first, before anything that
// can suspend, and anyone else gets `forbidden()`; the service checks again. The list loads inside
// the page's own boundary; loading errors go to the (pulse) error boundary. Each row has the VL,
// SL and offset openings and balances and "Year-to-date pay: Entered" or "Not entered", never an
// amount. `?employee=<employeeId>` opens that employee's sheet (the inspector's "Enter opening
// balances" links here). Nothing here is logged or cached.
export default async function OpeningBalancesPage() {
  const user = await requireModulePage('talent', 'write');
  if (!canManageOpeningBalances(user)) forbidden();
  return (
    <Suspense fallback={<OpeningBalancesLoading />}>
      <OpeningBalances user={user} />
    </Suspense>
  );
}

async function OpeningBalances({ user }: { user: CurrentUser }) {
  const view = await getOpeningBalances(user);
  return <OpeningBalancesManager view={view} />;
}
