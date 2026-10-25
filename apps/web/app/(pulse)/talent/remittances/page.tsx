import type { Metadata } from 'next';
import { forbidden } from 'next/navigation';
import { Suspense } from 'react';
import type { CurrentUser } from '@pulse/core/server';
import { canSeeRemittances, listRemittances } from '@pulse/talent/server';
import { requireModulePage } from '@/lib/auth';
import { RemittancesList } from './remittances-list';
import { RemittancesLoading } from './remittances-loading';

export const metadata: Metadata = { title: 'Remittances' };

// Spec: docs/modules/talent.md#employer-contributions-and-remittances-build-step-211 ("Screens":
// `/talent/remittances`; decision 396 in docs/BUILD_PLAN.md), SECURITY.md#sensitive-data
// ("Remittances") and docs/DESIGN_SYSTEM.md#layout--components ("Remittances on a phone").
//
// Talent Read **and** HR, Accounting or the System Administrator: the guard runs first, before
// anything that can suspend, and anyone else gets `forbidden()`; the service checks again. The
// list loads inside the page's own boundary; loading errors go to the (pulse) error boundary. It
// holds no amount and no ID: each month's agencies with their status, due date and payment date
// and reference. Nothing here is logged or cached.
export default async function RemittancesPage() {
  const user = await requireModulePage('talent', 'read');
  if (!canSeeRemittances(user)) forbidden();
  return (
    <Suspense fallback={<RemittancesLoading />}>
      <Remittances user={user} />
    </Suspense>
  );
}

async function Remittances({ user }: { user: CurrentUser }) {
  const view = await listRemittances(user);
  return <RemittancesList view={view} />;
}
