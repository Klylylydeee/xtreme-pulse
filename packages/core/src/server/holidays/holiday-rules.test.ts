import { beforeAll, describe, expect, it } from 'vitest';
import { connectDb } from '@pulse/db';
import { businessToday } from '../../dates';
import { addConfigVersion, findConfigVersion, listConfigVersions } from '../config';
import { coreSeedLoaders } from '../seed/loaders';
import { HOLIDAY_RULES_SETTING, SEED_HOLIDAY_RULES } from './rules';

// The `core.holidayRules` seed loader (docs/TESTING.md#holiday-calendar-tests, "Rules setting";
// docs/modules/core.md#holiday-calendar). Made-up data only.

function holidayRulesLoader() {
  const loader = coreSeedLoaders.find((l) => l.name === 'holidayRules');
  if (!loader) throw new Error('No holidayRules loader.');
  return loader;
}

beforeAll(async () => {
  await connectDb();
});

describe('the holiday rules seed loader', () => {
  it('adds the first version, effective from the seed day, when there is none', async () => {
    expect(await holidayRulesLoader().run()).toEqual({ added: 1, skipped: 0 });
    const versions = await listConfigVersions(HOLIDAY_RULES_SETTING);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      effectiveFrom: businessToday(),
      value: SEED_HOLIDAY_RULES,
    });
    expect(versions[0]?.value).toHaveLength(18);
    // In effect from that day.
    expect(await findConfigVersion(HOLIDAY_RULES_SETTING, businessToday())).not.toBeNull();
  });

  it('changes nothing on a second run, or once another version exists', async () => {
    expect(await holidayRulesLoader().run()).toEqual({ added: 0, skipped: 1 });
    await addConfigVersion(HOLIDAY_RULES_SETTING, {
      effectiveFrom: '2099-01-01',
      value: SEED_HOLIDAY_RULES.slice(0, 1),
      actorId: null,
    });
    expect(await holidayRulesLoader().run()).toEqual({ added: 0, skipped: 1 });
    expect(await listConfigVersions(HOLIDAY_RULES_SETTING)).toHaveLength(2);
  });

  it('refuses a version that doesn’t match the schema', async () => {
    await expect(
      addConfigVersion(HOLIDAY_RULES_SETTING, {
        effectiveFrom: '2099-02-01',
        value: [{ key: 'bad', name: 'Bad', type: 'regular', kind: 'fixed', month: 2, day: 30 }],
        actorId: null,
      }),
    ).rejects.toThrow();
  });
});
