import { OrgStructureLoading } from '@/components/org-structure-loading';

/** The clients list while it loads (the page's `<Suspense>` fallback). */
export function ClientsLoading() {
  return <OrgStructureLoading label="Loading clients…" columns={4} filter />;
}
