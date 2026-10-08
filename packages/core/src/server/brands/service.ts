import type { ClientSession, Types } from 'mongoose';
import { connectDb, withTransaction } from '@pulse/db';
import { ActionError } from '../../actions';
import { now } from '../../dates';
import { type BrandInput, brandInputSchema } from '../../master-data';
import { recordAudit } from '../audit/service';
import { snapshotForAudit, snapshotsForAudit } from '../audit/snapshot';
import { CatalogItemModel } from '../catalog-items/model';
import { countMap, countPipeline, type GroupCount, inputError } from '../departments/service';
import {
  assertEngageOwner,
  assertEngageRead,
  type MasterDataActor,
  type MasterDataOption,
} from '../master-data-access';
import { auditActor, auditLabel } from '../master-data-audit';
import { MASTER_DATA_COLLATION } from '../master-data-collation';
import { toObjectId } from '../paging';
import { isDuplicateKeyError } from '../seed/duplicate-key';
import { type BrandRecord, BrandModel } from './model';

// Spec: docs/modules/core.md#managing-master-data — products (`brands` in code, see
// docs/GLOSSARY.md) are Pulse Core master data. Listing needs Engage Read; adding, renaming,
// retiring and restoring need Engage Owner (the System Administrator always passes). The picker
// option list needs only a signed-in user. Every change writes its audit entry (`core.brand`) in
// the same transaction.
//
// - Names are unique ignoring case, retired products included; re-adding a retired name is refused
//   with a message that points to Restore.
// - Retiring is a soft delete (`deletedAt`), refused while the product has live catalog items. It
//   writes the product in its transaction, and adding or restoring a catalog item writes the
//   product too (`claimLiveBrand`), so the two conflict and neither lands on a stale read.
// - "General" and the other seeded products follow the same rules as any other product.

const RECORD_TYPE = 'core.brand';

const BRAND_GONE = 'This product no longer exists. Reload the page.';
const NAME_TAKEN = 'Another product already has this name. Choose another name.';
const NAME_TAKEN_RETIRED =
  'A retired product already has this name. Restore it instead of adding it again, or choose another name.';

function labelOf(brand: Pick<BrandRecord, 'name'>): string {
  return auditLabel(brand.name);
}

function rethrowDuplicateName(error: unknown): never {
  if (isDuplicateKeyError(error, 'name')) throw new ActionError(NAME_TAKEN, { field: 'name' });
  throw error;
}

/** Refuses a name another product already has, ignoring case (retired ones included). */
async function assertNameFree(
  name: string,
  exceptId: Types.ObjectId | null,
  session: ClientSession,
): Promise<void> {
  const filter: Record<string, unknown> = { name };
  if (exceptId) filter._id = { $ne: exceptId };
  const taken = await BrandModel.findOne(filter, { _id: 1, deletedAt: 1 })
    .setOptions({ withDeleted: true })
    .collation(MASTER_DATA_COLLATION)
    .session(session)
    .lean();
  if (taken) {
    throw new ActionError(taken.deletedAt ? NAME_TAKEN_RETIRED : NAME_TAKEN, { field: 'name' });
  }
}

// --- Reading ---------------------------------------------------------------------------------

/** One row of the products table. */
export interface BrandView {
  id: string;
  name: string;
  /** True for a product the seed script added (it can still be renamed and retired). */
  seeded: boolean;
  /** Live (not retired) catalog items under the product. */
  liveCatalogItemCount: number;
  /** When it was retired; null while it is live. */
  retiredAt: Date | null;
  updatedAt: Date;
}

/** A product in a picker: live products only. */
export type BrandOption = MasterDataOption;

/** Every live product, by name, with retired ones too when `includeRetired`. Engage Read. */
export async function listBrands(
  actor: MasterDataActor,
  { includeRetired = false }: { includeRetired?: boolean } = {},
): Promise<BrandView[]> {
  assertEngageRead(actor);
  await connectDb();

  const [brands, itemCounts] = await Promise.all([
    BrandModel.find({}, null, { withDeleted: includeRetired })
      .collation(MASTER_DATA_COLLATION)
      .sort({ name: 1, _id: 1 })
      .lean(),
    CatalogItemModel.aggregate<GroupCount>(countPipeline('brandId', { deletedAt: null })).then(
      countMap,
    ),
  ]);

  return brands.map((brand) => {
    const id = brand._id.toHexString();
    return {
      id,
      name: brand.name,
      seeded: brand.seedKey !== null,
      liveCatalogItemCount: itemCounts.get(id) ?? 0,
      retiredAt: brand.deletedAt ?? null,
      updatedAt: brand.updatedAt,
    };
  });
}

/**
 * The live products, by name, as id and name only, for pickers in any module. Any signed-in user
 * may read it (SECURITY.md#rules): the caller checks the session, so it takes no actor.
 */
export async function listBrandOptions(): Promise<BrandOption[]> {
  await connectDb();
  const brands = await BrandModel.find({}, { name: 1 })
    .collation(MASTER_DATA_COLLATION)
    .sort({ name: 1, _id: 1 })
    .lean();
  return brands.map((brand) => ({ id: brand._id.toHexString(), name: brand.name }));
}

// --- Changing --------------------------------------------------------------------------------

/** Adds a product. Engage Owner. */
export async function createBrand(
  actor: MasterDataActor,
  input: BrandInput,
): Promise<{ id: string }> {
  assertEngageOwner(actor);
  const parsed = brandInputSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const { name } = parsed.data;

  try {
    return await withTransaction(async (session) => {
      await assertNameFree(name, null, session);
      const [created] = await BrandModel.create([{ name, createdBy: toObjectId(actor.id) }], {
        session,
      });
      if (!created) throw new Error('The product wasn’t created.');
      await recordAudit(
        {
          ...auditActor(actor),
          module: 'core',
          action: 'create',
          record: { type: RECORD_TYPE, id: created._id, label: labelOf(created) },
          before: null,
          after: snapshotForAudit(BrandModel, created),
        },
        { session },
      );
      return { id: created._id.toHexString() };
    });
  } catch (error) {
    rethrowDuplicateName(error);
  }
}

/** Loads a product in the transaction, retired ones included, or refuses. */
async function loadBrand(id: string, session: ClientSession) {
  const brandId = toObjectId(id);
  if (!brandId) throw new ActionError(BRAND_GONE);
  const brand = await BrandModel.findById(brandId, null, { withDeleted: true })
    .session(session)
    .lean();
  if (!brand) throw new ActionError(BRAND_GONE);
  return brand;
}

/** Renames a live product (seeded ones included). Engage Owner. */
export async function updateBrand(
  actor: MasterDataActor,
  id: string,
  input: BrandInput,
): Promise<void> {
  assertEngageOwner(actor);
  const parsed = brandInputSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const { name } = parsed.data;

  try {
    await withTransaction(async (session) => {
      const before = await loadBrand(id, session);
      if (before.deletedAt) {
        throw new ActionError('This product is retired. Restore it first to edit it.');
      }
      await assertNameFree(name, before._id, session);

      await BrandModel.updateOne(
        { _id: before._id },
        { $set: { name, updatedBy: toObjectId(actor.id) } },
        { session, runValidators: true },
      );
      const after = await BrandModel.findById(before._id).session(session).lean().orFail();
      await recordAudit(
        {
          ...auditActor(actor),
          module: 'core',
          action: 'update',
          record: { type: RECORD_TYPE, id: before._id, label: labelOf(after) },
          ...snapshotsForAudit(BrandModel, before, after),
        },
        { session },
      );
    });
  } catch (error) {
    rethrowDuplicateName(error);
  }
}

/**
 * Retires (soft-deletes) a product. Refused while it has live catalog items. Engage Owner.
 *
 * The count and the write to the product run in one transaction; a catalog item added or restored
 * at the same time writes the product too, so one of the two conflicts and is retried.
 */
export async function retireBrand(actor: MasterDataActor, id: string): Promise<void> {
  assertEngageOwner(actor);

  await withTransaction(async (session) => {
    const before = await loadBrand(id, session);
    if (before.deletedAt) throw new ActionError('This product is already retired.');

    const items = await CatalogItemModel.countDocuments({ brandId: before._id }).session(session);
    if (items > 0) {
      throw new ActionError(
        `This product still has ${items} live catalog ${items === 1 ? 'item' : 'items'}. Retire ${items === 1 ? 'it' : 'them'} first.`,
      );
    }

    await BrandModel.updateOne(
      { _id: before._id, deletedAt: null },
      { $set: { deletedAt: now(), updatedBy: toObjectId(actor.id) } },
      { session },
    );
    await recordAudit(
      {
        ...auditActor(actor),
        module: 'core',
        action: 'delete',
        record: { type: RECORD_TYPE, id: before._id, label: labelOf(before) },
        before: snapshotForAudit(BrandModel, before),
        after: null,
      },
      { session },
    );
  });
}

/** Restores a retired product, unchanged. Engage Owner. */
export async function restoreBrand(actor: MasterDataActor, id: string): Promise<void> {
  assertEngageOwner(actor);

  await withTransaction(async (session) => {
    const before = await loadBrand(id, session);
    if (!before.deletedAt) throw new ActionError('This product isn’t retired.');

    await BrandModel.updateOne(
      { _id: before._id, deletedAt: { $ne: null } },
      { $set: { deletedAt: null, updatedBy: toObjectId(actor.id) } },
      { session },
    );
    const after = await BrandModel.findById(before._id).session(session).lean().orFail();
    await recordAudit(
      {
        ...auditActor(actor),
        module: 'core',
        action: 'restore',
        record: { type: RECORD_TYPE, id: before._id, label: labelOf(after) },
        ...snapshotsForAudit(BrandModel, before, after),
      },
      { session },
    );
  });
}
