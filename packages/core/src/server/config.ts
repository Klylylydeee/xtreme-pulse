import { Schema, type ClientSession, type Types } from 'mongoose';
import type { z } from 'zod';
import { baseSchemaPlugin, defineModel } from '@pulse/db';
import { guardWrites } from './write-guards';
import {
  assertBusinessDate,
  type BusinessDate,
  startOfBusinessDate,
  toBusinessDate,
} from '../dates';

// Spec: docs/DATA_MODEL.md#versioned-configuration and docs/adr/0008-versioned-configuration.md
//
// Rates and tables that change by law or policy (contribution tables, tax brackets, premium rates,
// minimum wages, the VAT rate, ATC codes) are stored as effective-dated versions, never hardcoded.
// A calculation uses the version in effect on the date it applies to. A change is a new version
// with its own effective date; an old version is never edited or deleted.
//
// Each module declares its settings with `defineConfigSetting` (a key and a Zod schema for the
// value) next to the code that uses them. Numbers in a value must be whole (centavos, counts);
// write rates as decimal strings (`"0.12"`). See findFractionalNumber.

/** A setting: its key and the schema every version's value must match. */
export interface ConfigSetting<TSchema extends z.ZodType> {
  /** `<module>.<name>`, for example `fiscal.vatRate` or `talent.sssContributionTable`. */
  readonly key: string;
  readonly schema: TSchema;
}

export interface ConfigVersion<TValue> {
  key: string;
  /** The Manila calendar day this version takes effect. */
  effectiveFrom: BusinessDate;
  value: TValue;
  /** Where the value comes from, for example the circular or revenue regulation. */
  source: string | null;
}

interface ConfigVersionRecord {
  key: string;
  /** 00:00 Manila on the effective date, stored in UTC (docs/DATA_MODEL.md#general). */
  effectiveFrom: Date;
  value: unknown;
  source: string | null;
  createdBy: Types.ObjectId | null;
}

const CONFIG_KEY = /^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/;

const configVersionSchema = new Schema<ConfigVersionRecord>({
  key: { type: String, required: true, immutable: true },
  effectiveFrom: { type: Date, required: true, immutable: true },
  // Mixed: each setting validates its own shape with Zod on write and on read.
  value: { type: Schema.Types.Mixed, required: true, immutable: true },
  source: { type: String, default: null, immutable: true },
});
configVersionSchema.index({ key: 1, effectiveFrom: -1 }, { unique: true });
// Append-only: versions are never deleted, so a past calculation can always be traced.
configVersionSchema.plugin(baseSchemaPlugin, { softDelete: false });

// A change is a new version, never an edit (docs/DATA_MODEL.md#versioned-configuration).
guardWrites(configVersionSchema, {
  message: 'Configuration versions are never edited or deleted. Add a new version.',
});

const ConfigVersionModel = defineModel('ConfigVersion', configVersionSchema, 'configVersions');

/**
 * The first number in `value` that isn't a safe integer, as a path (`brackets.2.rate`), or null.
 * Every number in a setting is whole: centavos, counts, days. Rates and factors are decimal
 * strings (`"0.12"`, `"1.25"`) that the money helpers read exactly with `ratio()`
 * (docs/adr/0006-money-as-integer-centavos.md). A fractional number is refused on write and read,
 * whatever the setting's schema says, because `0.1` is already inexact.
 */
function findFractionalNumber(value: unknown, path = 'value'): string | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? null : path;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findFractionalNumber(item, `${path}.${index}`);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === 'object' && value !== null && !(value instanceof Date)) {
    for (const [key, item] of Object.entries(value)) {
      const found = findFractionalNumber(item, `${path}.${key}`);
      if (found) return found;
    }
  }
  return null;
}

function fractionalNumberMessage(key: string, path: string): string {
  return `"${key}" has a number at ${path} that isn't a whole number. Store amounts in centavos and write rates as decimal strings, for example "0.12".`;
}

/** Thrown when no version of a setting is in effect on the date asked for. */
export class ConfigNotFoundError extends Error {
  constructor(key: string, on: BusinessDate) {
    super(`No version of the setting "${key}" is in effect on ${on}. Add one that starts earlier.`);
    this.name = 'ConfigNotFoundError';
  }
}

/** Declares a setting. Call once per setting, in the module that owns it. */
export function defineConfigSetting<TSchema extends z.ZodType>(
  key: string,
  schema: TSchema,
): ConfigSetting<TSchema> {
  if (!CONFIG_KEY.test(key)) {
    throw new Error(`"${key}" is not a setting key. Use "<module>.<name>" in camelCase.`);
  }
  return Object.freeze({ key, schema });
}

/** A calculation date: a business date, or an instant (read as its Manila calendar day). */
export type ConfigDate = BusinessDate | Date;

function toDay(on: ConfigDate): BusinessDate {
  return typeof on === 'string' ? assertBusinessDate(on) : toBusinessDate(on);
}

function toVersion<TSchema extends z.ZodType>(
  setting: ConfigSetting<TSchema>,
  record: Pick<ConfigVersionRecord, 'effectiveFrom' | 'value' | 'source'>,
): ConfigVersion<z.output<TSchema>> {
  const parsed = setting.schema.safeParse(record.value);
  if (!parsed.success || findFractionalNumber(parsed.data)) {
    // Name the setting and date only; never echo the stored value.
    throw new Error(
      `The stored version of "${setting.key}" from ${toBusinessDate(record.effectiveFrom)} doesn't match its schema.`,
    );
  }
  return {
    key: setting.key,
    effectiveFrom: toBusinessDate(record.effectiveFrom),
    value: parsed.data,
    source: record.source,
  };
}

export interface ConfigReadOptions {
  /** Read inside this transaction (so the calculation and its writes see one snapshot). */
  session?: ClientSession;
}

/**
 * The version of `setting` in effect on `on`: the one with the latest effective date on or before
 * that Manila day. Returns null when none is in effect yet.
 */
export async function findConfigVersion<TSchema extends z.ZodType>(
  setting: ConfigSetting<TSchema>,
  on: ConfigDate,
  { session }: ConfigReadOptions = {},
): Promise<ConfigVersion<z.output<TSchema>> | null> {
  const day = toDay(on);
  const record = await ConfigVersionModel.findOne(
    { key: setting.key, effectiveFrom: { $lte: startOfBusinessDate(day) } },
    { effectiveFrom: 1, value: 1, source: 1 },
    { session, sort: { effectiveFrom: -1 } },
  ).lean();
  return record ? toVersion(setting, record) : null;
}

/**
 * The value of `setting` in effect on `on`. Throws {@link ConfigNotFoundError} when none is.
 *
 * ```ts
 * const VAT_RATE = defineConfigSetting('fiscal.vatRate', z.string());
 * const rate = await resolveConfig(VAT_RATE, invoiceDate);   // "0.12"
 * const vat = scaleCentavos(subtotalCentavos, rate);
 * ```
 */
export async function resolveConfig<TSchema extends z.ZodType>(
  setting: ConfigSetting<TSchema>,
  on: ConfigDate,
  options: ConfigReadOptions = {},
): Promise<z.output<TSchema>> {
  const version = await findConfigVersion(setting, on, options);
  if (!version) throw new ConfigNotFoundError(setting.key, toDay(on));
  return version.value;
}

/** Every version of `setting`, newest first, for an admin history view. */
export async function listConfigVersions<TSchema extends z.ZodType>(
  setting: ConfigSetting<TSchema>,
  { session }: ConfigReadOptions = {},
): Promise<ConfigVersion<z.output<TSchema>>[]> {
  const records = await ConfigVersionModel.find(
    { key: setting.key },
    { effectiveFrom: 1, value: 1, source: 1 },
    { session, sort: { effectiveFrom: -1 } },
  ).lean();
  return records.map((record) => toVersion(setting, record));
}

export interface AddConfigVersionInput<TValue> {
  effectiveFrom: BusinessDate;
  value: TValue;
  source?: string | null;
  /** The user adding the version, or null for the system (seed scripts). */
  actorId: Types.ObjectId | null;
  session?: ClientSession;
}

/** Thrown when a version of the setting already starts on that date. */
export class ConfigVersionExistsError extends Error {
  constructor(key: string, effectiveFrom: BusinessDate) {
    super(
      `A version of "${key}" already takes effect on ${effectiveFrom}. Versions can't be edited: add one with a different date.`,
    );
    this.name = 'ConfigVersionExistsError';
  }
}

/**
 * Adds a new version of `setting`, taking effect on `effectiveFrom` (a Manila calendar day). The
 * value is checked against the setting's schema first.
 *
 * This is a service function: the caller checks module access and permissions first (step 1.6)
 * and writes the audit log entry (step 1.3), in the same transaction when there is one.
 */
export async function addConfigVersion<TSchema extends z.ZodType>(
  setting: ConfigSetting<TSchema>,
  {
    effectiveFrom,
    value,
    source = null,
    actorId,
    session,
  }: AddConfigVersionInput<z.input<TSchema>>,
): Promise<ConfigVersion<z.output<TSchema>>> {
  const day = assertBusinessDate(effectiveFrom);
  const parsed = setting.schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`The value for "${setting.key}" doesn't match its schema.`);
  }
  const fractional = findFractionalNumber(value) ?? findFractionalNumber(parsed.data);
  if (fractional) throw new Error(fractionalNumberMessage(setting.key, fractional));
  try {
    await ConfigVersionModel.create(
      [
        {
          key: setting.key,
          effectiveFrom: startOfBusinessDate(day),
          value: parsed.data,
          source,
          createdBy: actorId,
        },
      ],
      { session },
    );
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === 11000
    ) {
      throw new ConfigVersionExistsError(setting.key, day);
    }
    throw error;
  }
  return { key: setting.key, effectiveFrom: day, value: parsed.data, source };
}
