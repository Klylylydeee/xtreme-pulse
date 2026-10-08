import { assertModuleAccess, type ModuleAccessHolder } from './auth/module-access';

// Spec: SECURITY.md#rules and docs/modules/core.md#managing-master-data (decision 83 in
// docs/BUILD_PLAN.md) — the shared master data is Core's, but each service checks the module that
// uses it, whoever calls it (the `/admin` screens included). The System Administrator always
// passes: their effective access is Owner on every module.
//
// | Record             | List and open | Create and edit | Retire and restore              |
// |--------------------|---------------|-----------------|---------------------------------|
// | Clients            | Engage Read   | Engage Write    | Engage Owner                    |
// | Sites and contacts | Engage Read   | Engage Write    | Engage Write (remove, restore)  |
// | Products           | Engage Read   | Engage Owner    | Engage Owner                    |
// | Catalog items      | Supply Read   | Supply Owner    | Supply Owner                    |
// | Suppliers          | Supply Read   | Supply Owner    | Supply Owner                    |
//
// The picker option lists need only a signed-in user, so they take no actor check here.

/** Who is acting on master data: the signed-in user (a `CurrentUser` fits). */
export type MasterDataActor = ModuleAccessHolder & { id: string; email: string };

/** A picker option: the id and name of a live record, and nothing else. */
export interface MasterDataOption {
  id: string;
  name: string;
}

const ASK = 'Ask HR or the System Administrator.';

/** Refuses anyone below Engage Read. */
export function assertEngageRead(actor: MasterDataActor): void {
  assertModuleAccess(actor, 'engage', 'read', `You need Engage Read access to see this. ${ASK}`);
}

/** Refuses anyone below Engage Write. */
export function assertEngageWrite(actor: MasterDataActor): void {
  assertModuleAccess(actor, 'engage', 'write', `You need Engage Write access to do this. ${ASK}`);
}

/** Refuses anyone below Engage Owner. */
export function assertEngageOwner(actor: MasterDataActor): void {
  assertModuleAccess(actor, 'engage', 'owner', `You need Engage Owner access to do this. ${ASK}`);
}

/** Refuses anyone below Supply Read. */
export function assertSupplyRead(actor: MasterDataActor): void {
  assertModuleAccess(actor, 'supply', 'read', `You need Supply Read access to see this. ${ASK}`);
}

/** Refuses anyone below Supply Owner. */
export function assertSupplyOwner(actor: MasterDataActor): void {
  assertModuleAccess(actor, 'supply', 'owner', `You need Supply Owner access to do this. ${ASK}`);
}
