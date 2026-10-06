import { describe, expect, it } from 'vitest';
import { emptyModuleAccess, fullModuleAccess, type ModuleAccess } from './module-access';
import { accessSummary, changedModules, needsAccess, userAccessUpdateSchema } from './user-access';

// The User access sheet's schema and summaries (docs/modules/core.md#user-access-page,
// docs/TESTING.md#user-access-tests). Pure code, no database.

const ID = '0123456789abcdef01234567';

function input(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    moduleAccess: { ...emptyModuleAccess(), talent: 'write' },
    expectedChangedAt: null,
    ...overrides,
  };
}

describe('userAccessUpdateSchema', () => {
  it('accepts every module’s levels, Read on Insight, and a loaded change time', () => {
    expect(userAccessUpdateSchema.safeParse(input()).success).toBe(true);
    const parsed = userAccessUpdateSchema.safeParse(
      input({
        moduleAccess: fullModuleAccess(),
        isSystemAdministrator: true,
        expectedChangedAt: '2026-10-05T01:02:03.004Z',
      }),
    );
    expect(parsed.success).toBe(true);
    // An empty change time (never changed) reads as null.
    expect(userAccessUpdateSchema.parse(input({ expectedChangedAt: '' })).expectedChangedAt).toBe(
      null,
    );
  });

  it('refuses Write or Owner on Insight, unknown levels and modules, and a missing module', () => {
    for (const insight of ['write', 'owner']) {
      const moduleAccess = { ...emptyModuleAccess(), insight };
      expect(userAccessUpdateSchema.safeParse(input({ moduleAccess })).success, insight).toBe(
        false,
      );
    }
    const unknownLevel = { ...emptyModuleAccess(), talent: 'admin' };
    expect(userAccessUpdateSchema.safeParse(input({ moduleAccess: unknownLevel })).success).toBe(
      false,
    );
    const unknownModule = { ...emptyModuleAccess(), payroll: 'read' };
    expect(userAccessUpdateSchema.safeParse(input({ moduleAccess: unknownModule })).success).toBe(
      false,
    );
    const missing: Partial<ModuleAccess> = emptyModuleAccess();
    delete missing.fiscal;
    expect(userAccessUpdateSchema.safeParse(input({ moduleAccess: missing })).success).toBe(false);
    expect(userAccessUpdateSchema.safeParse(input({ id: 'not-an-id' })).success).toBe(false);
    expect(
      userAccessUpdateSchema.safeParse(input({ expectedChangedAt: 'yesterday' })).success,
    ).toBe(false);
  });
});

describe('accessSummary', () => {
  it('lists each module above None, in module order', () => {
    expect(accessSummary({ ...emptyModuleAccess(), fiscal: 'owner', talent: 'read' })).toEqual([
      'Fiscal O',
      'Talent R',
    ]);
    expect(accessSummary(emptyModuleAccess())).toEqual([]);
  });

  it('reads "All modules" when every module has the same level, Insight at Read', () => {
    expect(accessSummary(fullModuleAccess())).toEqual(['All modules O']);
    const allRead = { ...fullModuleAccess(), engage: 'read', ops: 'read', supply: 'read' } as const;
    expect(
      accessSummary({ ...allRead, desk: 'read', fiscal: 'read', talent: 'read', insight: 'read' }),
    ).toEqual(['All modules R']);
    // Insight None breaks the run.
    expect(accessSummary({ ...fullModuleAccess(), insight: 'none' })).toHaveLength(6);
  });
});

describe('who needs access', () => {
  it('is None stored on every module', () => {
    expect(needsAccess(emptyModuleAccess())).toBe(true);
    expect(needsAccess({ ...emptyModuleAccess(), insight: 'read' })).toBe(false);
  });

  it('lists the changed modules', () => {
    expect(
      changedModules(emptyModuleAccess(), { ...emptyModuleAccess(), talent: 'write', ops: 'read' }),
    ).toEqual(['ops', 'talent']);
    expect(changedModules(emptyModuleAccess(), emptyModuleAccess())).toEqual([]);
  });
});
