import type { Metadata } from 'next';
import { ModulePlaceholder } from '@/components/module-placeholder';

export const metadata: Metadata = { title: 'Pulse Supply' };

// Spec: docs/modules/supply.md. Step 1.6 adds the module access check before anything is read.
export default function SupplyPage() {
  return <ModulePlaceholder href="/supply" />;
}
