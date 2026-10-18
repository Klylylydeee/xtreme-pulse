import { Types } from 'mongoose';
import { connectDb, withTransaction } from '@pulse/db';
import {
  AccessDeniedError,
  ActionError,
  type BusinessDate,
  businessToday,
  formatDate,
} from '@pulse/core';
import {
  addConfigVersion,
  type ConfigDate,
  ConfigVersionExistsError,
  defineConfigSetting,
  findConfigVersion,
  hasModuleAccess,
  recordAudit,
  reloadActorAccess,
} from '@pulse/core/server';
import {
  ONBOARDING_DOCUMENT_TYPES,
  type OnboardingSettings,
  type OnboardingSettingsInput,
  onboardingSettingsSchema,
  SEED_ONBOARDING_SETTINGS,
} from '../../onboarding/settings';
import type { OnboardingSettingsView } from '../../onboarding/views';
import { inputError } from '../input';
import { assertCanReadEmployeeRecords, type TalentActor } from '../policy';

// Spec: docs/DATA_MODEL.md#versioned-configuration (`talent.onboardingSettings`) and
// docs/modules/talent.md#onboarding-checklist-and-change-requests-build-step-26 ("Required
// documents"; decision 259 in docs/BUILD_PLAN.md) — the 201 document types the onboarding
// checklist asks for. Modelled on step 2.2's `talent.expiryAlerts`: a Talent Owner changes it from
// Settings on /talent, as a new version effective from today in Manila, at most one per Manila
// day, with a `create` entry on `core.configVersion` (module `core`), in one transaction that
// re-checks the actor. `pnpm seed:admin` seeds the first version (`../seed`).

export const ONBOARDING_SETTINGS_SETTING = defineConfigSetting(
  'talent.onboardingSettings',
  onboardingSettingsSchema,
);

/** The seeded version: from 2000-01-01, so it covers every date hired. */
export const ONBOARDING_SEED_VERSION = Object.freeze({
  effectiveFrom: '2000-01-01' as BusinessDate,
  value: SEED_ONBOARDING_SETTINGS,
  source: 'Company policy (spec)',
});

export const ONBOARDING_SETTINGS_DENIED =
  'Only a Talent Owner changes the required onboarding documents.';

/** True when `actor` may change the required onboarding documents (Talent Owner). */
export function canChangeOnboardingSettings(actor: TalentActor): boolean {
  return hasModuleAccess(actor, 'talent', 'owner');
}

function assertCanChangeOnboardingSettings(actor: TalentActor): void {
  if (!canChangeOnboardingSettings(actor)) throw new AccessDeniedError(ONBOARDING_SETTINGS_DENIED);
}

/**
 * The setting in effect on `on` (today by default), for the checklist. Before any version exists
 * (only before `pnpm seed:admin` has run) the seeded value applies.
 */
export async function onboardingSettingsOn(
  on: ConfigDate = businessToday(),
): Promise<OnboardingSettings> {
  await connectDb();
  const version = await findConfigVersion(ONBOARDING_SETTINGS_SETTING, on);
  const value = version?.value ?? SEED_ONBOARDING_SETTINGS;
  return { requiredDocumentTypes: [...value.requiredDocumentTypes] };
}

/** The setting for the Settings sheet on /talent: Talent Read. */
export async function getOnboardingSettings(actor: TalentActor): Promise<OnboardingSettingsView> {
  assertCanReadEmployeeRecords(actor);
  await connectDb();
  const today = businessToday();
  const version = await findConfigVersion(ONBOARDING_SETTINGS_SETTING, today);
  const value = version?.value ?? SEED_ONBOARDING_SETTINGS;
  return {
    requiredDocumentTypes: [...value.requiredDocumentTypes],
    options: [...ONBOARDING_DOCUMENT_TYPES],
    effectiveFrom: version?.effectiveFrom ?? null,
    source: version?.source ?? null,
    changedToday: version?.effectiveFrom === today,
    canChange: canChangeOnboardingSettings(actor),
  };
}

function alreadyChangedToday(today: BusinessDate): ActionError {
  return new ActionError(
    `The required onboarding documents were already changed today (${formatDate(today)}). Only one change can take effect per day: change them again tomorrow.`,
  );
}

/**
 * Changes the required documents: a new `talent.onboardingSettings` version effective from today
 * in Manila, with its `create` entry on `core.configVersion`. Talent Owner, checked again in the
 * transaction against the stored access. A second change on the same Manila day is refused.
 */
export async function addOnboardingSettingsVersion(
  actor: TalentActor,
  input: OnboardingSettingsInput,
): Promise<OnboardingSettingsView> {
  assertCanChangeOnboardingSettings(actor);
  const parsed = onboardingSettingsSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const value = parsed.data;
  const today = businessToday();
  await connectDb();

  try {
    const added = await withTransaction(async (session) => {
      const current = await reloadActorAccess({ id: actor.id }, session);
      assertCanChangeOnboardingSettings(current);
      const inEffect = await findConfigVersion(ONBOARDING_SETTINGS_SETTING, today, { session });
      if (inEffect?.effectiveFrom === today) throw alreadyChangedToday(today);
      const version = await addConfigVersion(ONBOARDING_SETTINGS_SETTING, {
        effectiveFrom: today,
        value,
        actorId: new Types.ObjectId(current.id),
        session,
      });
      await recordAudit(
        {
          actorId: current.id,
          actorEmail: current.email,
          module: 'core',
          action: 'create',
          record: {
            type: 'core.configVersion',
            id: version.id,
            label: `${ONBOARDING_SETTINGS_SETTING.key} from ${version.effectiveFrom}`,
          },
          before: null,
          after: {
            key: version.key,
            effectiveFrom: version.effectiveFrom,
            value: version.value,
            source: version.source,
          },
        },
        { session },
      );
      return version;
    });
    return {
      requiredDocumentTypes: [...added.value.requiredDocumentTypes],
      options: [...ONBOARDING_DOCUMENT_TYPES],
      effectiveFrom: added.effectiveFrom,
      source: added.source,
      changedToday: true,
      canChange: true,
    };
  } catch (error) {
    // Another change for today committed first (the unique key and effective date).
    if (error instanceof ConfigVersionExistsError) throw alreadyChangedToday(today);
    throw error;
  }
}
