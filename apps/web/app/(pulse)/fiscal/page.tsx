import type { Metadata } from 'next';
import { ModulePlaceholder } from '@/components/module-placeholder';

export const metadata: Metadata = { title: 'Pulse Fiscal' };

// Spec: docs/modules/fiscal.md. Step 1.6 adds the module access check before anything is read.
export default function FiscalPage() {
  return <ModulePlaceholder href="/fiscal" />;
}
