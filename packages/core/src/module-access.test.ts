import { describe, expect, it } from 'vitest';
import {
  ACCESS_LEVELS,
  atLeast,
  emptyModuleAccess,
  fullModuleAccess,
  hasAnyModuleAccess,
  isAccessLevel,
  isLevelFor,
  MODULE_ACCESS_LEVELS,
  type ModuleAccess,
  normalizeModuleAccess,
  readableModules,
} from './module-access';
import { MODULES } from './modules';

// The module access levels (SECURITY.md#rules, docs/TESTING.md#module-access-tests): the level
// order, the Insight limit, a missing module reading as None, and the readable modules.

describe('access levels', () => {
  it('orders the levels None < Read < Write < Owner', () => {
    expect(ACCESS_LEVELS).toEqual(['none', 'read', 'write', 'owner']);
    ACCESS_LEVELS.forEach((level, index) => {
      ACCESS_LEVELS.forEach((min, minIndex) => {
        expect(atLeast(level, min)).toBe(index >= minIndex);
      });
    });
  });

  it('fails closed on a value that isn’t a level', () => {
    expect(atLeast('owner', 'admin' as never)).toBe(false);
    expect(atLeast('admin' as never, 'none')).toBe(false);
    expect(isAccessLevel('owner')).toBe(true);
    expect(isAccessLevel('Owner')).toBe(false);
    expect(isAccessLevel(undefined)).toBe(false);
  });

  it('limits Insight to None or Read, and gives every other module all four levels', () => {
    expect(MODULE_ACCESS_LEVELS.insight).toEqual(['none', 'read']);
    expect(isLevelFor('insight', 'read')).toBe(true);
    expect(isLevelFor('insight', 'write')).toBe(false);
    expect(isLevelFor('insight', 'owner')).toBe(false);
    for (const module of MODULES.filter((key) => key !== 'insight')) {
      expect(MODULE_ACCESS_LEVELS[module]).toEqual(ACCESS_LEVELS);
      expect(isLevelFor(module, 'owner')).toBe(true);
    }
    expect(Object.keys(MODULE_ACCESS_LEVELS).sort()).toEqual([...MODULES].sort());
  });
});

describe('module access maps', () => {
  it('starts every module at None', () => {
    const access = emptyModuleAccess();
    expect(Object.keys(access).sort()).toEqual([...MODULES].sort());
    expect(Object.values(access).every((level) => level === 'none')).toBe(true);
  });

  it('gives the full map Owner everywhere and Read on Insight', () => {
    const access = fullModuleAccess();
    for (const module of MODULES) {
      expect(access[module]).toBe(module === 'insight' ? 'read' : 'owner');
    }
  });

  it('reads a missing map, a missing module and an invalid level as None', () => {
    expect(normalizeModuleAccess(undefined)).toEqual(emptyModuleAccess());
    expect(normalizeModuleAccess(null)).toEqual(emptyModuleAccess());
    expect(normalizeModuleAccess('owner')).toEqual(emptyModuleAccess());
    expect(normalizeModuleAccess({})).toEqual(emptyModuleAccess());
    expect(
      normalizeModuleAccess({
        talent: 'read',
        fiscal: 'owner',
        insight: 'owner',
        engage: 'admin',
        ops: 'WRITE',
        unknown: 'owner',
      }),
    ).toEqual({ ...emptyModuleAccess(), talent: 'read', fiscal: 'owner' });
  });

  it('lists the modules at Read or higher, in module order', () => {
    expect(readableModules(emptyModuleAccess())).toEqual([]);
    const access: ModuleAccess = {
      ...emptyModuleAccess(),
      insight: 'read',
      talent: 'write',
      engage: 'owner',
      ops: 'read',
    };
    expect(readableModules(access)).toEqual(['engage', 'ops', 'talent', 'insight']);
    expect(readableModules(fullModuleAccess())).toEqual([...MODULES]);
  });

  it('has any module access only when one module is at Read or higher', () => {
    expect(hasAnyModuleAccess(emptyModuleAccess())).toBe(false);
    expect(hasAnyModuleAccess({ ...emptyModuleAccess(), insight: 'read' })).toBe(true);
    expect(hasAnyModuleAccess(fullModuleAccess())).toBe(true);
  });

  it('types Write and Owner on Insight as compile errors', () => {
    // @ts-expect-error Insight takes only None or Read.
    const invalid: ModuleAccess = { ...emptyModuleAccess(), insight: 'owner' };
    expect(isLevelFor('insight', invalid.insight)).toBe(false);
  });
});
