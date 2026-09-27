import type { Metadata } from 'next';
import { ModulePlaceholder } from '@/components/module-placeholder';

export const metadata: Metadata = { title: 'Pulse Ops' };

// Spec: docs/modules/ops.md. Step 1.6 adds the module access check before anything is read.
export default function OpsPage() {
  return <ModulePlaceholder href="/ops" />;
}
