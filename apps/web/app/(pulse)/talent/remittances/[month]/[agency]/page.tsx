import type { Metadata } from 'next';
import { forbidden, notFound } from 'next/navigation';
import { canSeeRemittances, getRemittanceReportPage } from '@pulse/talent/server';
import { requireModulePage } from '@/lib/auth';
import { RemittanceReportScreen } from '../../remittance-report-screen';

export const metadata: Metadata = { title: 'Remittance' };

// Spec: docs/modules/talent.md#employer-contributions-and-remittances-build-step-211 ("Screens":
// `/talent/remittances/<YYYY-MM>/<agency>`; decisions 385–396 in docs/BUILD_PLAN.md),
// SECURITY.md#sensitive-data ("Remittances") and docs/DESIGN_SYSTEM.md#layout--components
// ("Remittances on a phone").
//
// Talent Read **and** HR, Accounting or the System Administrator: the guard runs first and anyone
// else gets `forbidden()`; the service checks again. The page is awaited outside any Suspense
// boundary, so an unknown month or agency is a real HTTP 404.
//
// The page always loads **without** amounts or ID numbers: the status, due date, source runs,
// notes, counts and flags, and the payments' dates and references. "Show amounts" is the only way
// to the amounts (its action writes and commits the `reveal` first), and each export writes its
// `export` entry first. A render, a reload or a revalidation never writes either. Nothing here is
// logged or cached.
export default async function RemittancePage({
  params,
}: {
  params: Promise<{ month: string; agency: string }>;
}) {
  const user = await requireModulePage('talent', 'read');
  if (!canSeeRemittances(user)) forbidden();
  const { month, agency } = await params;
  const view = await getRemittanceReportPage(user, month, agency);
  if (!view) notFound();
  return (
    <RemittanceReportScreen
      key={`${view.month}:${view.agency}:${view.report?.version ?? 0}`}
      view={view}
    />
  );
}
