import { OrgStructureLoading } from '@/components/org-structure-loading';

/** The departments list while it loads (the page's `<Suspense>` fallback). */
export function DepartmentsLoading() {
  return <OrgStructureLoading label="Loading departments…" columns={5} />;
}
