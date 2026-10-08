import { OrgStructureLoading } from '@/components/org-structure-loading';

/** The products list while it loads (the page's `<Suspense>` fallback). */
export function ProductsLoading() {
  return <OrgStructureLoading label="Loading products…" columns={2} />;
}
