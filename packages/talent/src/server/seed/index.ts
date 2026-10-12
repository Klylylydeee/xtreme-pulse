import { connectDb } from '@pulse/db';
import { addConfigVersion, ConfigVersionExistsError, listConfigVersions } from '@pulse/core/server';
import type { SeedLoader, SeedLoaderResult } from '@pulse/core/server/seed';
import { PAYROLL_SETTING_KEYS, type PayrollSettingKey } from '../../payroll/schemas';
import { PAYROLL_SEED_VERSIONS } from '../payroll-settings/seed-data';
import { PAYROLL_SETTINGS } from '../payroll-settings/settings';

// Spec: docs/modules/core.md#bootstrap-system-administrator-account ("Talent payroll settings")
// and docs/modules/talent.md#payroll-settings-and-allowances-build-step-23 (decision 196 in
// docs/BUILD_PLAN.md) — Pulse Talent's seed loaders, run by `pnpm seed:admin` after Core's
// (`[...coreSeedLoaders, ...talentSeedLoaders]`). One loader per payroll setting:
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

/** Pulse Talent's seed loaders: one per payroll setting, in the settings' order. */
export const talentSeedLoaders: readonly SeedLoader[] = PAYROLL_SETTING_KEYS.map((key) =>
  payrollSettingLoader(key),
);
