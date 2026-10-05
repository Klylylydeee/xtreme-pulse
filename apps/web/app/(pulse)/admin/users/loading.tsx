import { OrgStructureLoading } from '@/components/org-structure-loading';

/** The users list while it loads. */
export default function UsersLoading() {
  return <OrgStructureLoading label="Loading users…" columns={6} filter />;
}
