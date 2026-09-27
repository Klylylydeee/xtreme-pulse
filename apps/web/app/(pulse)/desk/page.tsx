import type { Metadata } from 'next';
import { ModulePlaceholder } from '@/components/module-placeholder';

export const metadata: Metadata = { title: 'Pulse Desk' };

// Spec: docs/modules/desk.md. Step 1.6 adds the module access check before anything is read.
export default function DeskPage() {
  return <ModulePlaceholder href="/desk" />;
}
