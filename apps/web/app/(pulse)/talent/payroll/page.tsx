import type { Metadata } from 'next';
import { forbidden } from 'next/navigation';
import { Suspense } from 'react';
import type { CurrentUser } from '@pulse/core/server';
import { canSeePayrollRuns, listPayrollRuns } from '@pulse/talent/server';
import { requireModulePage } from '@/lib/auth';
import { PayrollRunsList } from './payroll-runs-list';
import { PayrollRunsLoading } from './payroll-runs-loading';

export const metadata: Metadata = { title: 'Payroll' };

// Spec: docs/modules/talent.md#payroll-run-computation-build-step-29 ("Creating a draft", "Who may
// see and do what", "Screens": `/talent/payroll`), SECURITY.md#sensitive-data ("Payroll runs") and
// docs/DESIGN_SYSTEM.md#layout--components ("Payroll runs on a phone").
//
// Talent Read **and** HR, Accounting or the System Administrator: the guard runs first, before
// anything that can suspend, and anyone else gets `forbidden()`; the service checks again. The list
// loads inside the page's own boundary; loading errors go to the (pulse) error boundary. It holds
// no amount: each run's period, pay date, number, status, counts and when it was computed.
// "Compute draft run" (Talent Write and HR or the System Administrator, the server's `canCompute`)
// opens a sheet with the ended cut-offs that have no run. Nothing here is logged or cached.
export default async function PayrollPage() {
  const user = await requireModulePage('talent', 'read');
  if (!canSeePayrollRuns(user)) forbidden();
  return (
    <Suspense fallback={<PayrollRunsLoading />}>
      <PayrollRuns user={user} />
    </Suspense>
  );
}

async function PayrollRuns({ user }: { user: CurrentUser }) {
  const view = await listPayrollRuns(user);
  return <PayrollRunsList view={view} />;
}
