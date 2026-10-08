import { OrgStructureLoading } from '@/components/org-structure-loading';

/** The catalog items list while it loads (the page's `<Suspense>` fallback). */
export function CatalogItemsLoading() {
  return <OrgStructureLoading label="Loading catalog items…" columns={6} filter />;
}
