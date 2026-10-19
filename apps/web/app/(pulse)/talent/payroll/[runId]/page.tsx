import type { Metadata } from 'next';
import { forbidden, notFound } from 'next/navigation';
import { OBJECT_ID_PATTERN } from '@pulse/core';
import { canSeePayrollRuns, getPayrollRunView } from '@pulse/talent/server';
import { requireModulePage } from '@/lib/auth';
import { PayrollRunScreen } from '../payroll-run-screen';

export const metadata: Metadata = { title: 'Payroll run' };

// Spec: docs/modules/talent.md#payroll-run-computation-build-step-29 ("Recomputing a draft", "Who
// may see and do what", "Screens": `/talent/payroll/<runId>`), SECURITY.md#sensitive-data
// ("Payroll runs") and docs/DESIGN_SYSTEM.md#layout--components ("Payroll runs on a phone").
//
// Talent Read **and** HR, Accounting or the System Administrator: the guard runs first and anyone
// else gets `forbidden()`; the service checks again. The run is awaited outside any Suspense
// boundary, as the time off request page does, so an unknown run is a real HTTP 404.
//
// The page always loads the run **without amounts** (`showAmounts` false): a render, a reload or a
// revalidation after "Recompute" never writes a reveal or sends an amount. Amounts come only from
// the explicit "Show amounts" and breakdown actions, which write their `reveal` audit entries
// first. The screen is keyed by the run's version, so amounts shown for one computation are
// dropped once it is recomputed. Nothing here is logged or cached.
export default async function PayrollRunPage({ params }: { params: Promise<{ runId: string }> }) {
  const user = await requireModulePage('talent', 'read');
  if (!canSeePayrollRuns(user)) forbidden();
  const { runId } = await params;
  if (!OBJECT_ID_PATTERN.test(runId)) notFound();
  const view = await getPayrollRunView(user, runId);
  if (!view) notFound();
  return <PayrollRunScreen key={`${view.id}:${view.version}`} view={view} />;
}
