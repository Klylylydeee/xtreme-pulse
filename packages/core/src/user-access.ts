import { z } from 'zod';
import { OBJECT_ID_PATTERN } from './audit';
import { type AccessLevel, MODULE_ACCESS_LEVELS, type ModuleAccess } from './module-access';
import { MODULES, type ModuleKey } from './modules';

// Spec: docs/modules/core.md#user-access-page and SECURITY.md#module-access-rwo — the User access
// page (build step 1.7, decisions 65–80 in docs/BUILD_PLAN.md): the sheet's schema, the level
// descriptions, the access summary chips and the "Needs access" rule. Pure code, safe in the
// browser, so the page and the access service (`@pulse/core/server`) share the same rules.

/** The module names the page shows, in {@link MODULES} order. */
export const MODULE_LABELS = {
  engage: 'Engage',
  ops: 'Ops',
  supply: 'Supply',
  desk: 'Desk',
  fiscal: 'Fiscal',
  talent: 'Talent',
  insight: 'Insight',
} as const satisfies Record<ModuleKey, string>;

/** The level names on the segmented control. */
export const ACCESS_LEVEL_LABELS = {
  none: 'None',
  read: 'Read',
  write: 'Write',
  owner: 'Owner',
} as const satisfies Record<AccessLevel, string>;

/** The one-letter codes of SECURITY.md#module-access-rwo, used in the summary chips. */
export const ACCESS_LEVEL_CODES = {
  none: '-',
  read: 'R',
  write: 'W',
  owner: 'O',
} as const satisfies Record<AccessLevel, string>;

/** The one-line description under each row's segmented control. */
export const ACCESS_LEVEL_DESCRIPTIONS = {
  none: 'Can’t see this module.',
  read: 'Can view records.',
  write: 'Can view, create and edit records.',
  owner: 'Full control: approve, void, delete and manage settings.',
} as const satisfies Record<AccessLevel, string>;

/** The hint the sheet shows for a Board of Directors member. It never grants anything. */
export const BOARD_ACCESS_HINT =
  'Board members normally need Insight Read for the Board dashboards, targets and weekly summary.';

/** Refusal when the sheet loaded an older `moduleAccessChangedAt` than the stored one. */
export const ACCESS_CHANGED_ELSEWHERE =
  'Someone else changed this user’s access. Reload to see it.';

/** Why a row is read-only, as the sheet says it. */
export const ACCESS_READ_ONLY_REASONS = {
  self: 'You can’t change your own access.',
  systemAccount: 'The system account’s access can’t be changed.',
  systemAdministrator: 'Only a System Administrator can change a System Administrator’s access.',
} as const;

export type AccessReadOnlyReason = keyof typeof ACCESS_READ_ONLY_REASONS;

/** One module's level: only the levels that module takes (None or Read on Insight). */
function levelField<M extends ModuleKey>(module: M) {
  return z.enum(MODULE_ACCESS_LEVELS[module], {
    error: `Choose a level for ${MODULE_LABELS[module]}.`,
  });
}

/** The ISO time the sheet loaded (`moduleAccessChangedAt`), or null when never changed. */
const expectedChangedAtField = z.preprocess(
  (value) => (value === '' || value === undefined ? null : value),
  z.union([z.iso.datetime({ offset: true }), z.null()], {
    error: 'Reload the page and try again.',
  }),
);

/**
 * What the sheet saves: every module's level (Insight only None or Read), the System
 * Administrator switch (sent only by a System Administrator), and the `moduleAccessChangedAt` the
 * sheet loaded, for the stale-form check.
 */
export const userAccessUpdateSchema = z.object({
  id: z.string().regex(OBJECT_ID_PATTERN, 'This user no longer exists. Reload the page.'),
  moduleAccess: z
    .object({
      engage: levelField('engage'),
      ops: levelField('ops'),
      supply: levelField('supply'),
      desk: levelField('desk'),
      fiscal: levelField('fiscal'),
      talent: levelField('talent'),
      insight: levelField('insight'),
    })
    .strict(),
  isSystemAdministrator: z.boolean().optional(),
  expectedChangedAt: expectedChangedAtField,
});

export type UserAccessUpdateInput = z.input<typeof userAccessUpdateSchema>;
export type UserAccessUpdate = z.output<typeof userAccessUpdateSchema>;

/** The highest level `module` takes (Read on Insight, Owner elsewhere). */
function highestLevel(module: ModuleKey): AccessLevel {
  const levels = MODULE_ACCESS_LEVELS[module] as readonly AccessLevel[];
  return levels[levels.length - 1] ?? 'none';
}

/** `level` capped at the highest level `module` takes. */
function capped(module: ModuleKey, level: AccessLevel): AccessLevel {
  return (MODULE_ACCESS_LEVELS[module] as readonly AccessLevel[]).includes(level)
    ? level
    : highestLevel(module);
}

/**
 * The compact summary chips of a user's access: one per module above None, such as
 * `['Talent R', 'Fiscal O']`, in {@link MODULES} order. When every module has the same level,
 * Insight counted at its own highest (Read) for Write and Owner, it is the single chip
 * `All modules R` (or W, O). None everywhere is no chip at all.
 */
export function accessSummary(moduleAccess: ModuleAccess): string[] {
  const first = moduleAccess[MODULES[0]];
  if (first !== 'none' && MODULES.every((m) => moduleAccess[m] === capped(m, first))) {
    return [`All modules ${ACCESS_LEVEL_CODES[first]}`];
  }
  return MODULES.filter((module) => moduleAccess[module] !== 'none').map(
    (module) => `${MODULE_LABELS[module]} ${ACCESS_LEVEL_CODES[moduleAccess[module]]}`,
  );
}

/**
 * True when `moduleAccess` (the stored map) is None on every module. The "Needs access" group
 * also leaves out System Administrators and the system account (the access service does that).
 */
export function needsAccess(moduleAccess: ModuleAccess): boolean {
  return MODULES.every((module) => moduleAccess[module] === 'none');
}

/** The modules whose level differs between `before` and `after`, in {@link MODULES} order. */
export function changedModules(before: ModuleAccess, after: ModuleAccess): ModuleKey[] {
  return MODULES.filter((module) => before[module] !== after[module]);
}
