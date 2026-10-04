import { OrgStructureLoading } from '@/components/org-structure-loading';

/** The positions list while it loads. */
export default function PositionsLoading() {
  return <OrgStructureLoading label="Loading positions…" columns={4} filter />;
}
