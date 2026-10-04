import type { UpdateQuery } from 'mongoose';
import { ALLOWED_EMAIL_DOMAINS } from '../../account';
import { now } from '../../dates';
import { AllowedEmailDomainModel } from '../allowed-email-domains/model';
import { COMPANY_SETTINGS_KEY, CompanySettingsModel } from '../company-settings/model';
import { DepartmentModel } from '../departments/model';
import { LEGACY_POSITION_NAME_INDEX, POSITION_NAME_INDEX, PositionModel } from '../positions/model';
import { COMPANY_DETAIL_PLACEHOLDERS, SEED_DEPARTMENTS, SEED_POSITIONS } from './core-data';
import { isDuplicateKeyError } from './duplicate-key';

// Spec: docs/modules/core.md#bootstrap-system-administrator-account — each loader inserts only
// what is missing and never overwrites an existing record, so running the seed again, or on a
// database that already has data, only adds base data a new loader brings. A record an admin has
// retired (soft-deleted) counts as existing and is not added back.
//
// Later phases add their own loaders (leave types, payroll settings, holidays...) to the list the
// seed script runs.

export interface SeedLoaderResult {
  /** Records inserted. */
  added: number;
  /** Records that already existed and were left unchanged. */
  skipped: number;
  /** Missing fields filled in on an existing record, where the loader does that. */
  filled?: number;
}

export interface SeedLoader {
  /** Shown in the seed output, usually the collection name. */
  name: string;
  run(): Promise<SeedLoaderResult>;
}

// Just what insertIfMissing needs from a model. Each Mongoose 9 model has its own generic
// parameters, which don't unify under one `Model<T>`.
interface UpsertableModel {
  updateOne(
    filter: Record<string, unknown>,
    update: UpdateQuery<unknown>,
    options: { upsert: boolean; withDeleted: boolean; timestamps: boolean; runValidators: boolean },
  ): PromiseLike<{ upsertedCount: number }>;
}

/**
 * Inserts `fields` unless a record matches `filter`; a match is left exactly as it is. Returns
 * true when it inserted. Soft-deleted records match too.
 */
async function insertIfMissing(
  model: UpsertableModel,
  filter: Record<string, unknown>,
  fields: Record<string, unknown>,
): Promise<boolean> {
  const at = now();
  const result = await model.updateOne(
    filter,
    {
      $setOnInsert: {
        ...fields,
        createdAt: at,
        updatedAt: at,
        createdBy: null,
        updatedBy: null,
      },
    },
    // `timestamps: false` keeps Mongoose from adding `$set: { updatedAt }`, which would touch an
    // existing record.
    { upsert: true, withDeleted: true, timestamps: false, runValidators: true },
  );
  return result.upsertedCount > 0;
}

async function insertEachIfMissing<TItem>(
  items: readonly TItem[],
  insert: (item: TItem) => Promise<boolean>,
): Promise<SeedLoaderResult> {
  let added = 0;
  for (const item of items) {
    if (await insert(item)) added += 1;
  }
  return { added, skipped: items.length - added };
}

const allowedEmailDomainsLoader: SeedLoader = {
  name: 'allowedEmailDomains',
  run: () =>
    insertEachIfMissing(ALLOWED_EMAIL_DOMAINS, (domain) =>
      insertIfMissing(AllowedEmailDomainModel, { domain }, { domain }),
    ),
};

const departmentsLoader: SeedLoader = {
  name: 'departments',
  run: () =>
    insertEachIfMissing(SEED_DEPARTMENTS, ({ code, name }) =>
      insertIfMissing(DepartmentModel, { code }, { code, name }),
    ),
};

/**
 * Drops the case-sensitive `{ departmentId, name }` index that databases created before the
 * 2026-10-05 change still have, but only once `connectDb()` has built the case-insensitive one
 * beside it (positions/model.ts), so names stay unique throughout. When that one is missing (it
 * can't be built while a department holds two names that differ only in case), the old index is
 * kept and a warning printed straight away (writing the positions may then fail, ending the
 * seed). Does nothing once the old index is gone.
 */
async function dropLegacyPositionNameIndex(): Promise<void> {
  const indexes = await PositionModel.collection.indexes().catch((error: unknown) => {
    // NamespaceNotFound: no positions collection yet, so no old index either.
    if ((error as { code?: unknown }).code === 26) return [];
    throw error;
  });
  const names = new Set(indexes.map((index) => index.name));
  if (!names.has(LEGACY_POSITION_NAME_INDEX)) return;
  if (!names.has(POSITION_NAME_INDEX)) {
    console.warn(
      `positions: kept the old case-sensitive index ${LEGACY_POSITION_NAME_INDEX}, because the ` +
        `case-insensitive ${POSITION_NAME_INDEX} is missing. Rename any two positions in one ` +
        'department whose names differ only in case, then run the seed again.',
    );
    return;
  }
  await PositionModel.collection.dropIndex(LEGACY_POSITION_NAME_INDEX);
  console.log(`positions: dropped the old case-sensitive index ${LEGACY_POSITION_NAME_INDEX}`);
}

const positionsLoader: SeedLoader = {
  name: 'positions',
  async run() {
    await dropLegacyPositionNameIndex();
    const codes = [...new Set(SEED_POSITIONS.map((item) => item.departmentCode))];
    // Retired departments count too, so their seeded positions are found rather than re-added.
    const departments = await DepartmentModel.find({ code: { $in: codes } }, { code: 1 })
      .setOptions({ withDeleted: true })
      .lean();
    const departmentIds = new Map(
      departments.map((department) => [department.code, department._id]),
    );

    return insertEachIfMissing(
      SEED_POSITIONS,
      ({ seedKey, departmentCode, name, timesheetType }) => {
        const departmentId = departmentIds.get(departmentCode);
        if (!departmentId) {
          throw new Error(
            `Department ${departmentCode} is missing. Run the departments loader first.`,
          );
        }
        // A position an admin added by hand with the same name counts as this one; one that
        // differs only in case is refused by the case-insensitive unique index, and counts too.
        // MongoDB doesn't retry an upsert with an `$or` filter on a duplicate key, so when
        // another seed run inserts the same position at the same moment, count it as kept.
        return insertIfMissing(
          PositionModel,
          { $or: [{ seedKey }, { departmentId, name }] },
          { seedKey, departmentId, name, timesheetType },
        ).catch((error: unknown) => {
          if (isDuplicateKeyError(error)) return false;
          throw error;
        });
      },
    );
  },
};

// The company settings fields, as dotted paths, with their placeholders.
const COMPANY_DETAIL_FIELDS: ReadonlyArray<[string, string | null]> = [
  ['registeredName', COMPANY_DETAIL_PLACEHOLDERS.registeredName],
  ['businessAddress', COMPANY_DETAIL_PLACEHOLDERS.businessAddress],
  ['tin', COMPANY_DETAIL_PLACEHOLDERS.tin],
  ['rdoCode', COMPANY_DETAIL_PLACEHOLDERS.rdoCode],
  ['sssEmployerNumber', COMPANY_DETAIL_PLACEHOLDERS.sssEmployerNumber],
  ['philhealthEmployerNumber', COMPANY_DETAIL_PLACEHOLDERS.philhealthEmployerNumber],
  ['pagibigEmployerId', COMPANY_DETAIL_PLACEHOLDERS.pagibigEmployerId],
  [
    'birRegistration.casPermitDetails',
    COMPANY_DETAIL_PLACEHOLDERS.birRegistration.casPermitDetails,
  ],
  ['birRegistration.invoiceSeries', COMPANY_DETAIL_PLACEHOLDERS.birRegistration.invoiceSeries],
  ['logoFileId', null],
];

const companySettingsLoader: SeedLoader = {
  name: 'companySettings',
  async run() {
    const inserted = await insertIfMissing(
      CompanySettingsModel,
      { singletonKey: COMPANY_SETTINGS_KEY },
      { singletonKey: COMPANY_SETTINGS_KEY, ...COMPANY_DETAIL_PLACEHOLDERS, logoFileId: null },
    );
    if (inserted) return { added: 1, skipped: 0 };

    // The record exists: fill in only fields it doesn't have yet (a field added in a later
    // release), never touching a value that is there, even an empty string or a placeholder
    // (docs/modules/core.md#bootstrap-system-administrator-account: a loader may fill an absent
    // field, never change an existing value). The `$exists: false` filter makes each update
    // match nothing when the field is there, so a normal re-run writes nothing. `updatedAt` and
    // `updatedBy` stay as they are, so they keep saying who last edited the real details.
    let filled = 0;
    for (const [path, placeholder] of COMPANY_DETAIL_FIELDS) {
      const result = await CompanySettingsModel.updateOne(
        { singletonKey: COMPANY_SETTINGS_KEY, [path]: { $exists: false } },
        { $set: { [path]: placeholder } },
        { timestamps: false },
      );
      filled += result.modifiedCount;
    }
    return { added: 0, skipped: 1, filled };
  },
};

/** Core's base data loaders, in the order they must run (positions need departments). */
export const coreSeedLoaders: readonly SeedLoader[] = [
  allowedEmailDomainsLoader,
  departmentsLoader,
  positionsLoader,
  companySettingsLoader,
];
