import type { Metadata } from 'next';
import { ModulePlaceholder } from '@/components/module-placeholder';

export const metadata: Metadata = { title: 'Pulse Insight' };

// Spec: docs/modules/insight.md. Step 1.6 adds the module access check before anything is read.
export default function InsightPage() {
  return <ModulePlaceholder href="/insight" />;
}
