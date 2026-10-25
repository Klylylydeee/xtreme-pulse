import { connectDb } from '@pulse/db';
import { addConfigVersion, ConfigVersionExistsError, listConfigVersions } from '@pulse/core/server';
import type { SeedLoader, SeedLoaderResult } from '@pulse/core/server/seed';
import { PAYROLL_SETTING_KEYS, type PayrollSettingKey } from '../../payroll/schemas';
import {
  LEAVE_SEED_VERSION,
  PAYROLL_RUN_SEED_VERSION,
  PAYROLL_SEED_VERSIONS,
  REMITTANCE_SEED_VERSION,
} from '../payroll-settings/seed-data';
import {
  LEAVE_SETTINGS_SETTING,
  PAYROLL_RUN_SETTINGS_SETTING,
  PAYROLL_SETTINGS,
  REMITTANCE_SETTINGS_SETTING,
} from '../payroll-settings/settings';
import { ONBOARDING_SEED_VERSION, ONBOARDING_SETTINGS_SETTING } from '../onboarding/settings';

// Spec: docs/modules/core.md#bootstrap-system-administrator-account ("Talent payroll settings")
// and docs/modules/talent.md#payroll-settings-and-allowances-build-step-23 (decision 196 in
// docs/BUILD_PLAN.md) — Pulse Talent's seed loaders, run by `pnpm seed:admin` after Core's
// (`[...coreSeedLoaders, ...talentSeedLoaders]`). One loader per payroll setting, then the
// onboarding setting (build step 2.6, decision 259), the leave settings (build step 2.8), the
// payroll run settings (build step 2.9) and the remittance settings (build step 2.11):
//
// - It adds the setting's seeded versions only when the setting has no version at all, so a
//   later run never adds or replaces one, and a version HR added is left alone.
// - Seed writes are system writes (no actor) and write no audit entry.
// - Import from `@pulse/talent/server/seed` (server-only).

function payrollSettingLoader<K extends PayrollSettingKey>(key: K): SeedLoader {
  return {
    name: key,
    async run(): Promise<SeedLoaderResult> {
      await connectDb();
      const setting = PAYROLL_SETTINGS[key];
      const seeds = PAYROLL_SEED_VERSIONS[key];
      const existing = await listConfigVersions(setting);
      if (existing.length > 0) return { added: 0, skipped: seeds.length };
      let added = 0;
      for (const seed of seeds) {
        try {
          await addConfigVersion(setting, {
            effectiveFrom: seed.effectiveFrom,
            value: seed.value,
            source: seed.source,
            actorId: null,
          });
          added += 1;
        } catch (error) {
          // Another seed run added it at the same moment.
          if (!(error instanceof ConfigVersionExistsError)) throw error;
        }
      }
      return { added, skipped: seeds.length - added };
    },
  };
}

/**
 * `talent.onboardingSettings` (build step 2.6): the required onboarding documents, seeded once from
 * 2000-01-01 with a government ID copy and an NBI clearance, like the payroll settings.
 */
const onboardingSettingsLoader: SeedLoader = {
  name: ONBOARDING_SETTINGS_SETTING.key,
  async run(): Promise<SeedLoaderResult> {
    await connectDb();
    const existing = await listConfigVersions(ONBOARDING_SETTINGS_SETTING);
    if (existing.length > 0) return { added: 0, skipped: 1 };
    try {
      await addConfigVersion(ONBOARDING_SETTINGS_SETTING, {
        effectiveFrom: ONBOARDING_SEED_VERSION.effectiveFrom,
        value: { requiredDocumentTypes: [...ONBOARDING_SEED_VERSION.value.requiredDocumentTypes] },
        source: ONBOARDING_SEED_VERSION.source,
        actorId: null,
      });
      return { added: 1, skipped: 0 };
    } catch (error) {
      // Another seed run added it at the same moment.
      if (!(error instanceof ConfigVersionExistsError)) throw error;
      return { added: 0, skipped: 1 };
    }
  },
};

/**
 * `talent.leaveSettings` (build step 2.8, decision 323): the leave types, the offset time off
 * minimum and the go-live date (null), seeded once from 2000-01-01 like the payroll settings.
 */
const leaveSettingsLoader: SeedLoader = {
  name: LEAVE_SETTINGS_SETTING.key,
  async run(): Promise<SeedLoaderResult> {
    await connectDb();
    const existing = await listConfigVersions(LEAVE_SETTINGS_SETTING);
    if (existing.length > 0) return { added: 0, skipped: 1 };
    try {
      await addConfigVersion(LEAVE_SETTINGS_SETTING, {
        effectiveFrom: LEAVE_SEED_VERSION.effectiveFrom,
        value: structuredClone(LEAVE_SEED_VERSION.value),
        source: LEAVE_SEED_VERSION.source,
        actorId: null,
      });
      return { added: 1, skipped: 0 };
    } catch (error) {
      // Another seed run added it at the same moment.
      if (!(error instanceof ConfigVersionExistsError)) throw error;
      return { added: 0, skipped: 1 };
    }
  },
};

/**
 * `talent.payrollRunSettings` (build step 2.9, decision 326): the contribution bases, the
 * monthly-rated unworked special day and the adjustment lookback, seeded once from 2000-01-01 like
 * the payroll settings.
 */
const payrollRunSettingsLoader: SeedLoader = {
  name: PAYROLL_RUN_SETTINGS_SETTING.key,
  async run(): Promise<SeedLoaderResult> {
    await connectDb();
    const existing = await listConfigVersions(PAYROLL_RUN_SETTINGS_SETTING);
    if (existing.length > 0) return { added: 0, skipped: 1 };
    try {
      await addConfigVersion(PAYROLL_RUN_SETTINGS_SETTING, {
        effectiveFrom: PAYROLL_RUN_SEED_VERSION.effectiveFrom,
        value: structuredClone(PAYROLL_RUN_SEED_VERSION.value),
        source: PAYROLL_RUN_SEED_VERSION.source,
        actorId: null,
      });
      return { added: 1, skipped: 0 };
    } catch (error) {
      // Another seed run added it at the same moment.
      if (!(error instanceof ConfigVersionExistsError)) throw error;
      return { added: 0, skipped: 1 };
    }
  },
};

/**
 * `talent.remittanceSettings` (build step 2.11, decision 397): each agency's due date and the
 * reminder lead days, seeded once from 2000-01-01 like the payroll settings.
 */
const remittanceSettingsLoader: SeedLoader = {
  name: REMITTANCE_SETTINGS_SETTING.key,
  async run(): Promise<SeedLoaderResult> {
    await connectDb();
    const existing = await listConfigVersions(REMITTANCE_SETTINGS_SETTING);
    if (existing.length > 0) return { added: 0, skipped: 1 };
    try {
      await addConfigVersion(REMITTANCE_SETTINGS_SETTING, {
        effectiveFrom: REMITTANCE_SEED_VERSION.effectiveFrom,
        value: structuredClone(REMITTANCE_SEED_VERSION.value),
        source: REMITTANCE_SEED_VERSION.source,
        actorId: null,
      });
      return { added: 1, skipped: 0 };
    } catch (error) {
      // Another seed run added it at the same moment.
      if (!(error instanceof ConfigVersionExistsError)) throw error;
      return { added: 0, skipped: 1 };
    }
  },
};

/**
 * Pulse Talent's seed loaders: one per payroll setting, in the settings' order, then the
 * onboarding setting, then (from step 2.8) the leave settings, then (from step 2.9) the payroll
 * run settings, then (from step 2.11) the remittance settings.
 */
export const talentSeedLoaders: readonly SeedLoader[] = [
  ...PAYROLL_SETTING_KEYS.map((key) => payrollSettingLoader(key)),
  onboardingSettingsLoader,
  leaveSettingsLoader,
  payrollRunSettingsLoader,
  remittanceSettingsLoader,
];
