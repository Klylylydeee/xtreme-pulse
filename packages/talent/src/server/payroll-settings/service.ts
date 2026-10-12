import { type ClientSession, Types } from 'mongoose';
import { connectDb, withTransaction } from '@pulse/db';
import { ActionError, addDays, type BusinessDate, businessToday, formatDate } from '@pulse/core';
import {
  addConfigVersion,
  type ConfigSetting,
  type ConfigVersion,
  ConfigVersionExistsError,
  listConfigVersions,
  recordAudit,
  reloadActorAccess,
} from '@pulse/core/server';
import { latestEffectiveDate } from '../../compensation';
import { isCutOffStart } from '../../payroll/lookups';
import {
  PAYROLL_SETTING_KEYS,
  PAYROLL_SETTING_LABELS,
  PAYROLL_SETTING_SCHEMAS,
  type PayrollSettingKey,
  type PayrollSettingsVersionInput,
  payrollSettingsVersionSchema,
  type PayrollSettingValues,
  removedAllowanceTypeKeys,
} from '../../payroll/schemas';
import type {
  PayrollSettingsView,
  PayrollSettingVersionView,
  PayrollSettingView,
} from '../../payroll/views';
import { inputError } from '../input';
import { countEmployeesBelowMinimumWage } from '../minimum-wage/service';
import {
  assertCanAddPayrollSettingsVersion,
  assertCanReadEmployeeRecords,
  canAddPayrollSettingsVersion,
  canViewWageOrderList,
  type TalentActor,
} from '../policy';
import { isSeededVersion } from './seed-data';
import { PAYROLL_SETTINGS, payrollSettingVersionOn } from './settings';

// Spec: docs/modules/talent.md#payroll-settings-and-allowances-build-step-23 ("Payroll settings
// page"), SECURITY.md#module-access-rwo and docs/RUNBOOK.md#a-wrong-payroll-settings-version-was-added
// (decisions 197 and 198 in docs/BUILD_PLAN.md).
//
// - Viewing: Talent Read. Each setting's version in effect, its scheduled versions and its
//   history, read-only. Seeded versions are flagged.
// - Adding a version: Talent Owner and HR or the System Administrator, checked here and again in
//   the transaction against the stored access. The effective date is later than every existing
//   version of that setting (a past date is allowed) and at most a year ahead; a
//   `payrollSettings` version starts on a cut-off start day of its own schedule; the source is
//   required. An allowance type key is never removed. The `create` entry on `core.configVersion`
//   (module `core`, labelled `<key> from <date>`) is written in the same transaction.
// - Versions are never changed or withdrawn: a wrong one is replaced by a newer one.

type AnySetting = ConfigSetting<(typeof PAYROLL_SETTING_SCHEMAS)[PayrollSettingKey]>;

function settingOf(key: PayrollSettingKey): AnySetting {
  return PAYROLL_SETTINGS[key] as AnySetting;
}

async function versionsOf<K extends PayrollSettingKey>(
  key: K,
  session?: ClientSession,
): Promise<ConfigVersion<PayrollSettingValues[K]>[]> {
  return (await listConfigVersions(settingOf(key), { session })) as ConfigVersion<
    PayrollSettingValues[K]
  >[];
}

function settingView<K extends PayrollSettingKey>(
  key: K,
  versions: ConfigVersion<PayrollSettingValues[K]>[],
  today: BusinessDate,
): PayrollSettingView<K> {
  // Newest first (listConfigVersions sorts by effective date, descending).
  const inEffectId = versions.find((version) => version.effectiveFrom <= today)?.id ?? null;
  const history = versions.map((version): PayrollSettingVersionView<K> => ({
    id: version.id,
    effectiveFrom: version.effectiveFrom,
    value: version.value,
    source: version.source,
    seeded: isSeededVersion(key, version.effectiveFrom, version.source),
    status:
      version.effectiveFrom > today ? 'scheduled' : version.id === inEffectId ? 'inEffect' : 'past',
  }));
  const latest = versions[0];
  return {
    key,
    label: PAYROLL_SETTING_LABELS[key],
    inEffect: history.find((version) => version.status === 'inEffect') ?? null,
    scheduled: history.filter((version) => version.status === 'scheduled').reverse(),
    history,
    earliestEffectiveFrom: latest ? addDays(latest.effectiveFrom, 1) : null,
    latestEffectiveFrom: latestEffectiveDate(today),
  };
}

/**
 * `/talent/payroll-settings`: Talent Read. Every setting with its version in effect today, its
 * scheduled versions and its history. The minimum wage counts are added only for Talent Read and
 * HR, Accounting or the System Administrator.
 */
export async function getPayrollSettingsView(actor: TalentActor): Promise<PayrollSettingsView> {
  assertCanReadEmployeeRecords(actor);
  await connectDb();
  const today = businessToday();
  const entries = await Promise.all(
    PAYROLL_SETTING_KEYS.map(
      async (key) => [key, settingView(key, await versionsOf(key), today)] as const,
    ),
  );
  const view: PayrollSettingsView = {
    today,
    canAddVersion: canAddPayrollSettingsVersion(actor),
    settings: Object.fromEntries(entries) as PayrollSettingsView['settings'],
  };
  if (canViewWageOrderList(actor)) {
    view.minimumWageBelow = await countEmployeesBelowMinimumWage(actor);
  }
  return view;
}

function versionExists(key: PayrollSettingKey, day: BusinessDate): ActionError {
  return new ActionError(
    `A version of ${PAYROLL_SETTING_LABELS[key]} already takes effect on ${formatDate(day)}. Versions can’t be changed: add one with a later date.`,
    { field: 'effectiveFrom' },
  );
}

/** Checks a new version's date and value against the stored versions; throws ActionError. */
async function checkNewVersion(
  key: PayrollSettingKey,
  effectiveFrom: BusinessDate,
  value: PayrollSettingValues[PayrollSettingKey],
  versions: ConfigVersion<PayrollSettingValues[PayrollSettingKey]>[],
  today: BusinessDate,
  session: ClientSession,
): Promise<void> {
  const latest = versions[0];
  if (latest && effectiveFrom === latest.effectiveFrom) throw versionExists(key, effectiveFrom);
  if (latest && effectiveFrom < latest.effectiveFrom) {
    throw new ActionError(
      `The effective date must be after ${formatDate(latest.effectiveFrom)}, the latest version’s date. A wrong version is replaced by a newer one.`,
      { field: 'effectiveFrom' },
    );
  }
  if (effectiveFrom > latestEffectiveDate(today)) {
    throw new ActionError('The effective date can be at most a year from today.', {
      field: 'effectiveFrom',
    });
  }
  if (key === 'talent.payrollSettings') {
    const schedule = value as PayrollSettingValues['talent.payrollSettings'];
    if (!isCutOffStart(effectiveFrom, schedule)) {
      const days = schedule.cutOffs.map((c) => c.startDay).join(' or ');
      throw new ActionError(
        `A pay schedule must take effect on a cut-off start day (day ${days} of the month), so it never changes in the middle of a cut-off.`,
        { field: 'effectiveFrom' },
      );
    }
  }
  if (key === 'talent.allowanceTypes') {
    const next = value as PayrollSettingValues['talent.allowanceTypes'];
    for (const version of versions) {
      const removed = removedAllowanceTypeKeys(
        version.value as PayrollSettingValues['talent.allowanceTypes'],
        next,
      );
      if (removed.length > 0) {
        throw new ActionError(
          `Allowance types are never removed: keep ${removed.join(', ')} and mark it inactive instead.`,
          { field: 'value' },
        );
      }
    }
    const deMinimisKeys = next.types.flatMap((type) =>
      type.deMinimisKey ? [type.deMinimisKey] : [],
    );
    if (deMinimisKeys.length > 0) {
      const limits = await payrollSettingVersionOn('talent.deMinimisLimits', effectiveFrom, {
        session,
      });
      const known = new Set(limits?.value.items.map((item) => item.key) ?? []);
      const missing = deMinimisKeys.filter((k) => !known.has(k));
      if (missing.length > 0) {
        throw new ActionError(
          `No de minimis limit ${missing.join(', ')} is in effect on ${formatDate(effectiveFrom)}.`,
          { field: 'value' },
        );
      }
    }
  }
}

/**
 * "Add version": a new version of payroll setting `key` from `effectiveFrom`, with its source.
 * Talent Owner and HR or the System Administrator, checked again in the transaction. Returns the
 * new version's id and date.
 */
export async function addPayrollSettingsVersion(
  actor: TalentActor,
  input: PayrollSettingsVersionInput,
): Promise<{ id: string; key: PayrollSettingKey; effectiveFrom: BusinessDate }> {
  assertCanAddPayrollSettingsVersion(actor);
  const parsed = payrollSettingsVersionSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const { key, effectiveFrom, source } = parsed.data;
  const parsedValue = PAYROLL_SETTING_SCHEMAS[key].safeParse(parsed.data.value);
  if (!parsedValue.success) {
    throw inputError(
      parsedValue.error.issues.map((issue) => ({ ...issue, path: ['value', ...issue.path] })),
    );
  }
  const value = parsedValue.data;
  const today = businessToday();
  await connectDb();

  try {
    return await withTransaction(async (session) => {
      const current = await reloadActorAccess({ id: actor.id }, session);
      assertCanAddPayrollSettingsVersion(current);
      const versions = await versionsOf(key, session);
      await checkNewVersion(key, effectiveFrom, value, versions, today, session);
      const version = await addConfigVersion(settingOf(key), {
        effectiveFrom,
        value,
        source,
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
            label: `${key} from ${version.effectiveFrom}`,
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
      return { id: version.id, key, effectiveFrom: version.effectiveFrom };
    });
  } catch (error) {
    // Another version for that date committed first (the unique key and effective date).
    if (error instanceof ConfigVersionExistsError) throw versionExists(key, effectiveFrom);
    throw error;
  }
}
