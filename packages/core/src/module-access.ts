import { MODULES, type ModuleKey } from './modules';

// Spec: SECURITY.md#module-access-rwo — every account holds one access level per ERP module.
// Levels are cumulative, and Pulse Insight is read-only, so it takes only None or Read
// (SECURITY.md#rules). The level is typed per module, so Write or Owner on Insight doesn't compile
// (decision 61 in docs/BUILD_PLAN.md). Pure code: safe on the server and in the browser. Resolving
// a user's effective access, and checking it, is server-only (`@pulse/core/server`).

/** The access levels, lowest to highest. Each one includes the ones before it. */
export const ACCESS_LEVELS = ['none', 'read', 'write', 'owner'] as const;

export type AccessLevel = (typeof ACCESS_LEVELS)[number];

/** The levels each module takes, lowest to highest. Insight has no Write or Owner. */
export const MODULE_ACCESS_LEVELS = {
  engage: ACCESS_LEVELS,
  ops: ACCESS_LEVELS,
  supply: ACCESS_LEVELS,
  desk: ACCESS_LEVELS,
  fiscal: ACCESS_LEVELS,
  talent: ACCESS_LEVELS,
  insight: ['none', 'read'],
} as const satisfies Record<ModuleKey, readonly AccessLevel[]>;

/** The levels module `M` takes (`'none' | 'read'` for Insight). */
export type LevelFor<M extends ModuleKey> = (typeof MODULE_ACCESS_LEVELS)[M][number];

/**
 * A level a page or action can require of module `M`: any of its levels but None. With `M` the
 * whole `ModuleKey` union it allows Write and Owner, Insight included; see `hasModuleAccess` for
 * why the runtime still refuses that.
 */
export type RequiredLevel<M extends ModuleKey> = Exclude<LevelFor<M>, 'none'>;

/** One level per module. */
export type ModuleAccess = { [M in ModuleKey]: LevelFor<M> };

/** True when `value` is one of {@link ACCESS_LEVELS}. */
export function isAccessLevel(value: unknown): value is AccessLevel {
  return typeof value === 'string' && (ACCESS_LEVELS as readonly string[]).includes(value);
}

/** True when `value` is a level `module` takes (Write or Owner on Insight is not). */
export function isLevelFor<M extends ModuleKey>(module: M, value: unknown): value is LevelFor<M> {
  return (
    typeof value === 'string' && (MODULE_ACCESS_LEVELS[module] as readonly string[]).includes(value)
  );
}

/** True when `level` is `min` or higher. A value that isn't a level fails closed (false). */
export function atLeast(level: AccessLevel, min: AccessLevel): boolean {
  const have = ACCESS_LEVELS.indexOf(level);
  const need = ACCESS_LEVELS.indexOf(min);
  return have >= 0 && need >= 0 && have >= need;
}

/** None on every module: a new account (SECURITY.md#rules). */
export function emptyModuleAccess(): ModuleAccess {
  return {
    engage: 'none',
    ops: 'none',
    supply: 'none',
    desk: 'none',
    fiscal: 'none',
    talent: 'none',
    insight: 'none',
  };
}

/** The highest level of every module: Owner, and Read on Insight (the System Administrator). */
export function fullModuleAccess(): ModuleAccess {
  return {
    engage: 'owner',
    ops: 'owner',
    supply: 'owner',
    desk: 'owner',
    fiscal: 'owner',
    talent: 'owner',
    insight: 'read',
  };
}

/**
 * Reads a stored map. A missing map, a missing module and a level the module doesn't take all
 * read as None, so accounts stored before the field existed need no migration.
 */
export function normalizeModuleAccess(stored: unknown): ModuleAccess {
  const access = emptyModuleAccess();
  if (typeof stored !== 'object' || stored === null) return access;
  const values = stored as Partial<Record<string, unknown>>;
  for (const module of MODULES) {
    const level = values[module];
    if (isLevelFor(module, level)) (access as Record<ModuleKey, AccessLevel>)[module] = level;
  }
  return access;
}

/** The modules `access` can at least read, in {@link MODULES} order. */
export function readableModules(access: ModuleAccess): ModuleKey[] {
  return MODULES.filter((module) => atLeast(access[module], 'read'));
}

/** False when `access` is None on every module (Home then shows "Your access is being set up"). */
export function hasAnyModuleAccess(access: ModuleAccess): boolean {
  return readableModules(access).length > 0;
}
