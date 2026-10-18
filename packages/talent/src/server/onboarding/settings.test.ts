import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { connectDb } from '@pulse/db';
import { AccessDeniedError, ActionError } from '@pulse/core';
import { addConfigVersion, listConfigVersions } from '@pulse/core/server';
import { talentSeedLoaders } from '../seed';
import {
  auditEntries,
  countAudit,
  type Department,
  department,
  type Person,
  person,
} from '../testing/fixtures';
import {
  addOnboardingSettingsVersion,
  getOnboardingSettings,
  ONBOARDING_SETTINGS_SETTING,
  onboardingSettingsOn,
} from './settings';

// The `talent.onboardingSettings` setting (docs/TESTING.md#onboarding-and-change-request-tests,
// "Settings"; decision 259 in docs/BUILD_PLAN.md): seeded once, a version naming an HR-issued
// type refused, a Talent Owner adds one effective today, a second the same day refused. "Today"
// is Monday 2026-09-14, 10:00 Manila. Made-up people only.

let NET: Department;
let owner: Person;
let writer: Person;
let reader: Person;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-14T10:00:00+08:00'));
  await connectDb();
  NET = await department('Network', 'NET');
  owner = await person('Oscar', 'Tan', NET, { talent: 'owner' });
  writer = await person('Wena', 'Cruz', NET, { talent: 'write' });
  reader = await person('Rico', 'Lim', NET, { talent: 'read' });
});

afterAll(() => {
  vi.useRealTimers();
});

async function runOnboardingLoader() {
  const loader = talentSeedLoaders.find((entry) => entry.name === 'talent.onboardingSettings');
  if (!loader) throw new Error('No onboarding settings loader.');
  return loader.run();
}

describe('seeding', () => {
  it('applies the seeded value before any version exists', async () => {
    expect(await onboardingSettingsOn()).toEqual({
      requiredDocumentTypes: ['governmentIdCopy', 'nbiClearance'],
    });
    expect((await getOnboardingSettings(reader.actor)).effectiveFrom).toBeNull();
  });

  it('seeds the setting once from 2000-01-01, with no audit entry; a second run adds nothing', async () => {
    const auditBefore = await countAudit();
    expect(await runOnboardingLoader()).toEqual({ added: 1, skipped: 0 });
    expect(await runOnboardingLoader()).toEqual({ added: 0, skipped: 1 });
    const versions = await listConfigVersions(ONBOARDING_SETTINGS_SETTING);
    expect(versions.map((v) => [v.effectiveFrom, v.source, v.value])).toEqual([
      [
        '2000-01-01',
        'Company policy (spec)',
        { requiredDocumentTypes: ['governmentIdCopy', 'nbiClearance'] },
      ],
    ]);
    expect(await countAudit()).toBe(auditBefore);
  });

  it('refuses a stored version naming the employment contract', async () => {
    await expect(
      addConfigVersion(ONBOARDING_SETTINGS_SETTING, {
        effectiveFrom: '2001-01-01',
        value: { requiredDocumentTypes: ['employmentContract'] },
        actorId: null,
      }),
    ).rejects.toThrow();
  });
});

describe('adding a version', () => {
  it('shows the setting to Talent Read, with the Settings button for a Talent Owner only', async () => {
    const view = await getOnboardingSettings(reader.actor);
    expect(view).toMatchObject({
      requiredDocumentTypes: ['governmentIdCopy', 'nbiClearance'],
      options: ['governmentIdCopy', 'nbiClearance', 'medicalCertificate', 'diplomaTor'],
      effectiveFrom: '2000-01-01',
      source: 'Company policy (spec)',
      changedToday: false,
      canChange: false,
    });
    expect((await getOnboardingSettings(owner.actor)).canChange).toBe(true);
  });

  it('refuses anyone but a Talent Owner', async () => {
    await expect(
      addOnboardingSettingsVersion(writer.actor, { requiredDocumentTypes: ['nbiClearance'] }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it('refuses a version naming the employment contract', async () => {
    await expect(
      addOnboardingSettingsVersion(owner.actor, {
        requiredDocumentTypes: ['nbiClearance', 'employmentContract'],
      }),
    ).rejects.toBeInstanceOf(ActionError);
  });

  it('adds a version effective today with a create entry on core.configVersion, and refuses a second the same day', async () => {
    const view = await addOnboardingSettingsVersion(owner.actor, {
      requiredDocumentTypes: ['nbiClearance'],
    });
    expect(view).toMatchObject({
      requiredDocumentTypes: ['nbiClearance'],
      effectiveFrom: '2026-09-14',
      changedToday: true,
    });
    expect(await onboardingSettingsOn()).toEqual({ requiredDocumentTypes: ['nbiClearance'] });
    expect(await onboardingSettingsOn('2026-09-13')).toEqual({
      requiredDocumentTypes: ['governmentIdCopy', 'nbiClearance'],
    });
    const entries = await auditEntries('core.configVersion');
    const last = entries.at(-1);
    expect(last).toMatchObject({
      module: 'core',
      action: 'create',
      record: { label: 'talent.onboardingSettings from 2026-09-14' },
    });

    await expect(
      addOnboardingSettingsVersion(owner.actor, { requiredDocumentTypes: [] }),
    ).rejects.toThrow(
      'The required onboarding documents were already changed today (Sep 14, 2026). Only one change can take effect per day: change them again tomorrow.',
    );
  });

  it('accepts an empty list the next day', async () => {
    vi.setSystemTime(new Date('2026-09-15T09:00:00+08:00'));
    const view = await addOnboardingSettingsVersion(owner.actor, { requiredDocumentTypes: [] });
    expect(view.requiredDocumentTypes).toEqual([]);
    expect(await onboardingSettingsOn()).toEqual({ requiredDocumentTypes: [] });
  });
});
