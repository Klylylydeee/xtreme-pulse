import { OrgStructureLoading } from '@/components/org-structure-loading';

/** The users list while it loads (the page's `<Suspense>` fallback). */
export function UsersLoading() {
  return <OrgStructureLoading label="Loading users…" columns={6} filter />;
}
