import type { OrgChartNode } from '../../directory';
import { employeeName } from '../employees/active-employees';
import { toObjectId } from '../paging';
import { isActive, loadPeople, toLink } from './people';

// Spec: docs/modules/core.md#org-chart (decisions 136, 146 and 147 in docs/BUILD_PLAN.md) — the
// org chart is built from `reportingTo`, for every signed-in user, with active people only (HR and
// System Administrators included). Each person is one node, with one line per shown supervisor;
// a line to a separated or inactive supervisor isn't drawn, and a person left with none sits at
// the top level. The department filter is applied here, on the server: that department's members
// and the lines among them, with the active supervisors outside it named for the "Reports to"
// caption. Directory fields only (people.ts). The layout is the web app's (org-chart-layout.ts).

export interface OrgChartOptions {
  departmentId?: string | null;
}

/** The org chart's people, in directory order (last name, then first name). */
export async function getOrgChart({ departmentId }: OrgChartOptions = {}): Promise<OrgChartNode[]> {
  let department = null;
  if (departmentId) {
    department = toObjectId(departmentId);
    if (!department) return [];
  }
  const people = await loadPeople({});
  const shown = people.list.filter(
    (person) =>
      isActive(people, person._id) && (!department || person.departmentId.equals(department)),
  );
  const shownIds = new Set(shown.map((person) => person._id.toHexString()));

  return shown.map((person) => {
    const supervisorIds: string[] = [];
    const externalSupervisors: OrgChartNode['externalSupervisors'] = [];
    const seen = new Set<string>();
    for (const supervisorId of person.reportingTo) {
      const hex = supervisorId.toHexString();
      if (seen.has(hex)) continue;
      seen.add(hex);
      const supervisor = people.byId.get(hex);
      if (!supervisor || !isActive(people, supervisor._id)) continue;
      if (shownIds.has(hex)) supervisorIds.push(hex);
      else externalSupervisors.push({ id: hex, name: employeeName(supervisor) });
    }
    const link = toLink(people, person);
    return {
      id: link.id,
      name: link.name,
      initials: link.initials,
      photoUrl: link.photoUrl,
      departmentId: person.departmentId.toHexString(),
      departmentName: link.departmentName,
      positionName: link.positionName,
      supervisorIds,
      externalSupervisors,
    };
  });
}
