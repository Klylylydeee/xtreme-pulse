import type { Metadata } from 'next';
import { ModulePlaceholder } from '@/components/module-placeholder';
import { requireModulePage } from '@/lib/auth';

export const metadata: Metadata = { title: 'Pulse Fiscal' };

// Spec: docs/modules/fiscal.md. Read access or higher (SECURITY.md#resolving-and-enforcing-build-step-16):
// the guard runs first, before anything is read; without it the page answers HTTP 403 with the
// no-access state. The module's data, once built, goes in an in-page <Suspense>.
export default async function FiscalPage() {
  await requireModulePage('fiscal', 'read');
  return <ModulePlaceholder href="/fiscal" />;
}
