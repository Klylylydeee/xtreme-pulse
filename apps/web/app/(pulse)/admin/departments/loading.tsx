import { OrgStructureLoading } from '@/components/org-structure-loading';

/** The departments list while it loads. */
export default function DepartmentsLoading() {
  return <OrgStructureLoading label="Loading departments…" columns={5} />;
}
