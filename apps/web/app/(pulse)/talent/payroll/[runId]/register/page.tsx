import type { Metadata } from 'next';
import { forbidden, notFound } from 'next/navigation';
import { OBJECT_ID_PATTERN } from '@pulse/core';
import { canSeePayrollRegister, getPayrollRegister } from '@pulse/talent/server';
import { requireModulePage } from '@/lib/auth';
import { PayrollRegisterScreen } from '../../payroll-register-screen';

export const metadata: Metadata = { title: 'Payroll register' };

// Spec: docs/modules/talent.md#payroll-review-approval-and-payslips-build-step-210 ("The payroll
// register", "Screens": `/talent/payroll/<runId>/register`), SECURITY.md#sensitive-data ("The
// payroll register") and docs/DESIGN_SYSTEM.md#layout--components ("Payroll review and payslips
// on a phone").
//
// Talent Read **and** HR, Accounting or the System Administrator: the guard runs first and anyone
// else gets `forbidden()` (a Board member as such never sees it); the service checks again. The
// register is awaited outside any Suspense boundary, so an unknown run is a real HTTP 404.
//
// The page always loads the register **without** account numbers or amounts (`show` false): the
// bank groups and their counts only, or "The register is available once the run is finalized." A
// render, a reload or a revalidation never writes a reveal. "Show register" is the only way to the
// account numbers and net pay, and its action writes and commits the `reveal` (field `register`)
// first. Nothing here is logged or cached.
export default async function PayrollRegisterPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const user = await requireModulePage('talent', 'read');
  if (!canSeePayrollRegister(user)) forbidden();
  const { runId } = await params;
  if (!OBJECT_ID_PATTERN.test(runId)) notFound();
  const view = await getPayrollRegister(user, runId);
  if (!view) notFound();
  return <PayrollRegisterScreen key={view.runId} view={view} />;
}
