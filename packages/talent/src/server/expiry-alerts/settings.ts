import { Types } from 'mongoose';
import { connectDb, withTransaction } from '@pulse/db';
import { ActionError, type BusinessDate, businessToday, formatDate } from '@pulse/core';
import {
  addConfigVersion,
  type ConfigDate,
  ConfigVersionExistsError,
  defineConfigSetting,
  findConfigVersion,
  recordAudit,
  reloadActorAccess,
} from '@pulse/core/server';
import {
  DEFAULT_EXPIRY_LEAD_DAYS,
  expiryAlertSettingsSchema,
  type ExpiryAlertSettingsInput,
} from '../../validation';
import type { ExpiryAlertSettingsView } from '../../views';
import { inputError } from '../input';
import {
  assertCanChangeExpiryAlertSettings,
  assertCanReadEmployeeRecords,
  canChangeExpiryAlertSettings,
  type TalentActor,
} from '../policy';

// Spec: docs/DATA_MODEL.md#versioned-configuration and
// docs/modules/talent.md#documents-photo-e-signature-and-certifications-build-step-22 (decision 187
// in docs/BUILD_PLAN.md) — the expiry alert lead days, the versioned setting `talent.expiryAlerts`:
// `documentLeadDays` and `certificationLeadDays`, each 1 to 180, 30 until a version is added.
// A Talent Owner changes them from Settings on /talent: a change is a new version effective from
// today in Manila, at most one per Manila day, with a `create` entry on `core.configVersion`
// (module `core`), in one transaction that re-checks the actor.

export const EXPIRY_ALERTS_SETTING = defineConfigSetting(
  'talent.expiryAlerts',
  expiryAlertSettingsSchema,
);

export interface ExpiryLeadDays {
  documentLeadDays: number;
  certificationLeadDays: number;
}

/** Used until a `talent.expiryAlerts` version is added. *Assumption, to be confirmed by HR.* */
export const DEFAULT_EXPIRY_LEAD_DAYS_SETTING: Readonly<ExpiryLeadDays> = Object.freeze({
  documentLeadDays: DEFAULT_EXPIRY_LEAD_DAYS,
  certificationLeadDays: DEFAULT_EXPIRY_LEAD_DAYS,
});

/** The lead days in effect on `on` (today by default), or the defaults. For services and the job. */
export async function expiryLeadDaysOn(on: ConfigDate = businessToday()): Promise<ExpiryLeadDays> {
  await connectDb();
  const version = await findConfigVersion(EXPIRY_ALERTS_SETTING, on);
  return version?.value ?? { ...DEFAULT_EXPIRY_LEAD_DAYS_SETTING };
}

/** The setting for the Settings sheet on /talent: Talent Read. */
export async function getExpiryAlertSettings(actor: TalentActor): Promise<ExpiryAlertSettingsView> {
  assertCanReadEmployeeRecords(actor);
  await connectDb();
  const today = businessToday();
  const version = await findConfigVersion(EXPIRY_ALERTS_SETTING, today);
  const value = version?.value ?? DEFAULT_EXPIRY_LEAD_DAYS_SETTING;
  return {
    documentLeadDays: value.documentLeadDays,
    certificationLeadDays: value.certificationLeadDays,
    effectiveFrom: version?.effectiveFrom ?? null,
    changedToday: version?.effectiveFrom === today,
    canChange: canChangeExpiryAlertSettings(actor),
  };
}

function alreadyChangedToday(today: BusinessDate): ActionError {
  return new ActionError(
    `The expiry alert settings were already changed today (${formatDate(today)}). Only one change can take effect per day: change them again tomorrow.`,
  );
}

/**
 * Changes the lead days: a new `talent.expiryAlerts` version effective from today in Manila, with
 * its `create` entry on `core.configVersion`. Talent Owner, checked again in the transaction
 * against the stored access. A second change on the same Manila day is refused.
 */
export async function updateExpiryAlertSettings(
  actor: TalentActor,
  input: ExpiryAlertSettingsInput,
): Promise<ExpiryAlertSettingsView> {
  assertCanChangeExpiryAlertSettings(actor);
  const parsed = expiryAlertSettingsSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const value = parsed.data;
  const today = businessToday();
  await connectDb();

  try {
    const added = await withTransaction(async (session) => {
      const current = await reloadActorAccess({ id: actor.id }, session);
      assertCanChangeExpiryAlertSettings(current);
      const inEffect = await findConfigVersion(EXPIRY_ALERTS_SETTING, today, { session });
      if (inEffect?.effectiveFrom === today) throw alreadyChangedToday(today);
      const version = await addConfigVersion(EXPIRY_ALERTS_SETTING, {
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
            label: `${EXPIRY_ALERTS_SETTING.key} from ${version.effectiveFrom}`,
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
      documentLeadDays: added.value.documentLeadDays,
      certificationLeadDays: added.value.certificationLeadDays,
      effectiveFrom: added.effectiveFrom,
      changedToday: true,
      canChange: true,
    };
  } catch (error) {
    // Another change for today committed first (the unique key and effective date).
    if (error instanceof ConfigVersionExistsError) throw alreadyChangedToday(today);
    throw error;
  }
}
