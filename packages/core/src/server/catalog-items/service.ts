import type { ClientSession, Types } from 'mongoose';
import { connectDb, withTransaction } from '@pulse/db';
import { ActionError } from '../../actions';
import { now } from '../../dates';
import {
  type CatalogItemInput,
  catalogItemInputSchema,
  type CatalogItemUpdateInput,
  catalogItemUpdateSchema,
  type ItemKind,
} from '../../master-data';
import { recordAudit } from '../audit/service';
import { snapshotForAudit, snapshotsForAudit } from '../audit/snapshot';
import { type BrandRecord, BrandModel } from '../brands/model';
import { inputError } from '../departments/service';
import {
  assertSupplyOwner,
  assertSupplyRead,
  type MasterDataActor,
  type MasterDataOption,
} from '../master-data-access';
import { claimLiveBrand } from '../master-data-claims';
import { auditActor, auditLabel } from '../master-data-audit';
import { MASTER_DATA_COLLATION } from '../master-data-collation';
import { toObjectId } from '../paging';
import { isDuplicateKeyError } from '../seed/duplicate-key';
import { CatalogItemModel } from './model';

// Spec: docs/modules/core.md#managing-master-data and docs/modules/supply.md#stock — catalog items
// are Pulse Core master data, each under a product. Listing needs Supply Read; adding, editing,
// retiring and restoring need Supply Owner (the System Administrator always passes). Every change
// writes its audit entry (`core.catalogItem`) in the same transaction.
//
// - An item is added (or restored) only under a live product, and writes that product in its
//   transaction (`claimLiveBrand`), so a product retired at the same time conflicts with it.
// - The product and the item kind are fixed once created: an update carrying a different one is
//   refused.
// - Part numbers are unique within a product ignoring case, retired items included; re-adding a
//   retired part number is refused with a message that points to Restore.
// - Retiring is a soft delete (`deletedAt`). Later phases add blockers (stock, open documents).

const RECORD_TYPE = 'core.catalogItem';

const ITEM_GONE = 'This catalog item no longer exists. Reload the page.';
const PART_NUMBER_TAKEN =
  'This product already has a catalog item with this part number. Choose another part number.';
const PART_NUMBER_TAKEN_RETIRED =
  'A retired catalog item under this product already has this part number. Restore it instead of adding it again, or choose another part number.';
const BRAND_NOT_LIVE = 'Choose a product that isn’t retired.';

/** `<product> · <part number>`, or the part number alone when the product is missing. */
function nameOf(brand: Pick<BrandRecord, 'name'> | null, item: { partNumber: string }): string {
  return brand ? `${brand.name} · ${item.partNumber}` : item.partNumber;
}

/** The audit label: the item's name, cut to the audit log's label limit. */
function labelOf(brand: Pick<BrandRecord, 'name'> | null, item: { partNumber: string }): string {
  return brand ? auditLabel(brand.name, item.partNumber) : auditLabel(item.partNumber);
}

/** The item's product, retired or not, for the audit label. */
async function brandOf(
  brandId: Types.ObjectId,
  session: ClientSession,
): Promise<Pick<BrandRecord, 'name'> | null> {
  return BrandModel.findById(brandId, { name: 1 }, { withDeleted: true }).session(session).lean();
}

function rethrowDuplicatePartNumber(error: unknown): never {
  if (isDuplicateKeyError(error, 'partNumber')) {
    throw new ActionError(PART_NUMBER_TAKEN, { field: 'partNumber' });
  }
  throw error;
}

/** Refuses a part number another item under the product already has (retired ones included). */
async function assertPartNumberFree(
  brandId: Types.ObjectId,
  partNumber: string,
  exceptId: Types.ObjectId | null,
  session: ClientSession,
): Promise<void> {
  const filter: Record<string, unknown> = { brandId, partNumber };
  if (exceptId) filter._id = { $ne: exceptId };
  const taken = await CatalogItemModel.findOne(filter, { _id: 1, deletedAt: 1 })
    .setOptions({ withDeleted: true })
    .collation(MASTER_DATA_COLLATION)
    .session(session)
    .lean();
  if (taken) {
    throw new ActionError(taken.deletedAt ? PART_NUMBER_TAKEN_RETIRED : PART_NUMBER_TAKEN, {
      field: 'partNumber',
    });
  }
}

// --- Reading ---------------------------------------------------------------------------------

/** One row of the catalog items table. */
export interface CatalogItemView {
  id: string;
  brandId: string;
  /** The product's name, or null when the record is missing. */
  brandName: string | null;
  /** True when the product is retired (the item can't be restored until it is restored). */
  brandRetired: boolean;
  partNumber: string;
  description: string;
  unit: string;
  itemKind: ItemKind;
  defaultWarrantyMonths: number;
  /** When it was retired; null while it is live. */
  retiredAt: Date | null;
  updatedAt: Date;
}

/** A catalog item in a picker: live items only, named `<product> · <part number>`. */
export interface CatalogItemOption extends MasterDataOption {
  brandId: string;
}

/**
 * Every live catalog item, by product name and then part number, with retired ones too when
 * `includeRetired`. With `brandId`, only that product's. Supply Read.
 */
export async function listCatalogItems(
  actor: MasterDataActor,
  { brandId, includeRetired = false }: { brandId?: string | null; includeRetired?: boolean } = {},
): Promise<CatalogItemView[]> {
  assertSupplyRead(actor);
  await connectDb();

  const filter: Record<string, unknown> = {};
  if (brandId) {
    const id = toObjectId(brandId);
    if (!id) return [];
    filter.brandId = id;
  }
  const items = await CatalogItemModel.find(filter, null, { withDeleted: includeRetired }).lean();
  if (items.length === 0) return [];

  const brandIds = [
    ...new Map(items.map((item) => [item.brandId.toHexString(), item.brandId])).values(),
  ];
  const brands = await BrandModel.find(
    { _id: { $in: brandIds } },
    { name: 1, deletedAt: 1 },
    { withDeleted: true },
  ).lean();
  const brandById = new Map(brands.map((brand) => [brand._id.toHexString(), brand]));

  return items
    .map((item) => {
      const brand = brandById.get(item.brandId.toHexString());
      return {
        id: item._id.toHexString(),
        brandId: item.brandId.toHexString(),
        brandName: brand?.name ?? null,
        brandRetired: Boolean(brand?.deletedAt),
        partNumber: item.partNumber,
        description: item.description,
        unit: item.unit,
        itemKind: item.itemKind,
        defaultWarrantyMonths: item.defaultWarrantyMonths,
        retiredAt: item.deletedAt ?? null,
        updatedAt: item.updatedAt,
      };
    })
    .sort(
      (a, b) =>
        (a.brandName ?? '').localeCompare(b.brandName ?? '', 'en', { sensitivity: 'base' }) ||
        a.partNumber.localeCompare(b.partNumber, 'en', { sensitivity: 'base' }),
    );
}

/**
 * The live catalog items under live products, as id, `<product> · <part number>` and product id,
 * for pickers in any module; with `brandId`, only that product's. Any signed-in user may read it
 * (SECURITY.md#rules): the caller checks the session, so it takes no actor.
 */
export async function listCatalogItemOptions({
  brandId,
}: { brandId?: string | null } = {}): Promise<CatalogItemOption[]> {
  await connectDb();
  const brandFilter: Record<string, unknown> = {};
  if (brandId) {
    const id = toObjectId(brandId);
    if (!id) return [];
    brandFilter._id = id;
  }
  const brands = await BrandModel.find(brandFilter, { name: 1 }).lean();
  if (brands.length === 0) return [];
  const brandNames = new Map(brands.map((brand) => [brand._id.toHexString(), brand.name]));

  const items = await CatalogItemModel.find(
    { brandId: { $in: brands.map((brand) => brand._id) } },
    { brandId: 1, partNumber: 1 },
  ).lean();
  return items
    .map((item) => {
      const id = item.brandId.toHexString();
      return {
        id: item._id.toHexString(),
        name: nameOf({ name: brandNames.get(id) ?? '' }, item),
        brandId: id,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
}

// --- Changing --------------------------------------------------------------------------------

/** Adds a catalog item under a live product. Its product and item kind are fixed. Supply Owner. */
export async function createCatalogItem(
  actor: MasterDataActor,
  input: CatalogItemInput,
): Promise<{ id: string }> {
  assertSupplyOwner(actor);
  const parsed = catalogItemInputSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const { partNumber, description, unit, itemKind, defaultWarrantyMonths } = parsed.data;
  const brandId = toObjectId(parsed.data.brandId);
  if (!brandId) throw new ActionError(BRAND_NOT_LIVE, { field: 'brandId' });

  try {
    return await withTransaction(async (session) => {
      const brand = await claimLiveBrand(brandId, session);
      if (!brand) throw new ActionError(BRAND_NOT_LIVE, { field: 'brandId' });
      await assertPartNumberFree(brandId, partNumber, null, session);

      const [created] = await CatalogItemModel.create(
        [
          {
            brandId,
            partNumber,
            description,
            unit,
            itemKind,
            defaultWarrantyMonths,
            createdBy: toObjectId(actor.id),
          },
        ],
        { session },
      );
      if (!created) throw new Error('The catalog item wasn’t created.');
      await recordAudit(
        {
          ...auditActor(actor),
          module: 'core',
          action: 'create',
          record: { type: RECORD_TYPE, id: created._id, label: labelOf(brand, created) },
          before: null,
          after: snapshotForAudit(CatalogItemModel, created),
        },
        { session },
      );
      return { id: created._id.toHexString() };
    });
  } catch (error) {
    rethrowDuplicatePartNumber(error);
  }
}

/** Loads a catalog item in the transaction, retired ones included, or refuses. */
async function loadCatalogItem(id: string, session: ClientSession) {
  const itemId = toObjectId(id);
  if (!itemId) throw new ActionError(ITEM_GONE);
  const item = await CatalogItemModel.findById(itemId, null, { withDeleted: true })
    .session(session)
    .lean();
  if (!item) throw new ActionError(ITEM_GONE);
  return item;
}

/**
 * Changes a live catalog item's part number, description, unit and default warranty. The product
 * and the item kind can't be changed: an input carrying a different one is refused. Supply Owner.
 */
export async function updateCatalogItem(
  actor: MasterDataActor,
  id: string,
  input: CatalogItemUpdateInput,
): Promise<void> {
  assertSupplyOwner(actor);
  const { brandId: sentBrand, itemKind: sentKind } = input as {
    brandId?: unknown;
    itemKind?: unknown;
  };
  const parsed = catalogItemUpdateSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const { partNumber, description, unit, defaultWarrantyMonths } = parsed.data;

  try {
    await withTransaction(async (session) => {
      const before = await loadCatalogItem(id, session);
      if (sentBrand !== undefined && String(sentBrand) !== before.brandId.toHexString()) {
        throw new ActionError(
          'A catalog item’s product can’t be changed. Add a new item under the other product instead.',
          { field: 'brandId' },
        );
      }
      if (sentKind !== undefined && sentKind !== before.itemKind) {
        throw new ActionError(
          'A catalog item’s item kind can’t be changed. Add a new item instead.',
          { field: 'itemKind' },
        );
      }
      if (before.deletedAt) {
        throw new ActionError('This catalog item is retired. Restore it first to edit it.');
      }
      await assertPartNumberFree(before.brandId, partNumber, before._id, session);

      await CatalogItemModel.updateOne(
        { _id: before._id },
        {
          $set: {
            partNumber,
            description,
            unit,
            defaultWarrantyMonths,
            updatedBy: toObjectId(actor.id),
          },
        },
        { session, runValidators: true },
      );
      const after = await CatalogItemModel.findById(before._id).session(session).lean().orFail();
      const brand = await brandOf(before.brandId, session);
      await recordAudit(
        {
          ...auditActor(actor),
          module: 'core',
          action: 'update',
          record: { type: RECORD_TYPE, id: before._id, label: labelOf(brand, after) },
          ...snapshotsForAudit(CatalogItemModel, before, after),
        },
        { session },
      );
    });
  } catch (error) {
    rethrowDuplicatePartNumber(error);
  }
}

/** Retires (soft-deletes) a catalog item. Supply Owner. */
export async function retireCatalogItem(actor: MasterDataActor, id: string): Promise<void> {
  assertSupplyOwner(actor);

  await withTransaction(async (session) => {
    const before = await loadCatalogItem(id, session);
    if (before.deletedAt) throw new ActionError('This catalog item is already retired.');

    await CatalogItemModel.updateOne(
      { _id: before._id, deletedAt: null },
      { $set: { deletedAt: now(), updatedBy: toObjectId(actor.id) } },
      { session },
    );
    const brand = await brandOf(before.brandId, session);
    await recordAudit(
      {
        ...auditActor(actor),
        module: 'core',
        action: 'delete',
        record: { type: RECORD_TYPE, id: before._id, label: labelOf(brand, before) },
        before: snapshotForAudit(CatalogItemModel, before),
        after: null,
      },
      { session },
    );
  });
}

/** Restores a retired catalog item, unchanged. Its product must be live. Supply Owner. */
export async function restoreCatalogItem(actor: MasterDataActor, id: string): Promise<void> {
  assertSupplyOwner(actor);

  await withTransaction(async (session) => {
    const before = await loadCatalogItem(id, session);
    if (!before.deletedAt) throw new ActionError('This catalog item isn’t retired.');
    const brand = await claimLiveBrand(before.brandId, session);
    if (!brand) {
      throw new ActionError('This catalog item’s product is retired. Restore the product first.');
    }

    await CatalogItemModel.updateOne(
      { _id: before._id, deletedAt: { $ne: null } },
      { $set: { deletedAt: null, updatedBy: toObjectId(actor.id) } },
      { session },
    );
    const after = await CatalogItemModel.findById(before._id).session(session).lean().orFail();
    await recordAudit(
      {
        ...auditActor(actor),
        module: 'core',
        action: 'restore',
        record: { type: RECORD_TYPE, id: before._id, label: labelOf(brand, after) },
        ...snapshotsForAudit(CatalogItemModel, before, after),
      },
      { session },
    );
  });
}
