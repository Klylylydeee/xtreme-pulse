import type { Metadata } from 'next';
import { ModulePlaceholder } from '@/components/module-placeholder';

export const metadata: Metadata = { title: 'Pulse Engage' };

// Spec: docs/modules/engage.md. Step 1.6 adds the module access check before anything is read.
export default function EngagePage() {
  return <ModulePlaceholder href="/engage" />;
}
