import type { ClientSession, Types } from 'mongoose';
import { connectDb, withTransaction } from '@pulse/db';
import { ActionError } from '../../actions';
import { now } from '../../dates';
import {
  formatTin,
  type SupplierInput,
  supplierInputSchema,
  type SupplierType,
  type SupplierUpdateInput,
  supplierUpdateSchema,
} from '../../master-data';
import { recordAudit } from '../audit/service';
import { snapshotForAudit, snapshotsForAudit } from '../audit/snapshot';
import { BrandModel } from '../brands/model';
import { inputError } from '../departments/service';
import {
  assertSupplyOwner,
  assertSupplyRead,
  type MasterDataActor,
  type MasterDataOption,
} from '../master-data-access';
import { claimLiveBrands } from '../master-data-claims';
import { auditActor, auditLabel } from '../master-data-audit';
import { MASTER_DATA_COLLATION } from '../master-data-collation';
import { toObjectId } from '../paging';
import { isDuplicateKeyError } from '../seed/duplicate-key';
import { type SupplierRecord, SupplierModel } from './model';

// Spec: docs/modules/supply.md#suppliers and docs/modules/core.md#managing-master-data — suppliers
// are Pulse Core master data. Supply Read lists them; Supply Owner adds, edits, retires and
// restores them (the System Administrator always passes). Every function checks module access
// itself, because Supply calls the same services later, and every change writes its audit entry
// (`core.supplier`, labelled with the supplier's name) in the same transaction.
//
// - The name is unique ignoring case, retired suppliers included; re-adding a retired name points
//   to Restore.
// - Products supplied are optional. A newly picked product must be live, and saving writes each
//   newly picked product in the transaction (`claimLiveBrands`), so an overlapping retire
//   conflicts. A product retired later stays linked and shows "Retired".
// - Contacts are kept on the supplier (at most 20, no primary flag), checked by the schema like a
//   client contact.
// - Retiring is a soft delete (`deletedAt`); a retired supplier can't be edited until restored.

const RECORD_TYPE = 'core.supplier';

const SUPPLIER_GONE = 'This supplier no longer exists. Reload the page.';
const NAME_TAKEN = 'Another supplier already has this name. Choose another name.';
const NAME_TAKEN_RETIRED =
  'A retired supplier already has this name. Restore that supplier instead of adding it again.';
const BRAND_NOT_LIVE = 'Choose products that aren’t retired.';

function rethrowDuplicateName(error: unknown): never {
  if (isDuplicateKeyError(error, 'name')) throw new ActionError(NAME_TAKEN, { field: 'name' });
  throw error;
}

/** Refuses a name another supplier already has, ignoring case (retired ones included). */
async function assertNameFree(
  name: string,
  exceptId: Types.ObjectId | null,
  session: ClientSession,
): Promise<void> {
  const filter: Record<string, unknown> = { name };
  if (exceptId) filter._id = { $ne: exceptId };
  const taken = await SupplierModel.findOne(filter, { _id: 1, deletedAt: 1 })
    .setOptions({ withDeleted: true })
    .collation(MASTER_DATA_COLLATION)
    .session(session)
    .lean();
  if (taken) {
    throw new ActionError(taken.deletedAt ? NAME_TAKEN_RETIRED : NAME_TAKEN, { field: 'name' });
  }
}

/** The parsed product ids as ObjectIds (the schema has checked their format). */
function brandObjectIds(ids: readonly string[]): Types.ObjectId[] {
  return ids.flatMap((id) => {
    const objectId = toObjectId(id);
    return objectId ? [objectId] : [];
  });
}

/** Writes each product in the transaction and refuses unless every one is live. */
async function claimBrands(brandIds: Types.ObjectId[], session: ClientSession): Promise<void> {
  if (!(await claimLiveBrands(brandIds, session))) {
    throw new ActionError(BRAND_NOT_LIVE, { field: 'brandIds' });
  }
}

// --- Reading ---------------------------------------------------------------------------------

/** A product a supplier supplies. */
export interface SupplierProductView {
  id: string;
  /** The product's name, or null when its record is missing. */
  name: string | null;
  /** True when the product was retired after it was linked (or its record is missing). */
  retired: boolean;
}

/** A contact kept on a supplier. */
export interface SupplierContactView {
  name: string;
  position: string | null;
  email: string | null;
  mobile: string | null;
}

/** One row of the suppliers table, with what the edit sheet needs. */
export interface SupplierView {
  id: string;
  name: string;
  /** Digits only, as stored; null when not given. */
  tin: string | null;
  /** The TIN for display (`000-000-000-000`); null when not given. */
  tinDisplay: string | null;
  address: string | null;
  paymentTermsDays: number | null;
  contacts: SupplierContactView[];
  /** The products supplied, in the order they were saved. */
  products: SupplierProductView[];
  supplierType: SupplierType;
  notes: string | null;
  /** When it was retired; null while it is live. */
  retiredAt: Date | null;
  updatedAt: Date;
}

/** Every live supplier, by name, with retired ones too when `includeRetired`. */
export async function listSuppliers(
  actor: MasterDataActor,
  { includeRetired = false }: { includeRetired?: boolean } = {},
): Promise<SupplierView[]> {
  assertSupplyRead(actor);
  await connectDb();

  const suppliers = await SupplierModel.find({}, null, { withDeleted: includeRetired })
    .collation(MASTER_DATA_COLLATION)
    .sort({ name: 1, _id: 1 })
    .lean();
  const brandIds = [
    ...new Map(
      suppliers.flatMap((s) => s.brandIds).map((id) => [id.toHexString(), id] as const),
    ).values(),
  ];
  const brands =
    brandIds.length === 0
      ? []
      : await BrandModel.find(
          { _id: { $in: brandIds } },
          { name: 1, deletedAt: 1 },
          { withDeleted: true },
        ).lean();
  const brandById = new Map(brands.map((brand) => [brand._id.toHexString(), brand]));

  return suppliers.map((supplier) => toView(supplier, brandById));
}

function toView(
  supplier: SupplierRecord,
  brandById: Map<string, { name: string; deletedAt?: Date | null }>,
): SupplierView {
  return {
    id: supplier._id.toHexString(),
    name: supplier.name,
    tin: supplier.tin ?? null,
    tinDisplay: supplier.tin ? formatTin(supplier.tin) : null,
    address: supplier.address ?? null,
    paymentTermsDays: supplier.paymentTermsDays ?? null,
    contacts: (supplier.contacts ?? []).map((contact) => ({
      name: contact.name,
      position: contact.position ?? null,
      email: contact.email ?? null,
      mobile: contact.mobile ?? null,
    })),
    products: (supplier.brandIds ?? []).map((brandId) => {
      const id = brandId.toHexString();
      const brand = brandById.get(id);
      return { id, name: brand?.name ?? null, retired: !brand || Boolean(brand.deletedAt) };
    }),
    supplierType: supplier.supplierType,
    notes: supplier.notes ?? null,
    retiredAt: supplier.deletedAt ?? null,
    updatedAt: supplier.updatedAt,
  };
}

/** A supplier in a picker: id and name only. */
export type SupplierOption = MasterDataOption;

/**
 * Live suppliers for another module's picker, by name. Any signed-in user may read it (the caller
 * checks the session), so it holds nothing but the id and name.
 */
export async function listSupplierOptions(): Promise<SupplierOption[]> {
  await connectDb();
  const suppliers = await SupplierModel.find({}, { name: 1 })
    .collation(MASTER_DATA_COLLATION)
    .sort({ name: 1, _id: 1 })
    .lean();
  return suppliers.map((supplier) => ({ id: supplier._id.toHexString(), name: supplier.name }));
}

// --- Changing --------------------------------------------------------------------------------

/** Adds a supplier. Every product picked must be live. */
export async function createSupplier(
  actor: MasterDataActor,
  input: SupplierInput,
): Promise<{ id: string }> {
  assertSupplyOwner(actor);
  const parsed = supplierInputSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const { brandIds, ...fields } = parsed.data;
  const brandObjectIdList = brandObjectIds(brandIds);

  try {
    return await withTransaction(async (session) => {
      await assertNameFree(fields.name, null, session);
      await claimBrands(brandObjectIdList, session);

      const [created] = await SupplierModel.create(
        [{ ...fields, brandIds: brandObjectIdList, createdBy: toObjectId(actor.id) }],
        { session },
      );
      if (!created) throw new Error('The supplier wasn’t created.');
      await recordAudit(
        {
          ...auditActor(actor),
          module: 'core',
          action: 'create',
          record: { type: RECORD_TYPE, id: created._id, label: auditLabel(created.name) },
          before: null,
          after: snapshotForAudit(SupplierModel, created),
        },
        { session },
      );
      return { id: created._id.toHexString() };
    });
  } catch (error) {
    rethrowDuplicateName(error);
  }
}

/** Loads a supplier in the transaction, retired ones included, or refuses. */
async function loadSupplier(id: string, session: ClientSession) {
  const supplierId = toObjectId(id);
  if (!supplierId) throw new ActionError(SUPPLIER_GONE);
  const supplier = await SupplierModel.findById(supplierId, null, { withDeleted: true })
    .session(session)
    .lean();
  if (!supplier) throw new ActionError(SUPPLIER_GONE);
  return supplier;
}

/**
 * Changes a live supplier. A newly picked product must be live; a product already linked is kept
 * even if it was retired since.
 */
export async function updateSupplier(
  actor: MasterDataActor,
  id: string,
  input: SupplierUpdateInput,
): Promise<void> {
  assertSupplyOwner(actor);
  const parsed = supplierUpdateSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const { brandIds, ...fields } = parsed.data;
  const brandObjectIdList = brandObjectIds(brandIds);

  try {
    await withTransaction(async (session) => {
      const before = await loadSupplier(id, session);
      if (before.deletedAt) {
        throw new ActionError('This supplier is retired. Restore it first to edit it.');
      }
      await assertNameFree(fields.name, before._id, session);
      const linked = new Set(before.brandIds.map((brandId) => brandId.toHexString()));
      await claimBrands(
        brandObjectIdList.filter((brandId) => !linked.has(brandId.toHexString())),
        session,
      );

      await SupplierModel.updateOne(
        { _id: before._id },
        { $set: { ...fields, brandIds: brandObjectIdList, updatedBy: toObjectId(actor.id) } },
        { session, runValidators: true },
      );
      const after = await SupplierModel.findById(before._id).session(session).lean().orFail();
      await recordAudit(
        {
          ...auditActor(actor),
          module: 'core',
          action: 'update',
          record: { type: RECORD_TYPE, id: before._id, label: auditLabel(after.name) },
          ...snapshotsForAudit(SupplierModel, before, after),
        },
        { session },
      );
    });
  } catch (error) {
    rethrowDuplicateName(error);
  }
}

/** Retires (soft-deletes) a supplier. */
export async function retireSupplier(actor: MasterDataActor, id: string): Promise<void> {
  assertSupplyOwner(actor);

  await withTransaction(async (session) => {
    const before = await loadSupplier(id, session);
    if (before.deletedAt) throw new ActionError('This supplier is already retired.');

    await SupplierModel.updateOne(
      { _id: before._id },
      { $set: { deletedAt: now(), updatedBy: toObjectId(actor.id) } },
      { session },
    );
    await recordAudit(
      {
        ...auditActor(actor),
        module: 'core',
        action: 'delete',
        record: { type: RECORD_TYPE, id: before._id, label: auditLabel(before.name) },
        before: snapshotForAudit(SupplierModel, before),
        after: null,
      },
      { session },
    );
  });
}

/** Restores a retired supplier, unchanged (its product links included). */
export async function restoreSupplier(actor: MasterDataActor, id: string): Promise<void> {
  assertSupplyOwner(actor);

  await withTransaction(async (session) => {
    const before = await loadSupplier(id, session);
    if (!before.deletedAt) throw new ActionError('This supplier isn’t retired.');

    await SupplierModel.updateOne(
      { _id: before._id, deletedAt: { $ne: null } },
      { $set: { deletedAt: null, updatedBy: toObjectId(actor.id) } },
      { session },
    );
    const after = await SupplierModel.findById(before._id).session(session).lean().orFail();
    await recordAudit(
      {
        ...auditActor(actor),
        module: 'core',
        action: 'restore',
        record: { type: RECORD_TYPE, id: before._id, label: auditLabel(after.name) },
        ...snapshotsForAudit(SupplierModel, before, after),
      },
      { session },
    );
  });
}
