'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { defineAction, MoneyError, OBJECT_ID_PATTERN, parsePesos } from '@pulse/core';
import {
  isPayrollSettingKey,
  PAYROLL_SETTING_SCHEMAS,
  payrollSettingsVersionSchema,
  WORK_REGIONS,
} from '@pulse/talent';
import { addPayrollSettingsVersion, listEmployeesBelowMinimumWage } from '@pulse/talent/server';
import { requireModuleAccess, signedInUser } from '@/lib/auth';

// Spec: docs/modules/talent.md#payroll-settings-and-allowances-build-step-23 and
// SECURITY.md ("Payroll settings and allowances"; decisions 197, 198 and 207 in
// docs/BUILD_PLAN.md) — the Server Actions behind `/talent/payroll-settings`.
//
// - "Add version" needs Talent Owner, checked here first; the service checks again that the user is
//   HR or the System Administrator, in its transaction, and writes the `create` entry on
//   `core.configVersion`.
// - The sheet sends every amount as typed, in pesos, under a key ending in `Centavos`. They are
//   converted here with `parsePesos` (exact, no floating point); a blank optional amount (the last
//   Pag-IBIG bracket, a de minimis share) becomes null. Days and counts arrive as digits. The value
//   is then checked against its setting's schema here, so every field error comes back at once
//   under `value.<path>`, and the service parses it again.
// - The wage order list needs Talent Read here; the service checks HR, Accounting or the System
//   Administrator. It holds no amount.
// - From step 2.7 (decision 279) the timesheet settings carry `submissionDeadlineDays`, a whole
//   number of days (1 to 10) added through the same "Add version" and its audit entry.
// - Nothing here is logged or cached.

const TALENT_READ = 'You don’t have access to Pulse Talent. Ask HR or the System Administrator.';
const TALENT_OWNER =
  'Only a Pulse Talent Owner in HR, or the System Administrator, can add a version. Ask HR or the System Administrator.';

const talentReaders = requireModuleAccess('talent', 'read', TALENT_READ);
const talentOwners = requireModuleAccess('talent', 'owner', TALENT_OWNER);

/** Whole-number fields the sheet sends as digits. */
const INTEGER_KEYS = new Set([
  'startDay',
  'endDay',
  'payDay',
  'dailyRateFactor',
  'hoursPerDay',
  // Step 2.7 (decision 279): the timesheet submission deadline, 1 to 10 days.
  'submissionDeadlineDays',
]);
/** Optional text fields whose blank means none. */
const NULLABLE_TEXT_KEYS = new Set(['rateOfMinimumWage', 'deMinimisKey']);

type Issue = { path: (string | number)[]; message: string };

/** One field of the sheet's value, from what was typed to what the schema takes. */
function convertField(key: string, raw: unknown, path: (string | number)[], issues: Issue[]) {
  if (typeof raw !== 'string') return raw;
  if (key.endsWith('Centavos')) {
    if (raw.trim() === '') return null;
    try {
      return parsePesos(raw);
    } catch (error) {
      issues.push({
        path,
        message: error instanceof MoneyError ? error.message : 'Enter a valid amount.',
      });
      return null;
    }
  }
  if (INTEGER_KEYS.has(key)) {
    const text = raw.trim();
    if (text === '') return undefined;
    // Left as text when it isn't digits, so the schema names the field.
    return /^\d{1,6}$/.test(text) ? Number(text) : text;
  }
  if (NULLABLE_TEXT_KEYS.has(key) && raw.trim() === '') return null;
  return raw;
}

/** The sheet's value with its amounts in centavos; problems are added to `issues`. */
function convertValue(
  value: unknown,
  path: (string | number)[],
  issues: Issue[],
  depth = 0,
): unknown {
  if (depth > 6) return value;
  if (Array.isArray(value)) {
    return value
      .slice(0, 500)
      .map((item, index) => convertValue(item, [...path, index], issues, depth + 1));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => {
        const itemPath = [...path, key];
        return [
          key,
          item !== null && typeof item === 'object'
            ? convertValue(item, itemPath, issues, depth + 1)
            : convertField(key, item, itemPath, issues),
        ];
      }),
    );
  }
  return value;
}

const pathOf = (path: PropertyKey[]) => path.map((part) => (typeof part === 'symbol' ? '' : part));

// The date, the source and every figure are checked together, so all their errors come back at
// once (the service parses everything again).
const addVersionSchema = z.record(z.string(), z.unknown()).transform((raw, ctx) => {
  const base = payrollSettingsVersionSchema.safeParse(raw);
  if (!base.success) {
    for (const issue of base.error.issues) {
      ctx.addIssue({ code: 'custom', path: pathOf(issue.path), message: issue.message });
    }
  }
  if (!isPayrollSettingKey(raw.key)) return z.NEVER;
  const issues: Issue[] = [];
  const value = convertValue(raw.value, ['value'], issues);
  for (const issue of issues) ctx.addIssue({ code: 'custom', ...issue });
  const parsed = PAYROLL_SETTING_SCHEMAS[raw.key].safeParse(value);
  if (!parsed.success) {
    const amountPaths = new Set(issues.map((issue) => issue.path.join('.')));
    for (const issue of parsed.error.issues) {
      const path = ['value', ...pathOf(issue.path)];
      // An amount that couldn't be read already has its own message.
      if (amountPaths.has(path.join('.'))) continue;
      ctx.addIssue({ code: 'custom', path, message: issue.message });
    }
  }
  if (!base.success || issues.length > 0 || !parsed.success) return z.NEVER;
  return { ...base.data, value };
});

/**
 * "Add version": a new version of one payroll setting from its effective date, with its source.
 * Returns the new version's id, key and date.
 */
export const addPayrollSettingsVersionAction = defineAction({
  access: talentOwners,
  schema: addVersionSchema,
  handler: async (input) => {
    const result = await addPayrollSettingsVersion(await signedInUser(), input);
    revalidatePath('/talent/payroll-settings');
    return result;
  },
});

/**
 * "View list" on a minimum wage version: the active employees in the region paid below it, with
 * no amounts. Null when the version or the region in it isn't there any more.
 */
export const listEmployeesBelowMinimumWageAction = defineAction({
  access: talentReaders,
  schema: z.object({
    versionId: z.string().regex(OBJECT_ID_PATTERN, 'Reload the page and try again.'),
    region: z.enum(WORK_REGIONS, { error: 'Reload the page and try again.' }),
  }),
  handler: async (input) => listEmployeesBelowMinimumWage(await signedInUser(), input),
});
