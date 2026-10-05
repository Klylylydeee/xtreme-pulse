import { OrgStructureLoading } from '@/components/org-structure-loading';

/** The positions list while it loads (the page's `<Suspense>` fallback). */
export function PositionsLoading() {
  return <OrgStructureLoading label="Loading positions…" columns={4} filter />;
}
