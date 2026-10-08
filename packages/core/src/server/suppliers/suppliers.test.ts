import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose, { type mongo, Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { AccessDeniedError } from '../../actions';
import type { SupplierInput } from '../../master-data';
import {
  type AccessLevel,
  emptyModuleAccess,
  fullModuleAccess,
  type ModuleAccess,
} from '../../module-access';
import { AuditLogModel } from '../audit/model';
import { BrandModel } from '../brands/model';
import type { MasterDataActor } from '../master-data-access';
import { SupplierModel } from './model';
import {
  createSupplier,
  listSupplierOptions,
  listSuppliers,
  restoreSupplier,
  retireSupplier,
  updateSupplier,
} from './service';

// Suppliers (docs/modules/supply.md#suppliers, docs/modules/core.md#managing-master-data,
// docs/TESTING.md#master-data-tests). Made-up data only.

function database(): mongo.Db {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Not connected.');
  return db;
}

function actor(supply: AccessLevel, extra: Partial<ModuleAccess> = {}): MasterDataActor {
  return {
    id: new Types.ObjectId().toHexString(),
    email: 'actor@xtreme-works.com',
    moduleAccess: { ...emptyModuleAccess(), supply, ...extra } as ModuleAccess,
  };
}

const OWNER = actor('owner');
const READER = actor('read');
const WRITER = actor('write');
const NOBODY = actor('none');
// HR with no module access: the role grants none (SECURITY.md#roles).
const HR_NO_ACCESS = {
  ...actor('none'),
  roles: ['hr'],
  isSystemAdministrator: false,
} as MasterDataActor;
const ADMIN = {
  id: new Types.ObjectId().toHexString(),
  email: 'admin@xtreme-works.com',
  isSystemAdministrator: true,
  roles: [],
  moduleAccess: fullModuleAccess(),
} as MasterDataActor;

let counter = 0;
function nextName(prefix = 'Supplier'): string {
  counter += 1;
  return `${prefix} ${String(counter).padStart(3, '0')}`;
}

async function addBrand({ retired = false } = {}) {
  const brand = await BrandModel.create({ name: nextName('Product') });
  if (retired) {
    await BrandModel.updateOne({ _id: brand._id }, { $set: { deletedAt: new Date() } });
  }
  return brand._id.toHexString();
}

async function addSupplier(input: Partial<SupplierInput> = {}, by = OWNER) {
  const name = input.name ?? nextName();
  const { id } = await createSupplier(by, { name, ...input });
  return { id, name };
}

async function entriesFor(id: string) {
  return AuditLogModel.find({ 'record.id': new Types.ObjectId(id) })
    .sort({ _id: 1 })
    .lean();
}

async function stored(id: string) {
  return SupplierModel.findById(id, null, { withDeleted: true }).lean().orFail();
}

async function failAuditWrites(): Promise<void> {
  await database().command({
    collMod: 'auditLogs',
    validator: { $jsonSchema: { required: ['aFieldNoEntryHas'] } },
    validationLevel: 'strict',
    validationAction: 'error',
  });
}

const contact = (n: number) => ({
  name: `Contact ${n}`,
  position: 'Sales',
  email: `contact.${n}@example.com`,
  mobile: '0917 123 4567',
});

beforeAll(async () => {
  await connectDb();
  // Collections must exist before a transaction writes to them.
  await Promise.all([SupplierModel.init(), BrandModel.init(), AuditLogModel.init()]);
});

afterEach(async () => {
  await database().command({ collMod: 'auditLogs', validator: {} });
});

describe('access', () => {
  it.each([
    ['no module access', NOBODY],
    ['HR without module access', HR_NO_ACCESS],
  ])('refuses %s everything, the list included', async (_label, outsider) => {
    const { id } = await addSupplier();
    await expect(listSuppliers(outsider)).rejects.toThrow(AccessDeniedError);
    await expect(createSupplier(outsider, { name: nextName() })).rejects.toThrow(AccessDeniedError);
    await expect(updateSupplier(outsider, id, { name: 'Renamed' })).rejects.toThrow(
      AccessDeniedError,
    );
    await expect(retireSupplier(outsider, id)).rejects.toThrow(AccessDeniedError);
    await retireSupplier(OWNER, id);
    await expect(restoreSupplier(outsider, id)).rejects.toThrow(AccessDeniedError);
    expect((await stored(id)).name).not.toBe('Renamed');
    expect((await entriesFor(id)).map((entry) => entry.action)).toEqual(['create', 'delete']);
  });

  it.each([
    ['Supply Read', READER],
    ['Supply Write', WRITER],
    ['Owner on another module only', actor('read', { engage: 'owner' })],
  ])('lets %s list but not change suppliers', async (_label, below) => {
    const { id, name } = await addSupplier();
    expect((await listSuppliers(below)).some((row) => row.id === id)).toBe(true);
    await expect(createSupplier(below, { name: nextName() })).rejects.toThrow(AccessDeniedError);
    await expect(updateSupplier(below, id, { name: 'Renamed' })).rejects.toThrow(AccessDeniedError);
    await expect(retireSupplier(below, id)).rejects.toThrow(AccessDeniedError);
    await retireSupplier(OWNER, id);
    await expect(restoreSupplier(below, id)).rejects.toThrow(AccessDeniedError);
    expect((await stored(id)).name).toBe(name);
    expect((await entriesFor(id)).map((entry) => entry.action)).toEqual(['create', 'delete']);
  });

  it('lets Supply Owner and the System Administrator manage suppliers', async () => {
    for (const by of [OWNER, ADMIN]) {
      const { id } = await addSupplier({}, by);
      await updateSupplier(by, id, { name: nextName('Renamed') });
      await retireSupplier(by, id);
      await restoreSupplier(by, id);
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

  it('gives the picker options to anyone, live suppliers only, id and name only', async () => {
    const live = await addSupplier();
    const retired = await addSupplier();
    await retireSupplier(OWNER, retired.id);
    const options = await listSupplierOptions();
    expect(options).toContainEqual({ id: live.id, name: live.name });
    expect(options.some((option) => option.id === retired.id)).toBe(false);
    expect(options.every((option) => Object.keys(option).sort().join() === 'id,name')).toBe(true);
  });
});

describe('createSupplier', () => {
  it('saves the fields and writes exactly one create entry labelled with the name', async () => {
    const brandId = await addBrand();
    const name = nextName();
    const { id } = await createSupplier(OWNER, {
      name: `  ${name} `,
      tin: '123-456-789 000',
      address: 'Makati City',
      paymentTermsDays: '30',
      contacts: [{ ...contact(1), email: 'Ana.Cruz@Example.com' }],
      brandIds: [brandId, brandId],
      supplierType: 'brandPrincipal',
      notes: '',
    });

    const record = await stored(id);
    expect(record).toMatchObject({
      name,
      tin: '123456789000',
      address: 'Makati City',
      paymentTermsDays: 30,
      supplierType: 'brandPrincipal',
      notes: null,
    });
    expect(record.contacts).toEqual([
      {
        name: 'Contact 1',
        position: 'Sales',
        email: 'ana.cruz@example.com',
        mobile: '0917 123 4567',
      },
    ]);
    expect(record.brandIds.map(String)).toEqual([brandId]);
    expect(record.createdBy?.toHexString()).toBe(OWNER.id);

    const entries = await entriesFor(id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      module: 'core',
      action: 'create',
      actorEmail: OWNER.email,
      record: { type: 'core.supplier', label: name },
      before: null,
      // The TIN is company data, kept in full.
      after: { name, tin: '123456789000' },
    });
  });

  it('defaults the supplier type to distributor and allows no products or contacts', async () => {
    const { id } = await addSupplier();
    expect(await stored(id)).toMatchObject({
      supplierType: 'distributor',
      brandIds: [],
      contacts: [],
      tin: null,
      paymentTermsDays: null,
    });
  });

  it('refuses a supplier type outside the fixed set', async () => {
    await expect(
      createSupplier(OWNER, { name: nextName(), supplierType: 'reseller' as never }),
    ).rejects.toMatchObject({ name: 'ActionError', field: 'supplierType' });
  });

  it.each([['-1'], ['366'], ['1.5'], ['abc']])('refuses payment terms of %s', async (value) => {
    await expect(
      createSupplier(OWNER, { name: nextName(), paymentTermsDays: value }),
    ).rejects.toMatchObject({ name: 'ActionError', field: 'paymentTermsDays' });
  });

  it.each([
    ['0', 0],
    ['365', 365],
    ['', null],
  ])('accepts payment terms of "%s"', async (value, expected) => {
    const { id } = await addSupplier({ paymentTermsDays: value });
    expect((await stored(id)).paymentTermsDays).toBe(expected);
  });

  it('refuses a TIN of the wrong length', async () => {
    await expect(
      createSupplier(OWNER, { name: nextName(), tin: '1234-5678' }),
    ).rejects.toMatchObject({ name: 'ActionError', field: 'tin' });
  });

  it('writes nothing when the audit write fails', async () => {
    const name = nextName();
    await failAuditWrites();
    await expect(createSupplier(OWNER, { name })).rejects.toThrow();
    expect(await SupplierModel.exists({ name }).setOptions({ withDeleted: true })).toBeNull();
  });
});

describe('contacts', () => {
  it.each([
    ['a missing name', { name: '' }, 'contacts.0.name'],
    ['a bad email', { email: 'not-an-email' }, 'contacts.0.email'],
    ['a non-Philippine mobile', { mobile: '12345' }, 'contacts.0.mobile'],
  ])('refuses %s', async (_label, change, field) => {
    await expect(
      createSupplier(OWNER, { name: nextName(), contacts: [{ ...contact(1), ...change }] }),
    ).rejects.toMatchObject({ name: 'ActionError', field });
  });

  it('accepts the +63, 63 and 0 mobile forms and stores them as typed', async () => {
    const mobiles = ['+63 917 123 4567', '63-917-123-4567', '(0917) 123-4567'];
    const { id } = await addSupplier({
      contacts: mobiles.map((mobile, n) => ({ name: `Contact ${n}`, mobile })),
    });
    expect((await stored(id)).contacts.map((c) => c.mobile)).toEqual(mobiles);
  });

  it('allows 20 contacts and refuses 21', async () => {
    const twenty = Array.from({ length: 20 }, (_, n) => contact(n));
    const { id } = await addSupplier({ contacts: twenty });
    expect((await stored(id)).contacts).toHaveLength(20);

    await expect(
      createSupplier(OWNER, { name: nextName(), contacts: [...twenty, contact(20)] }),
    ).rejects.toMatchObject({ name: 'ActionError', field: 'contacts' });
    await expect(
      updateSupplier(OWNER, id, {
        name: (await stored(id)).name,
        contacts: [...twenty, contact(20)],
      }),
    ).rejects.toMatchObject({ name: 'ActionError', field: 'contacts' });
    expect((await stored(id)).contacts).toHaveLength(20);
  });
});

describe('unique names', () => {
  it('refuses a name another supplier has in another case', async () => {
    const { name } = await addSupplier();
    await expect(createSupplier(OWNER, { name: name.toUpperCase() })).rejects.toMatchObject({
      name: 'ActionError',
      field: 'name',
      message: expect.not.stringContaining('Restore'),
    });
    const other = await addSupplier();
    await expect(
      updateSupplier(OWNER, other.id, { name: name.toLowerCase() }),
    ).rejects.toMatchObject({ name: 'ActionError', field: 'name' });
  });

  it('refuses a retired supplier’s name and points to Restore', async () => {
    const { id, name } = await addSupplier();
    await retireSupplier(OWNER, id);
    await expect(createSupplier(OWNER, { name: name.toLowerCase() })).rejects.toMatchObject({
      name: 'ActionError',
      field: 'name',
      message: expect.stringContaining('Restore'),
    });
  });

  it('lets a supplier keep its own name or change its case', async () => {
    const { id, name } = await addSupplier();
    await updateSupplier(OWNER, id, { name, notes: 'Unchanged name' });
    await updateSupplier(OWNER, id, { name: name.toUpperCase() });
    expect((await stored(id)).name).toBe(name.toUpperCase());
  });

  it('is enforced by the unique index too', async () => {
    const { name } = await addSupplier();
    await expect(SupplierModel.create({ name: name.toLowerCase() })).rejects.toMatchObject({
      code: 11000,
    });
  });
});

describe('products supplied', () => {
  it('refuses a newly picked retired or unknown product and saves nothing', async () => {
    const retired = await addBrand({ retired: true });
    const live = await addBrand();
    const name = nextName();
    await expect(createSupplier(OWNER, { name, brandIds: [live, retired] })).rejects.toMatchObject({
      name: 'ActionError',
      field: 'brandIds',
    });
    await expect(
      createSupplier(OWNER, { name, brandIds: [new Types.ObjectId().toHexString()] }),
    ).rejects.toMatchObject({ name: 'ActionError', field: 'brandIds' });
    expect(await SupplierModel.exists({ name })).toBeNull();

    const { id } = await addSupplier({ brandIds: [live] });
    await expect(
      updateSupplier(OWNER, id, { name: (await stored(id)).name, brandIds: [live, retired] }),
    ).rejects.toMatchObject({ name: 'ActionError', field: 'brandIds' });
    expect((await stored(id)).brandIds.map(String)).toEqual([live]);
  });

  it('keeps a link to a product retired since on an unrelated edit, shown Retired', async () => {
    const kept = await addBrand();
    const added = await addBrand();
    const { id, name } = await addSupplier({ brandIds: [kept] });
    await BrandModel.updateOne({ _id: kept }, { $set: { deletedAt: new Date() } });

    await updateSupplier(OWNER, id, { name, notes: 'Unrelated edit', brandIds: [kept] });
    await updateSupplier(OWNER, id, { name, brandIds: [kept, added] });
    expect((await stored(id)).brandIds.map(String)).toEqual([kept, added]);

    const row = (await listSuppliers(READER)).find((supplier) => supplier.id === id);
    expect(row?.products).toEqual([
      { id: kept, name: expect.any(String), retired: true },
      { id: added, name: expect.any(String), retired: false },
    ]);
  });

  it('lets a product be unlinked', async () => {
    const brand = await addBrand();
    const { id, name } = await addSupplier({ brandIds: [brand] });
    await updateSupplier(OWNER, id, { name, brandIds: [] });
    expect((await stored(id)).brandIds).toEqual([]);
  });
});

describe('listSuppliers', () => {
  it('lists live suppliers, retired ones only when asked, with the TIN for display', async () => {
    const live = await addSupplier({ tin: '123456789' });
    const retired = await addSupplier();
    await retireSupplier(OWNER, retired.id);

    const liveOnly = await listSuppliers(READER);
    const row = liveOnly.find((supplier) => supplier.id === live.id);
    expect(row).toMatchObject({ tin: '123456789', tinDisplay: '123-456-789', retiredAt: null });
    expect(liveOnly.some((supplier) => supplier.id === retired.id)).toBe(false);

    const all = await listSuppliers(READER, { includeRetired: true });
    expect(all.find((supplier) => supplier.id === retired.id)?.retiredAt).toBeInstanceOf(Date);
  });
});

describe('retire and restore', () => {
  it('soft-deletes and restores the supplier unchanged, with the entries', async () => {
    const brand = await addBrand();
    const { id, name } = await addSupplier({ brandIds: [brand], contacts: [contact(1)] });
    const original = await stored(id);

    await retireSupplier(OWNER, id);
    expect((await stored(id)).deletedAt).toBeInstanceOf(Date);
    await expect(retireSupplier(OWNER, id)).rejects.toMatchObject({ name: 'ActionError' });

    await restoreSupplier(OWNER, id);
    const restored = await stored(id);
    expect(restored.deletedAt).toBeNull();
    expect(restored.brandIds.map(String)).toEqual([brand]);
    expect(restored.contacts).toEqual(original.contacts);
    await expect(restoreSupplier(OWNER, id)).rejects.toMatchObject({ name: 'ActionError' });

    const entries = await entriesFor(id);
    expect(entries.map((entry) => entry.action)).toEqual(['create', 'delete', 'restore']);
    expect(entries.every((entry) => entry.record.type === 'core.supplier')).toBe(true);
    expect(entries.every((entry) => entry.record.label === name)).toBe(true);
    expect(entries[1]).toMatchObject({ before: { name }, after: null });
  });

  it('refuses to edit a retired supplier until it is restored', async () => {
    const { id, name } = await addSupplier();
    await retireSupplier(OWNER, id);
    await expect(updateSupplier(OWNER, id, { name: 'Renamed' })).rejects.toMatchObject({
      name: 'ActionError',
      message: expect.stringContaining('Restore'),
    });
    expect((await stored(id)).name).toBe(name);
    await restoreSupplier(OWNER, id);
    await updateSupplier(OWNER, id, { name: nextName('Renamed') });
  });

  it('labels an edit with the name after the change', async () => {
    const { id } = await addSupplier();
    const renamed = nextName('Renamed');
    await updateSupplier(OWNER, id, { name: renamed });
    const entries = await entriesFor(id);
    expect(entries[1]).toMatchObject({ action: 'update', record: { label: renamed } });
  });

  it('leaves the record unchanged when the audit write fails', async () => {
    const { id, name } = await addSupplier();
    await failAuditWrites();
    await expect(updateSupplier(OWNER, id, { name: 'Renamed' })).rejects.toThrow();
    await expect(retireSupplier(OWNER, id)).rejects.toThrow();
    const record = await stored(id);
    expect(record.name).toBe(name);
    expect(record.deletedAt).toBeNull();
  });

  it('refuses an unknown supplier', async () => {
    const unknown = new Types.ObjectId().toHexString();
    await expect(retireSupplier(OWNER, unknown)).rejects.toMatchObject({ name: 'ActionError' });
    await expect(updateSupplier(OWNER, 'not-an-id', { name: 'X' })).rejects.toMatchObject({
      name: 'ActionError',
    });
  });
});
