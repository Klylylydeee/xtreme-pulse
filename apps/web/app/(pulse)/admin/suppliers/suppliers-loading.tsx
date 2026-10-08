import { OrgStructureLoading } from '@/components/org-structure-loading';

/** The suppliers list while it loads (the page's `<Suspense>` fallback). */
export function SuppliersLoading() {
  return <OrgStructureLoading label="Loading suppliers…" columns={5} filter />;
}
