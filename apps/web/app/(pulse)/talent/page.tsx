import type { Metadata } from 'next';
import { ModulePlaceholder } from '@/components/module-placeholder';

export const metadata: Metadata = { title: 'Pulse Talent' };

// Spec: docs/modules/talent.md. Step 1.6 adds the module access check before anything is read.
export default function TalentPage() {
  return <ModulePlaceholder href="/talent" />;
}
