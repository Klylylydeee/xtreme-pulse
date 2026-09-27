import type { Metadata } from 'next';
import { ModulePlaceholder } from '@/components/module-placeholder';

export const metadata: Metadata = { title: 'Administration' };

// Spec: docs/modules/core.md. HR and the System Administrator only, checked on the server from step 1.6.
export default function AdminPage() {
  return <ModulePlaceholder href="/admin" />;
}
