import type { Metadata } from 'next';
import { forbidden, notFound } from 'next/navigation';
import { AccessDeniedError, OBJECT_ID_PATTERN } from '@pulse/core';
import {
  canSeePayrollRuns,
  canSubmitPayrollRuns,
  getPayrollRunApproverView,
  getPayrollRunView,
  payrollCompanyDetailsWarning,
} from '@pulse/talent/server';
import { requireCurrentUser } from '@/lib/auth';
import { PayrollRunScreen } from '../payroll-run-screen';

export const metadata: Metadata = { title: 'Payroll run' };

// Spec: docs/modules/talent.md#payroll-run-computation-build-step-29 ("Recomputing a draft", "Who
// may see and do what", "Screens": `/talent/payroll/<runId>`),
// docs/modules/talent.md#payroll-review-approval-and-payslips-build-step-210 (step 2.10: "The
// Board's view while approving", "Who may see and do what", "Screens"),
// SECURITY.md#sensitive-data ("Payroll runs"), SECURITY.md#exceptions-to-module-access (the
// approver exception) and docs/DESIGN_SYSTEM.md#layout--components ("Payroll runs on a phone",
// "Payroll review and payslips on a phone").
//
// - Talent Read **and** HR, Accounting or the System Administrator get the payroll view
//   (`getPayrollRunView`), with the controls the server offers them.
// - Anyone else goes through the Board's view (`getPayrollRunApproverView`): a Board member who is
//   or was an approver of one of the run's requests sees it read-only, with no module access
//   needed; everyone else gets `forbidden()` (a real HTTP 403 with the no-access state). The
//   service is the guard, awaited first, outside any Suspense boundary, so an unknown run is a
//   real HTTP 404.
//
// The page always loads the run **without amounts** (`showAmounts` false): a render, a reload or a
// revalidation never writes a reveal or sends an amount. Amounts come only from the explicit "Show
// amounts" and breakdown actions, which write their `reveal` audit entries first. The screen is
// keyed by the run's id; it drops amounts shown for another version itself. The company details
// warning (no amount) is read only for someone who may submit an editable run. Nothing here is
// logged or cached.
export default async function PayrollRunPage({ params }: { params: Promise<{ runId: string }> }) {
  const user = await requireCurrentUser();
  const { runId } = await params;
  if (!OBJECT_ID_PATTERN.test(runId)) notFound();

  if (canSeePayrollRuns(user)) {
    const view = await getPayrollRunView(user, runId);
    if (!view) notFound();
    const canSubmit = view.editable && canSubmitPayrollRuns(user);
    const companyWarning = canSubmit ? await payrollCompanyDetailsWarning() : null;
    return (
      <PayrollRunScreen
        key={view.id}
        view={view}
        approver={null}
        canSubmit={canSubmit}
        companyWarning={companyWarning}
      />
    );
  }

  let view;
  try {
    view = await getPayrollRunApproverView(user, runId);
  } catch (error) {
    if (error instanceof AccessDeniedError) forbidden();
    throw error;
  }
  if (!view) notFound();
  const { approver, ...runView } = view;
  return (
    <PayrollRunScreen
      key={view.id}
      view={runView}
      approver={approver}
      canSubmit={false}
      companyWarning={null}
    />
  );
}
