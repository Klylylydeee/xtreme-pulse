import { AccessDeniedError } from '../../actions';
import {
  atLeast,
  fullModuleAccess,
  type ModuleAccess,
  normalizeModuleAccess,
  type RequiredLevel,
} from '../../module-access';
import type { ModuleKey } from '../../modules';
import { isHR, isSystemAdministrator, type RoleHolder } from './roles';

// Spec: SECURITY.md#resolving-and-enforcing-build-step-16 — effective access is computed when the
// session user loads (decision 51 in docs/BUILD_PLAN.md), and every page, Server Action and Route
// Handler checks it for itself through one shared check (decision 61). The web app wraps these:
// `requireModuleAccess` (an AccessCheck) and `requireModulePage` (forbidden() on refusal), in
// apps/web/lib/auth.ts.

/** What resolveModuleAccess reads from a user record. */
export interface ModuleAccessSource {
  isSystemAdministrator: boolean;
  /** The stored map, as it is in the database: possibly absent, partial or holding bad values. */
  moduleAccess?: unknown;
}

/**
 * The effective access of a user record. A System Administrator (the bootstrap system account
 * included) gets Owner on every module and Read on Insight, and the stored values are ignored
 * (SECURITY.md#system-administrator). Anyone else gets the stored levels, with a missing or
 * invalid one read as None. A role grants no module access (SECURITY.md#roles).
 */
export function resolveModuleAccess(user: ModuleAccessSource): ModuleAccess {
  return user.isSystemAdministrator === true
    ? fullModuleAccess()
    : normalizeModuleAccess(user.moduleAccess);
}

/** What the module access checks read from a signed-in user (a `CurrentUser` fits). */
export interface ModuleAccessHolder {
  /** The effective map, from resolveModuleAccess. */
  moduleAccess: ModuleAccess;
}

/**
 * True when `user` has at least `level` on `module`. The level is typed per module, so Write on
 * Insight doesn't compile. No user means no access.
 *
 * The rare case where Write on Insight does compile: when `module` is typed as the whole
 * `ModuleKey` union (a variable or a loop over MODULES, not a literal), `M` is the union and
 * `RequiredLevel<ModuleKey>` is every module's levels together, Write and Owner included, so
 * `hasModuleAccess(user, someModule, 'write')` typechecks even when `someModule` is `'insight'`.
 * The runtime still refuses it: an effective Insight level is never above Read
 * (`normalizeModuleAccess` reads a stored Write or Owner as None, and the System Administrator
 * gets Read), so `atLeast` answers false.
 */
export function hasModuleAccess<M extends ModuleKey>(
  user: ModuleAccessHolder | null | undefined,
  module: M,
  level: RequiredLevel<M>,
): boolean {
  if (!user) return false;
  return atLeast(user.moduleAccess[module], level);
}

/** Throws {@link AccessDeniedError} unless `user` has at least `level` on `module`. */
export function assertModuleAccess<U extends ModuleAccessHolder, M extends ModuleKey>(
  user: U | null | undefined,
  module: M,
  level: RequiredLevel<M>,
  message?: string,
): asserts user is U {
  if (!hasModuleAccess(user, module, level)) throw new AccessDeniedError(message);
}

/**
 * Who opens the Pulse Core administration area, checked by role, not module access
 * (SECURITY.md#rules, decision 54): `hrOrSystemAdministrator` for `/admin`, `/admin/users`,
 * `/admin/departments` and `/admin/positions`; `systemAdministrator` for `/admin/settings` and
 * `/admin/audit`.
 */
export type AdminAreaKind = 'hrOrSystemAdministrator' | 'systemAdministrator';

/** True when `user` may open the admin pages of `kind`. No user means no. */
export function canOpenAdminArea(
  user: RoleHolder | null | undefined,
  kind: AdminAreaKind,
): boolean {
  if (!user) return false;
  if (isSystemAdministrator(user)) return true;
  return kind === 'hrOrSystemAdministrator' && isHR(user);
}
