import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose, { type ClientSession, type mongo, Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { AccessDeniedError, ActionError } from '../../actions';
import { AUDIT_LABEL_MAX_LENGTH } from '../../audit';
import {
  type CatalogItemInput,
  type CatalogItemUpdateInput,
  PART_NUMBER_MAX_LENGTH,
  PRODUCT_NAME_MAX_LENGTH,
} from '../../master-data';
import { emptyModuleAccess, fullModuleAccess, type ModuleAccess } from '../../module-access';
import { AuditLogModel } from '../audit/model';
import { BrandModel } from '../brands/model';
import { createBrand, restoreBrand, retireBrand } from '../brands/service';
import type { MasterDataActor } from '../master-data-access';
import { CatalogItemModel } from './model';
import {
  createCatalogItem,
  listCatalogItemOptions,
  listCatalogItems,
  restoreCatalogItem,
  retireCatalogItem,
  updateCatalogItem,
} from './service';

// Catalog items: docs/modules/core.md#managing-master-data, docs/modules/supply.md#stock,
// docs/TESTING.md#master-data-tests. Made-up data only.

function database(): mongo.Db {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Not connected.');
  return db;
}

function actor(access: Partial<ModuleAccess> = {}, { admin = false, hr = false } = {}) {
  const user: MasterDataActor & { isSystemAdministrator: boolean; roles: string[] } = {
    id: new Types.ObjectId().toHexString(),
    email: 'actor@xtreme-works.com',
    isSystemAdministrator: admin,
    roles: hr ? ['hr'] : [],
    moduleAccess: admin ? fullModuleAccess() : { ...emptyModuleAccess(), ...access },
  };
  return user;
}

const OWNER = actor({ supply: 'owner' });
const ADMIN = actor({}, { admin: true });
const ENGAGE_OWNER = actor({ engage: 'owner' });

let counter = 0;
function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

async function addBrand() {
  const name = unique('Product');
  const { id } = await createBrand(ENGAGE_OWNER, { name });
  return { id, name };
}

function itemInput(brandId: string, overrides: Partial<CatalogItemInput> = {}): CatalogItemInput {
  return {
    brandId,
    partNumber: unique('PN'),
    description: 'Made-up 24-port switch',
    unit: 'pc',
    itemKind: 'serialized',
    ...overrides,
  };
}

function updateFrom(input: CatalogItemInput): CatalogItemUpdateInput {
  const { partNumber, description, unit, defaultWarrantyMonths } = input;
  return { partNumber, description, unit, defaultWarrantyMonths };
}

async function addItem(brandId: string, by: MasterDataActor = OWNER) {
  const input = itemInput(brandId);
  const { id } = await createCatalogItem(by, input);
  return { id, input };
}

async function entriesFor(id: string) {
  return AuditLogModel.find({ 'record.id': new Types.ObjectId(id) })
    .sort({ _id: 1 })
    .lean();
}

async function failAuditWrites(): Promise<void> {
  await database().command({
    collMod: 'auditLogs',
    validator: { $jsonSchema: { required: ['aFieldNoEntryHas'] } },
    validationLevel: 'strict',
    validationAction: 'error',
  });
}

/** Runs `work` in a transaction that stays open until `commit` is called. */
async function openTransaction(work: (session: ClientSession) => Promise<unknown>) {
  const session = await mongoose.startSession();
  session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
  await work(session);
  return {
    async commit() {
      await session.commitTransaction();
      await session.endSession();
    },
  };
}

const OVERLAP_MS = 500;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  await connectDb();
  await Promise.all([BrandModel.init(), CatalogItemModel.init(), AuditLogModel.init()]);
});

afterEach(async () => {
  await database().command({ collMod: 'auditLogs', validator: {} });
});

describe('access', () => {
  const BELOW_OWNER: [string, MasterDataActor][] = [
    ['no module access', actor()],
    ['HR without module access', actor({}, { hr: true })],
    ['Supply Read', actor({ supply: 'read' })],
    ['Supply Write', actor({ supply: 'write' })],
    ['Engage Owner', ENGAGE_OWNER],
  ];

  it.each(BELOW_OWNER)('refuses changes from %s and changes nothing', async (_label, user) => {
    const { id: brandId } = await addBrand();
    const { id, input } = await addItem(brandId);
    await expect(createCatalogItem(user, itemInput(brandId))).rejects.toThrow(AccessDeniedError);
    await expect(
      updateCatalogItem(user, id, { ...updateFrom(input), description: 'Changed' }),
    ).rejects.toThrow(AccessDeniedError);
    await expect(retireCatalogItem(user, id)).rejects.toThrow(AccessDeniedError);
    await retireCatalogItem(OWNER, id);
    await expect(restoreCatalogItem(user, id)).rejects.toThrow(AccessDeniedError);

    const stored = await CatalogItemModel.findById(id, null, { withDeleted: true }).lean().orFail();
    expect(stored.description).toBe(input.description);
    expect(stored.deletedAt).not.toBeNull();
    expect(await CatalogItemModel.countDocuments({ brandId }, { withDeleted: true })).toBe(1);
    expect((await entriesFor(id)).map((entry) => entry.action)).toEqual(['create', 'delete']);
  });

  it('lists for Supply Read and up, and refuses anyone below', async () => {
    await expect(listCatalogItems(actor())).rejects.toThrow(AccessDeniedError);
    await expect(listCatalogItems(actor({}, { hr: true }))).rejects.toThrow(AccessDeniedError);
    await expect(listCatalogItems(ENGAGE_OWNER)).rejects.toThrow(AccessDeniedError);
    for (const user of [actor({ supply: 'read' }), actor({ supply: 'write' }), OWNER, ADMIN]) {
      await expect(listCatalogItems(user)).resolves.toBeInstanceOf(Array);
    }
  });

  it('lets Supply Owner and the System Administrator manage catalog items', async () => {
    const { id: brandId } = await addBrand();
    for (const by of [OWNER, ADMIN]) {
      const { id, input } = await addItem(brandId, by);
      await updateCatalogItem(by, id, { ...updateFrom(input), unit: 'set' });
      await retireCatalogItem(by, id);
      await restoreCatalogItem(by, id);
      const entries = await entriesFor(id);
      expect(entries.map((entry) => entry.action)).toEqual([
        'create',
        'update',
        'delete',
        'restore',
      ]);
      expect(entries.every((entry) => entry.actorId?.toHexString() === by.id)).toBe(true);
    }
  });

  it('gives any signed-in user the option list of live items, named `<product> · <part>`', async () => {
    const { id: brandId, name } = await addBrand();
    const live = await addItem(brandId);
    const retired = await addItem(brandId);
    await retireCatalogItem(OWNER, retired.id);

    const options = await listCatalogItemOptions({ brandId });
    expect(options).toEqual([{ id: live.id, name: `${name} · ${live.input.partNumber}`, brandId }]);
  });
});

describe('createCatalogItem', () => {
  it('writes exactly one core.catalogItem create entry labelled `<product> · <part>`', async () => {
    const { id: brandId, name } = await addBrand();
    const { id } = await createCatalogItem(
      OWNER,
      itemInput(brandId, { partNumber: ' 5320-24T-8XE ', itemKind: 'bulk' }),
    );

    const stored = await CatalogItemModel.findById(id).lean().orFail();
    expect(stored).toMatchObject({
      partNumber: '5320-24T-8XE',
      itemKind: 'bulk',
      unit: 'pc',
      defaultWarrantyMonths: 12,
    });
    const entries = await entriesFor(id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      module: 'core',
      action: 'create',
      record: { type: 'core.catalogItem', label: `${name} · 5320-24T-8XE` },
      before: null,
      after: { partNumber: '5320-24T-8XE', brandId },
    });

    const listed = (await listCatalogItems(OWNER, { brandId })).find((item) => item.id === id);
    expect(listed).toMatchObject({ brandName: name, brandRetired: false, retiredAt: null });
  });

  it('cuts a label longer than the audit log allows (longest product name and part number)', async () => {
    const name = unique('Product').padEnd(PRODUCT_NAME_MAX_LENGTH, 'x');
    const { id: brandId } = await createBrand(ENGAGE_OWNER, { name });
    const partNumber = 'P'.repeat(PART_NUMBER_MAX_LENGTH);
    const { id } = await createCatalogItem(OWNER, itemInput(brandId, { partNumber }));

    const [entry] = await entriesFor(id);
    expect(entry?.record.label).toHaveLength(AUDIT_LABEL_MAX_LENGTH);
    expect(entry?.record.label?.startsWith(`${name} · P`)).toBe(true);
    expect(entry?.record.label?.endsWith('…')).toBe(true);
    // The picker keeps the full name.
    const options = await listCatalogItemOptions({ brandId });
    expect(options.find((option) => option.id === id)?.name).toBe(`${name} · ${partNumber}`);
  });

  it('refuses a part number the product already has ignoring case, retired ones included', async () => {
    const { id: brandId } = await addBrand();
    const { input } = await addItem(brandId);
    await expect(
      createCatalogItem(OWNER, itemInput(brandId, { partNumber: input.partNumber.toLowerCase() })),
    ).rejects.toMatchObject({
      name: 'ActionError',
      field: 'partNumber',
      message: expect.not.stringContaining('Restore'),
    });

    const retired = await addItem(brandId);
    await retireCatalogItem(OWNER, retired.id);
    await expect(
      createCatalogItem(OWNER, itemInput(brandId, { partNumber: retired.input.partNumber })),
    ).rejects.toMatchObject({ field: 'partNumber', message: expect.stringContaining('Restore') });

    // The same part number under another product is fine.
    const { id: otherBrand } = await addBrand();
    await createCatalogItem(OWNER, itemInput(otherBrand, { partNumber: input.partNumber }));
    expect(await CatalogItemModel.countDocuments({ brandId }, { withDeleted: true })).toBe(2);
  });

  it('lets the unique index itself refuse a part number that differs only in case', async () => {
    const { id: brandId } = await addBrand();
    const { input } = await addItem(brandId);
    await expect(
      CatalogItemModel.create({
        ...input,
        brandId,
        partNumber: input.partNumber.toLowerCase(),
        defaultWarrantyMonths: 12,
      }),
    ).rejects.toMatchObject({ code: 11000 });
    const index = (await CatalogItemModel.collection.indexes()).find(
      (candidate) => candidate.name === 'brandId_1_partNumber_1_ci',
    );
    expect(index).toMatchObject({ unique: true, collation: { locale: 'en', strength: 2 } });
  });

  it('refuses a retired or unknown product', async () => {
    const { id: brandId } = await addBrand();
    await retireBrand(ENGAGE_OWNER, brandId);
    for (const id of [brandId, new Types.ObjectId().toHexString()]) {
      await expect(
        createCatalogItem(OWNER, itemInput(id, { partNumber: 'ORPHAN' })),
      ).rejects.toMatchObject({ name: 'ActionError', field: 'brandId' });
    }
    expect(await CatalogItemModel.countDocuments({ partNumber: 'ORPHAN' })).toBe(0);
  });

  it('accepts a default warranty from 0 to 120 whole months only', async () => {
    const { id: brandId } = await addBrand();
    for (const months of [-1, 121, 1.5, 'twelve']) {
      await expect(
        createCatalogItem(
          OWNER,
          itemInput(brandId, { defaultWarrantyMonths: months as unknown as number }),
        ),
      ).rejects.toMatchObject({ name: 'ActionError', field: 'defaultWarrantyMonths' });
    }
    for (const months of [0, 120]) {
      const { id } = await createCatalogItem(
        OWNER,
        itemInput(brandId, { itemKind: 'nonStock', defaultWarrantyMonths: months }),
      );
      expect((await CatalogItemModel.findById(id).lean().orFail()).defaultWarrantyMonths).toBe(
        months,
      );
    }
  });

  it('writes nothing when the audit entry can’t be written', async () => {
    const { id: brandId } = await addBrand();
    await failAuditWrites();
    await expect(
      createCatalogItem(OWNER, itemInput(brandId, { partNumber: 'ROLLED-BACK' })),
    ).rejects.toThrow();
    expect(
      await CatalogItemModel.exists({ partNumber: 'ROLLED-BACK' }).setOptions({
        withDeleted: true,
      }),
    ).toBeNull();
  });
});

describe('updateCatalogItem', () => {
  it('snapshots the change, labelled with the new part number', async () => {
    const { id: brandId, name } = await addBrand();
    const { id, input } = await addItem(brandId);
    const partNumber = `${input.partNumber}-B`;
    await updateCatalogItem(OWNER, id, {
      ...updateFrom(input),
      partNumber,
      defaultWarrantyMonths: 36,
    });

    const entries = await entriesFor(id);
    expect(entries[1]).toMatchObject({
      action: 'update',
      record: { type: 'core.catalogItem', label: `${name} · ${partNumber}` },
      before: { partNumber: input.partNumber, defaultWarrantyMonths: 12 },
      after: { partNumber, defaultWarrantyMonths: 36 },
    });
  });

  it('can’t change the product or the item kind', async () => {
    const { id: brandId } = await addBrand();
    const { id: otherBrand } = await addBrand();
    const { id, input } = await addItem(brandId);

    const moved = { ...updateFrom(input), brandId: otherBrand } as CatalogItemUpdateInput;
    await expect(updateCatalogItem(OWNER, id, moved)).rejects.toMatchObject({
      name: 'ActionError',
      field: 'brandId',
    });
    const rekinded = { ...updateFrom(input), itemKind: 'bulk' } as CatalogItemUpdateInput;
    await expect(updateCatalogItem(OWNER, id, rekinded)).rejects.toMatchObject({
      field: 'itemKind',
    });
    // Sending the same product and kind back is fine.
    await updateCatalogItem(OWNER, id, {
      ...updateFrom(input),
      brandId,
      itemKind: 'serialized',
    } as CatalogItemUpdateInput);

    const stored = await CatalogItemModel.findById(id).lean().orFail();
    expect(stored.brandId.toHexString()).toBe(brandId);
    expect(stored.itemKind).toBe('serialized');

    // Not even a direct model update changes them.
    await CatalogItemModel.updateOne(
      { _id: id },
      { $set: { brandId: new Types.ObjectId(otherBrand), itemKind: 'bulk' } },
    );
    const after = await CatalogItemModel.findById(id).lean().orFail();
    expect(after.brandId.toHexString()).toBe(brandId);
    expect(after.itemKind).toBe('serialized');
  });

  it('refuses another item’s part number, and accepts a case change of its own', async () => {
    const { id: brandId } = await addBrand();
    const first = await addItem(brandId);
    const second = await addItem(brandId);
    await expect(
      updateCatalogItem(OWNER, second.id, {
        ...updateFrom(second.input),
        partNumber: first.input.partNumber,
      }),
    ).rejects.toMatchObject({ field: 'partNumber' });
    await updateCatalogItem(OWNER, second.id, {
      ...updateFrom(second.input),
      partNumber: second.input.partNumber.toLowerCase(),
    });
  });

  it('refuses a warranty out of range', async () => {
    const { id: brandId } = await addBrand();
    const { id, input } = await addItem(brandId);
    await expect(
      updateCatalogItem(OWNER, id, { ...updateFrom(input), defaultWarrantyMonths: 121 }),
    ).rejects.toMatchObject({ field: 'defaultWarrantyMonths' });
  });

  it('refuses a retired item until it is restored', async () => {
    const { id: brandId } = await addBrand();
    const { id, input } = await addItem(brandId);
    await retireCatalogItem(OWNER, id);
    await expect(
      updateCatalogItem(OWNER, id, { ...updateFrom(input), description: 'Edited' }),
    ).rejects.toBeInstanceOf(ActionError);
    await restoreCatalogItem(OWNER, id);
    await updateCatalogItem(OWNER, id, { ...updateFrom(input), description: 'Edited' });
  });

  it('leaves the item unchanged when the audit entry can’t be written', async () => {
    const { id: brandId } = await addBrand();
    const { id, input } = await addItem(brandId);
    await failAuditWrites();
    await expect(
      updateCatalogItem(OWNER, id, { ...updateFrom(input), description: 'Not saved' }),
    ).rejects.toThrow();
    expect((await CatalogItemModel.findById(id).lean().orFail()).description).toBe(
      input.description,
    );
  });
});

describe('retire and restore', () => {
  it('retires with after null, and restores unchanged, with the labels', async () => {
    const { id: brandId, name } = await addBrand();
    const { id, input } = await addItem(brandId);
    const label = `${name} · ${input.partNumber}`;

    await retireCatalogItem(OWNER, id);
    await expect(retireCatalogItem(OWNER, id)).rejects.toBeInstanceOf(ActionError);
    expect(await CatalogItemModel.findById(id).lean()).toBeNull();
    expect((await listCatalogItems(OWNER, { brandId })).some((item) => item.id === id)).toBe(false);
    const withRetired = await listCatalogItems(OWNER, { brandId, includeRetired: true });
    expect(withRetired.find((item) => item.id === id)?.retiredAt).toBeInstanceOf(Date);

    await restoreCatalogItem(OWNER, id);
    await expect(restoreCatalogItem(OWNER, id)).rejects.toBeInstanceOf(ActionError);
    expect(await CatalogItemModel.findById(id).lean().orFail()).toMatchObject({
      partNumber: input.partNumber,
      deletedAt: null,
    });

    const entries = await entriesFor(id);
    expect(entries.map((entry) => [entry.action, entry.record.label])).toEqual([
      ['create', label],
      ['delete', label],
      ['restore', label],
    ]);
    expect(entries[1]).toMatchObject({ before: { deletedAt: null }, after: null });
  });

  it('needs a live product to restore', async () => {
    const { id: brandId } = await addBrand();
    const { id } = await addItem(brandId);
    await retireCatalogItem(OWNER, id);
    await retireBrand(ENGAGE_OWNER, brandId);

    await expect(restoreCatalogItem(OWNER, id)).rejects.toMatchObject({
      name: 'ActionError',
      message: expect.stringContaining('Restore the product first'),
    });
    expect(
      (await listCatalogItems(OWNER, { brandId, includeRetired: true }))[0]?.brandRetired,
    ).toBe(true);

    await restoreBrand(ENGAGE_OWNER, brandId);
    await restoreCatalogItem(OWNER, id);
    expect(await CatalogItemModel.findById(id).lean()).not.toBeNull();
  });

  it('rolls back a retire or a restore whose audit entry can’t be written', async () => {
    const { id: brandId } = await addBrand();
    const { id } = await addItem(brandId);
    await failAuditWrites();
    await expect(retireCatalogItem(OWNER, id)).rejects.toThrow();
    expect(await CatalogItemModel.findById(id).lean()).not.toBeNull();

    await database().command({ collMod: 'auditLogs', validator: {} });
    await retireCatalogItem(OWNER, id);
    await failAuditWrites();
    await expect(restoreCatalogItem(OWNER, id)).rejects.toThrow();
    expect(await CatalogItemModel.findById(id).lean()).toBeNull();
  });
});

// A product retired while an item is added or restored under it: the item writes the product
// (claimLiveBrand), so the two conflict and the item can't land under a retired product.
describe('a product retired at the same time', () => {
  function retireInOpenTransaction(brandId: string) {
    return openTransaction((session) =>
      BrandModel.updateOne({ _id: brandId }, { $set: { deletedAt: new Date() } }, { session }),
    );
  }

  it('makes an item add that overlaps the retirement fail once it commits', async () => {
    const { id: brandId } = await addBrand();
    const retiring = await retireInOpenTransaction(brandId);
    const adding = createCatalogItem(OWNER, itemInput(brandId)).catch((error: unknown) => error);
    await pause(OVERLAP_MS);
    await retiring.commit();

    expect(await adding).toMatchObject({ name: 'ActionError', field: 'brandId' });
    expect(await CatalogItemModel.countDocuments({ brandId }, { withDeleted: true })).toBe(0);
  });

  it('makes an item restore that overlaps the retirement fail once it commits', async () => {
    const { id: brandId } = await addBrand();
    const { id } = await addItem(brandId);
    await retireCatalogItem(OWNER, id);
    const retiring = await retireInOpenTransaction(brandId);
    const restoring = restoreCatalogItem(OWNER, id).catch((error: unknown) => error);
    await pause(OVERLAP_MS);
    await retiring.commit();

    expect(await restoring).toBeInstanceOf(ActionError);
    expect(await CatalogItemModel.findById(id).lean()).toBeNull();
  });
});
