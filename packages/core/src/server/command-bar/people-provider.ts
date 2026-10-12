import { directoryPersonHref } from '../../directory';
import { employeeName, searchActiveEmployees } from '../employees/active-employees';
import { EmployeeModel } from '../employees/model';
import { employeePhotoUrl } from '../employees/photo';
import { PositionModel } from '../positions/model';
import {
  type CommandProviderDefinition,
  type CommandProviderResult,
  hasCommandProvider,
  registerCommandProvider,
} from './registry';

// Spec: docs/modules/core.md#command-bar (decision 144 in docs/BUILD_PLAN.md) — Core's people
// provider finds active employees by name or employee number, for every signed-in user, and shows
// the name, employee number, position and profile photo, linking to their directory card. Separated people and
// the bootstrap system account (which has no employee record) never appear, whoever searches.
// Directory fields only (SECURITY.md#sensitive-data).

export const PEOPLE_PROVIDER_KEY = 'core.people';

export const peopleProvider: CommandProviderDefinition = {
  key: PEOPLE_PROVIDER_KEY,
  group: 'People',
  kind: 'records',
  // The directory is open to every signed-in user (SECURITY.md#rules).
  isVisibleTo: () => true,
  async search(query, _user, { limit }): Promise<CommandProviderResult[]> {
    // Active accounts only (searchActiveEmployees resolves each one).
    const found = (await searchActiveEmployees(query)).slice(0, limit);
    if (found.length === 0) return [];
    const assignments = await EmployeeModel.find(
      { _id: { $in: found.map((employee) => employee._id) } },
      { positionId: 1, photoFileId: 1 },
    ).lean();
    const positionIdOf = new Map(
      assignments.map((employee) => [
        employee._id.toHexString(),
        employee.positionId.toHexString(),
      ]),
    );
    const photoUrlOf = new Map(
      assignments.map((employee) => [
        employee._id.toHexString(),
        employeePhotoUrl(employee.photoFileId),
      ]),
    );
    // A retired position still shows its name.
    const positions = await PositionModel.find(
      { _id: { $in: assignments.map((employee) => employee.positionId) } },
      { name: 1 },
      { withDeleted: true },
    ).lean();
    const positionNames = new Map(positions.map((p) => [p._id.toHexString(), p.name]));

    return found.map((employee) => {
      const id = employee._id.toHexString();
      const position = positionNames.get(positionIdOf.get(id) ?? '');
      return {
        id,
        title: employeeName(employee),
        subtitle: position ? `${employee.employeeNumber} · ${position}` : employee.employeeNumber,
        href: directoryPersonHref(id),
        icon: 'person',
        photoUrl: photoUrlOf.get(id) ?? null,
      };
    });
  },
};

/**
 * Registers Core's command bar providers: `core.people` (Core registers no action provider in step
 * 1.11). Safe to call on every request; it registers each provider once per process.
 */
export function registerCoreCommandProviders(): void {
  if (!hasCommandProvider(PEOPLE_PROVIDER_KEY)) registerCommandProvider(peopleProvider);
}
