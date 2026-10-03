// Spec: SECURITY.md#module-access-rwo — the ERP modules, a fixed set in code
// (docs/CODE_STYLE.md#constants-versus-data). Pulse Core is not one of them: it has no access
// level. Build step 1.6 adds the access levels and `requireModuleAccess` on top of this list.

/** Every ERP module's key, in the order SECURITY.md lists them. */
export const MODULES = ['engage', 'ops', 'supply', 'desk', 'fiscal', 'talent', 'insight'] as const;

export type ModuleKey = (typeof MODULES)[number];

/** True when `value` is one of {@link MODULES}. */
export function isModuleKey(value: unknown): value is ModuleKey {
  return typeof value === 'string' && (MODULES as readonly string[]).includes(value);
}
