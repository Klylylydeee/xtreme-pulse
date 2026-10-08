import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose, { type ClientSession, type mongo, Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { AccessDeniedError, ActionError } from '../../actions';
import { emptyModuleAccess, fullModuleAccess, type ModuleAccess } from '../../module-access';
import { AuditLogModel } from '../audit/model';
import { CatalogItemModel } from '../catalog-items/model';
import { createCatalogItem, retireCatalogItem } from '../catalog-items/service';
import type { MasterDataActor } from '../master-data-access';
import { claimLiveBrand } from '../master-data-claims';
import { BrandModel } from './model';
import {
  createBrand,
  listBrandOptions,
  listBrands,
  restoreBrand,
  retireBrand,
  updateBrand,
} from './service';

// Products (`brands` in code): docs/modules/core.md#managing-master-data,
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

const OWNER = actor({ engage: 'owner' });
const ADMIN = actor({}, { admin: true });
const SUPPLY_OWNER = actor({ supply: 'owner' });

let counter = 0;
function uniqueName(prefix = 'Product'): string {
  counter += 1;
  return `${prefix} ${counter}`;
}

async function addBrand(by: MasterDataActor = OWNER) {
  const name = uniqueName();
  const { id } = await createBrand(by, { name });
  return { id, name };
}

async function addItem(brandId: string) {
  return createCatalogItem(SUPPLY_OWNER, {
    brandId,
    partNumber: uniqueName('PN'),
    description: 'Made-up switch',
    unit: 'pc',
    itemKind: 'serialized',
  });
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
    ['Engage Read', actor({ engage: 'read' })],
    ['Engage Write', actor({ engage: 'write' })],
    ['Supply Owner', SUPPLY_OWNER],
  ];

  it.each(BELOW_OWNER)('refuses changes from %s and changes nothing', async (_label, user) => {
    const { id, name } = await addBrand();
    await expect(createBrand(user, { name: uniqueName() })).rejects.toThrow(AccessDeniedError);
    await expect(updateBrand(user, id, { name: 'Renamed' })).rejects.toThrow(AccessDeniedError);
    await expect(retireBrand(user, id)).rejects.toThrow(AccessDeniedError);
    await retireBrand(OWNER, id);
    await expect(restoreBrand(user, id)).rejects.toThrow(AccessDeniedError);

    const stored = await BrandModel.findById(id, null, { withDeleted: true }).lean().orFail();
    expect(stored.name).toBe(name);
    expect(stored.deletedAt).not.toBeNull();
    expect((await entriesFor(id)).map((entry) => entry.action)).toEqual(['create', 'delete']);
  });

  it('lists for Engage Read and up, and refuses anyone below', async () => {
    await expect(listBrands(actor())).rejects.toThrow(AccessDeniedError);
    await expect(listBrands(actor({}, { hr: true }))).rejects.toThrow(AccessDeniedError);
    await expect(listBrands(SUPPLY_OWNER)).rejects.toThrow(AccessDeniedError);
    for (const user of [actor({ engage: 'read' }), actor({ engage: 'write' }), OWNER, ADMIN]) {
      await expect(listBrands(user)).resolves.toBeInstanceOf(Array);
    }
  });

  it('lets Engage Owner and the System Administrator manage products', async () => {
    for (const by of [OWNER, ADMIN]) {
      const { id, name } = await addBrand(by);
      await updateBrand(by, id, { name: `${name} renamed` });
      await retireBrand(by, id);
      await restoreBrand(by, id);
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

  it('gives any signed-in user the option list: id and name of live products only', async () => {
    const live = await addBrand();
    const retired = await addBrand();
    await retireBrand(OWNER, retired.id);

    const options = await listBrandOptions();
    expect(options.find((option) => option.id === live.id)).toEqual({
      id: live.id,
      name: live.name,
    });
    expect(options.some((option) => option.id === retired.id)).toBe(false);
    expect(options.every((option) => Object.keys(option).sort().join() === 'id,name')).toBe(true);
  });
});

describe('createBrand', () => {
  it('writes exactly one core.brand create entry labelled with the name', async () => {
    const { id } = await createBrand(OWNER, { name: ' Made-up Networks ' });
    expect((await BrandModel.findById(id).lean().orFail()).name).toBe('Made-up Networks');

    const entries = await entriesFor(id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      module: 'core',
      action: 'create',
      record: { type: 'core.brand', label: 'Made-up Networks' },
      before: null,
      after: { name: 'Made-up Networks' },
    });
  });

  it('refuses a name another product has ignoring case, pointing to Restore when retired', async () => {
    const { name } = await addBrand();
    await expect(createBrand(OWNER, { name: name.toUpperCase() })).rejects.toMatchObject({
      name: 'ActionError',
      field: 'name',
      message: expect.not.stringContaining('Restore'),
    });

    const retired = await addBrand();
    await retireBrand(OWNER, retired.id);
    await expect(createBrand(OWNER, { name: retired.name.toLowerCase() })).rejects.toMatchObject({
      field: 'name',
      message: expect.stringContaining('Restore'),
    });
    const matching = await BrandModel.countDocuments(
      { name: retired.name },
      { withDeleted: true },
    ).collation({ locale: 'en', strength: 2 });
    expect(matching).toBe(1);
  });

  it('lets the unique index itself refuse a name that differs only in case', async () => {
    const { name } = await addBrand();
    await expect(BrandModel.create({ name: name.toLowerCase() })).rejects.toMatchObject({
      code: 11000,
    });
    const index = (await BrandModel.collection.indexes()).find((i) => i.name === 'name_1_ci');
    expect(index).toMatchObject({ unique: true, collation: { locale: 'en', strength: 2 } });
  });

  it('writes nothing when the audit entry can’t be written', async () => {
    await failAuditWrites();
    await expect(createBrand(OWNER, { name: 'Rolled back' })).rejects.toThrow();
    expect(
      await BrandModel.exists({ name: 'Rolled back' }).setOptions({ withDeleted: true }),
    ).toBeNull();
  });
});

describe('updateBrand', () => {
  it('renames and snapshots the change', async () => {
    const { id, name } = await addBrand();
    await updateBrand(OWNER, id, { name: `${name} II` });
    const entries = await entriesFor(id);
    expect(entries[1]).toMatchObject({
      action: 'update',
      record: { type: 'core.brand', label: `${name} II` },
      before: { name },
      after: { name: `${name} II` },
    });
  });

  it('refuses another product’s name, and accepts a case change of its own', async () => {
    const first = await addBrand();
    const second = await addBrand();
    await expect(updateBrand(OWNER, second.id, { name: first.name })).rejects.toMatchObject({
      field: 'name',
    });
    await updateBrand(OWNER, second.id, { name: second.name.toUpperCase() });
    expect((await BrandModel.findById(second.id).lean().orFail()).name).toBe(
      second.name.toUpperCase(),
    );
  });

  it('refuses a retired product until it is restored', async () => {
    const { id, name } = await addBrand();
    await retireBrand(OWNER, id);
    await expect(updateBrand(OWNER, id, { name: 'Edited' })).rejects.toBeInstanceOf(ActionError);
    await restoreBrand(OWNER, id);
    await updateBrand(OWNER, id, { name: `${name} edited` });
  });

  it('leaves the product unchanged when the audit entry can’t be written', async () => {
    const { id, name } = await addBrand();
    await failAuditWrites();
    await expect(updateBrand(OWNER, id, { name: 'Not saved' })).rejects.toThrow();
    expect((await BrandModel.findById(id).lean().orFail()).name).toBe(name);
  });
});

describe('retireBrand', () => {
  it('is blocked while live catalog items exist, and allowed once they’re retired', async () => {
    const { id, name } = await addBrand();
    const first = await addItem(id);
    const second = await addItem(id);

    await expect(retireBrand(OWNER, id)).rejects.toMatchObject({
      name: 'ActionError',
      message: expect.stringContaining('2 live catalog items'),
    });
    expect((await listBrands(OWNER)).find((b) => b.id === id)?.liveCatalogItemCount).toBe(2);

    await retireCatalogItem(SUPPLY_OWNER, first.id);
    await expect(retireBrand(OWNER, id)).rejects.toMatchObject({
      message: expect.stringContaining('1 live catalog item'),
    });
    await retireCatalogItem(SUPPLY_OWNER, second.id);
    await retireBrand(OWNER, id);

    expect(await BrandModel.findById(id).lean()).toBeNull();
    const entries = await entriesFor(id);
    expect(entries.map((entry) => entry.action)).toEqual(['create', 'delete']);
    expect(entries[1]).toMatchObject({
      record: { type: 'core.brand', label: name },
      before: { name, deletedAt: null },
      after: null,
    });

    expect((await listBrands(OWNER)).some((b) => b.id === id)).toBe(false);
    const withRetired = await listBrands(OWNER, { includeRetired: true });
    expect(withRetired.find((b) => b.id === id)?.retiredAt).toBeInstanceOf(Date);
  });

  it('treats the seeded "General" product like any other', async () => {
    const general = await BrandModel.create({ name: 'General', seedKey: 'general' });
    const id = general._id.toHexString();
    expect((await listBrands(OWNER)).find((b) => b.id === id)?.seeded).toBe(true);
    await updateBrand(OWNER, id, { name: 'General Items' });
    await retireBrand(OWNER, id);
    await restoreBrand(OWNER, id);
  });

  it('leaves the product live when the audit entry can’t be written', async () => {
    const { id } = await addBrand();
    await failAuditWrites();
    await expect(retireBrand(OWNER, id)).rejects.toThrow();
    expect(await BrandModel.findById(id).lean()).not.toBeNull();
  });

  it('fails when a catalog item added at the same time commits first', async () => {
    const { id } = await addBrand();
    const brandId = new Types.ObjectId(id);
    // What createCatalogItem writes: the claim on the product, then the item.
    const adding = await openTransaction(async (session) => {
      await claimLiveBrand(brandId, session);
      await CatalogItemModel.create(
        [
          {
            brandId,
            partNumber: 'OVERLAP-1',
            description: 'Made-up',
            unit: 'pc',
            itemKind: 'bulk',
          },
        ],
        { session },
      );
    });
    const retiring = retireBrand(OWNER, id).catch((error: unknown) => error);
    await pause(OVERLAP_MS);
    await adding.commit();

    expect(await retiring).toBeInstanceOf(ActionError);
    expect(await BrandModel.findById(id).lean()).not.toBeNull();
  });

  it('never leaves a live catalog item under a retired product when both run at once', async () => {
    for (let round = 0; round < 5; round += 1) {
      const { id } = await addBrand();
      await Promise.allSettled([addItem(id), retireBrand(OWNER, id)]);
      const brand = await BrandModel.findById(id, null, { withDeleted: true }).lean().orFail();
      const live = await CatalogItemModel.countDocuments({ brandId: id });
      expect(brand.deletedAt === null || live === 0).toBe(true);
    }
  });
});

describe('restoreBrand', () => {
  it('brings a retired product back unchanged, with a restore entry', async () => {
    const { id, name } = await addBrand();
    await retireBrand(OWNER, id);
    await expect(retireBrand(OWNER, id)).rejects.toBeInstanceOf(ActionError);
    await restoreBrand(OWNER, id);
    await expect(restoreBrand(OWNER, id)).rejects.toBeInstanceOf(ActionError);

    expect(await BrandModel.findById(id).lean().orFail()).toMatchObject({ name, deletedAt: null });
    const entries = await entriesFor(id);
    expect(entries.map((entry) => entry.action)).toEqual(['create', 'delete', 'restore']);
    expect(entries[2]).toMatchObject({
      record: { type: 'core.brand', label: name },
      after: { name, deletedAt: null },
    });
  });

  it('stays retired when the audit entry can’t be written', async () => {
    const { id } = await addBrand();
    await retireBrand(OWNER, id);
    await failAuditWrites();
    await expect(restoreBrand(OWNER, id)).rejects.toThrow();
    expect(await BrandModel.findById(id).lean()).toBeNull();
  });
});
