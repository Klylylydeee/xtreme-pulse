import type { Metadata } from 'next';
import { Suspense } from 'react';
import type { CurrentUser } from '@pulse/core/server';
import { getPayrollSettingsView } from '@pulse/talent/server';
import { requireModulePage } from '@/lib/auth';
import { PayrollSettingsLoading } from './payroll-settings-loading';
import { PayrollSettingsManager } from './payroll-settings-manager';

export const metadata: Metadata = { title: 'Payroll settings' };

// Spec: docs/modules/talent.md#payroll-settings-and-allowances-build-step-23 ("Payroll settings
// page", decisions 197, 198, 207 and 208 in docs/BUILD_PLAN.md) and SECURITY.md ("Payroll
// settings and allowances"). Talent Read (SECURITY.md#resolving-and-enforcing-build-step-16): the
// guard runs first, before anything that can suspend; the settings load inside the page's own
// boundary, and loading errors go to the (pulse) error boundary. The rates aren't sensitive. The
// service decides who may add a version (`canAddVersion`: Talent Owner and HR or the System
// Administrator) and who gets the minimum wage counts (HR, Accounting or the System
// Administrator); the actions check again. Nothing here is logged or cached.
export default async function PayrollSettingsPage() {
  const user = await requireModulePage('talent', 'read');
  return (
    <Suspense fallback={<PayrollSettingsLoading />}>
      <PayrollSettings user={user} />
    </Suspense>
  );
}

async function PayrollSettings({ user }: { user: CurrentUser }) {
  const view = await getPayrollSettingsView(user);
  return <PayrollSettingsManager view={view} />;
}
