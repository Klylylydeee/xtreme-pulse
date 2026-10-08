import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose, { type mongo, Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { EMPLOYMENT_STATUS, type EmploymentStatus } from '../../account';
import { AccessDeniedError, ActionError } from '../../actions';
import { emptyModuleAccess, fullModuleAccess, type LevelFor } from '../../module-access';
import { AuditLogModel } from '../audit/model';
import { DepartmentModel } from '../departments/model';
import { EmployeeModel } from '../employees/model';
import type { MasterDataActor } from '../master-data-access';
import { UserModel } from '../users/model';
import { ClientContactModel } from './contact-model';
import { addClientContact } from './contacts';
import { ClientModel } from './model';
import {
  createClient,
  findClientsNamed,
  getClient,
  listClientOptions,
  listClients,
  restoreClient,
  retireClient,
  searchEligibleAccountManagers,
  updateClient,
} from './service';
import { ClientSiteModel } from './site-model';
import { addClientSite } from './sites';

// Clients (docs/modules/core.md#managing-master-data, docs/modules/engage.md#clients-sites-and-contacts,
// docs/TESTING.md#master-data-tests). Made-up data only.

function database(): mongo.Db {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Not connected.');
  return db;
}

function actor(engage: LevelFor<'engage'>): MasterDataActor {
  return {
    id: new Types.ObjectId().toHexString(),
    email: `engage.${engage}@xtreme-works.com`,
    moduleAccess: { ...emptyModuleAccess(), engage },
  };
}

const READER = actor('read');
const WRITER = actor('write');
const OWNER = actor('owner');
const ADMIN: MasterDataActor = {
  id: new Types.ObjectId().toHexString(),
  email: 'admin@xtreme-works.com',
  moduleAccess: fullModuleAccess(),
};
// HR's role grants no module access (SECURITY.md#roles).
const HR_WITHOUT_ACCESS = {
  ...actor('none'),
  email: 'hr@xtreme-works.com',
  roles: ['hr'],
  isSystemAdministrator: false,
};
const NO_ACCESS = actor('none');
// Full access on every other module, none on Engage.
const OTHER_MODULES: MasterDataActor = {
  ...actor('none'),
  moduleAccess: { ...fullModuleAccess(), engage: 'none' },
};

let nameCounter = 0;
/** A fresh client name. */
function nextName(): string {
  nameCounter += 1;
  return `Made-up Client ${nameCounter}`;
}

let employeeCounter = 0;
async function addEmployee({
  status = 'Regular',
  withAccount = true,
  firstName = 'Made',
  lastName = 'Up',
}: {
  status?: EmploymentStatus;
  withAccount?: boolean;
  firstName?: string;
  lastName?: string;
} = {}) {
  employeeCounter += 1;
  const employee = await EmployeeModel.create({
    employeeNumber: `2021-${String(employeeCounter).padStart(2, '0')}`,
    firstName,
    lastName,
    departmentId: new Types.ObjectId(),
    positionId: new Types.ObjectId(),
    employmentStatus: status,
    dateHired: new Date('2021-01-01T00:00:00+08:00'),
    separationDate:
      EMPLOYMENT_STATUS[status] === 'deactivated' ? new Date('2026-06-01T00:00:00+08:00') : null,
  });
  if (withAccount) {
    await UserModel.create({
      email: `am.${employeeCounter}@xtreme-works.com`,
      passwordHash: 'not-a-real-hash',
      employeeId: employee._id,
    });
  }
  return employee;
}

async function entriesFor(id: Types.ObjectId | string) {
  return AuditLogModel.find({ 'record.id': new Types.ObjectId(String(id)) })
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

async function addClient(by: MasterDataActor = WRITER, name = nextName()) {
  const { id } = await createClient(by, { name });
  return { id, name };
}

beforeAll(async () => {
  await connectDb();
  // Collections must exist before a transaction writes to them.
  await Promise.all([
    ClientModel.init(),
    ClientSiteModel.init(),
    ClientContactModel.init(),
    DepartmentModel.init(),
    EmployeeModel.init(),
    UserModel.init(),
    AuditLogModel.init(),
  ]);
});

afterEach(async () => {
  await database().command({ collMod: 'auditLogs', validator: {} });
});

describe('access', () => {
  it.each([
    ['no module access', NO_ACCESS],
    ['HR without module access', HR_WITHOUT_ACCESS],
    ['Owner on every module but Engage', OTHER_MODULES],
  ])('refuses %s everything and changes nothing', async (_label, outsider) => {
    const { id } = await addClient();
    await expect(listClients(outsider)).rejects.toThrow(AccessDeniedError);
    await expect(getClient(outsider, id)).rejects.toThrow(AccessDeniedError);
    await expect(createClient(outsider, { name: nextName() })).rejects.toThrow(AccessDeniedError);
    await expect(updateClient(outsider, id, { name: 'Renamed' })).rejects.toThrow(
      AccessDeniedError,
    );
    await expect(findClientsNamed(outsider, 'x')).rejects.toThrow(AccessDeniedError);
    await expect(searchEligibleAccountManagers(outsider)).rejects.toThrow(AccessDeniedError);
    await expect(retireClient(outsider, id)).rejects.toThrow(AccessDeniedError);
    await retireClient(OWNER, id);
    await expect(restoreClient(outsider, id)).rejects.toThrow(AccessDeniedError);

    const stored = await ClientModel.findById(id, null, { withDeleted: true }).lean().orFail();
    expect(stored.name).not.toBe('Renamed');
    expect(stored.deletedAt).not.toBeNull();
    expect((await entriesFor(id)).map((entry) => entry.action)).toEqual(['create', 'delete']);
  });

  it('lets Engage Read list and open, but not change', async () => {
    const { id, name } = await addClient();
    expect((await listClients(READER)).some((client) => client.id === id)).toBe(true);
    expect((await getClient(READER, id))?.name).toBe(name);

    await expect(createClient(READER, { name: nextName() })).rejects.toThrow(AccessDeniedError);
    await expect(updateClient(READER, id, { name: 'Renamed' })).rejects.toThrow(AccessDeniedError);
    await expect(findClientsNamed(READER, name)).rejects.toThrow(AccessDeniedError);
    await expect(searchEligibleAccountManagers(READER)).rejects.toThrow(AccessDeniedError);
    await expect(retireClient(READER, id)).rejects.toThrow(AccessDeniedError);
    expect(await entriesFor(id)).toHaveLength(1);
  });

  it('lets Engage Write add and edit, but needs Engage Owner to retire or restore', async () => {
    const { id } = await addClient(WRITER);
    await updateClient(WRITER, id, { name: nextName() });
    await expect(retireClient(WRITER, id)).rejects.toThrow(AccessDeniedError);
    expect(await ClientModel.findById(id).lean()).not.toBeNull();

    await retireClient(OWNER, id);
    await expect(restoreClient(WRITER, id)).rejects.toThrow(AccessDeniedError);
    expect(await ClientModel.findById(id).lean()).toBeNull();
    await restoreClient(OWNER, id);
    expect((await entriesFor(id)).map((entry) => entry.action)).toEqual([
      'create',
      'update',
      'delete',
      'restore',
    ]);
  });

  it('lets the System Administrator do everything', async () => {
    const { id } = await addClient(ADMIN);
    await updateClient(ADMIN, id, { name: nextName() });
    await retireClient(ADMIN, id);
    await restoreClient(ADMIN, id);
    expect(await listClients(ADMIN)).not.toHaveLength(0);
    const entries = await entriesFor(id);
    expect(entries.map((entry) => entry.action)).toEqual(['create', 'update', 'delete', 'restore']);
    expect(entries.every((entry) => entry.actorId?.toHexString() === ADMIN.id)).toBe(true);
  });
});

describe('createClient', () => {
  it('stores the fields, with defaults, and writes one create entry labelled with the name', async () => {
    const name = nextName();
    const { id } = await createClient(WRITER, {
      name: `  ${name} `,
      tin: '123-456 789-000',
      billingAddress: '1 Made-up Street, Makati',
      creditTermsDays: '30',
      industry: 'Banking',
      notes: '',
    });

    const stored = await ClientModel.findById(id).lean().orFail();
    expect(stored).toMatchObject({
      name,
      tin: '123456789000',
      billingAddress: '1 Made-up Street, Makati',
      vatTreatment: 'vatRegistered',
      priceDisplay: 'vatExclusive',
      creditTermsDays: 30,
      industry: 'Banking',
      accountManagerEmployeeId: null,
      notes: null,
    });
    expect(stored.createdBy?.toHexString()).toBe(WRITER.id);

    const entries = await entriesFor(id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      module: 'core',
      action: 'create',
      actorEmail: WRITER.email,
      record: { type: 'core.client', label: name },
      before: null,
      // The TIN is company data: kept in full in the snapshot.
      after: { name, tin: '123456789000', creditTermsDays: 30 },
    });

    const view = await getClient(READER, id);
    expect(view).toMatchObject({ tin: '123456789000', tinDisplay: '123-456-789-000' });
  });

  it('accepts 9, 12 and 14 digit TINs and refuses any other', async () => {
    for (const [tin, display] of [
      ['123456789', '123-456-789'],
      ['123 456 789 000', '123-456-789-000'],
      ['123-456-789-00000', '123-456-789-00000'],
    ] as const) {
      const { id } = await createClient(WRITER, { name: nextName(), tin });
      expect((await getClient(READER, id))?.tinDisplay).toBe(display);
    }
    for (const tin of [
      '12345678',
      '1234567890',
      '1234567890123',
      '12345678901234X',
      'ABC-DEF-GHI',
    ]) {
      await expect(createClient(WRITER, { name: nextName(), tin })).rejects.toMatchObject({
        name: 'ActionError',
        field: 'tin',
      });
    }
  });

  it('allows the same TIN on two clients', async () => {
    await createClient(WRITER, { name: nextName(), tin: '987654321' });
    await createClient(WRITER, { name: nextName(), tin: '987-654-321' });
    expect(await ClientModel.countDocuments({ tin: '987654321' })).toBe(2);
  });

  it('checks the credit terms range', async () => {
    for (const creditTermsDays of ['-1', '366', '7.5', 'abc']) {
      await expect(
        createClient(WRITER, { name: nextName(), creditTermsDays }),
      ).rejects.toMatchObject({ field: 'creditTermsDays' });
    }
    const { id } = await createClient(WRITER, { name: nextName(), creditTermsDays: '365' });
    expect((await ClientModel.findById(id).lean())?.creditTermsDays).toBe(365);
  });

  it('refuses a missing name', async () => {
    await expect(createClient(WRITER, { name: '   ' })).rejects.toMatchObject({ field: 'name' });
  });

  it('writes nothing when the audit entry can’t be written', async () => {
    const name = nextName();
    await failAuditWrites();
    await expect(createClient(WRITER, { name })).rejects.toThrow();
    expect(await ClientModel.exists({ name }).setOptions({ withDeleted: true })).toBeNull();
  });
});

describe('duplicate client names', () => {
  it('refuses a name matching another client ignoring case, then saves it when confirmed', async () => {
    const { name } = await addClient();
    const error = await createClient(WRITER, { name: name.toUpperCase() }).catch((e) => e);
    expect(error).toBeInstanceOf(ActionError);
    expect(error).toMatchObject({ field: 'name' });
    expect(String(error.message)).toContain(name);
    expect(String(error.message)).toContain('Save anyway');
    expect(await ClientModel.countDocuments({ name: name.toUpperCase() })).toBe(0);

    const { id } = await createClient(WRITER, {
      name: name.toUpperCase(),
      allowDuplicateName: true,
    });
    expect((await ClientModel.findById(id).lean())?.name).toBe(name.toUpperCase());
  });

  it('counts retired clients and says the match is retired', async () => {
    const { id, name } = await addClient();
    await retireClient(OWNER, id);
    await expect(createClient(WRITER, { name })).rejects.toMatchObject({
      field: 'name',
      message: expect.stringContaining('(retired)'),
    });
    await createClient(WRITER, { name, allowDuplicateName: 'on' });
  });

  it('checks a rename, but not an unchanged name', async () => {
    const first = await addClient();
    const second = await addClient();
    await expect(updateClient(WRITER, second.id, { name: first.name })).rejects.toMatchObject({
      field: 'name',
    });
    await updateClient(WRITER, second.id, { name: first.name, allowDuplicateName: true });
    // Saving it again, unchanged, needs no confirmation.
    await updateClient(WRITER, second.id, { name: first.name, industry: 'Retail' });
    expect((await ClientModel.findById(second.id).lean())?.industry).toBe('Retail');
  });

  it('findClientsNamed lists the matches ignoring case, retired ones included', async () => {
    const live = await addClient();
    const retired = await createClient(WRITER, {
      name: live.name.toLowerCase(),
      allowDuplicateName: true,
    });
    await retireClient(OWNER, retired.id);

    const found = await findClientsNamed(WRITER, `  ${live.name.toUpperCase()} `);
    expect(found).toEqual([
      { id: live.id, name: live.name, retired: false },
      { id: retired.id, name: live.name.toLowerCase(), retired: true },
    ]);
    expect(await findClientsNamed(WRITER, live.name, live.id)).toEqual([
      { id: retired.id, name: live.name.toLowerCase(), retired: true },
    ]);
    expect(await findClientsNamed(WRITER, '   ')).toEqual([]);
  });
});

describe('Account Manager', () => {
  it('accepts an employee whose account is active, and lists their name', async () => {
    const manager = await addEmployee({ firstName: 'Amparo', lastName: 'Dimaculangan' });
    const { id } = await createClient(WRITER, {
      name: nextName(),
      accountManagerEmployeeId: manager._id.toHexString(),
    });
    const listed = (await listClients(READER)).find((client) => client.id === id);
    expect(listed).toMatchObject({
      accountManagerEmployeeId: manager._id.toHexString(),
      accountManagerName: 'Amparo Dimaculangan',
      accountManagerActive: true,
    });

    await updateClient(WRITER, id, { name: listed?.name ?? '', accountManagerEmployeeId: '' });
    expect((await ClientModel.findById(id).lean())?.accountManagerEmployeeId).toBeNull();
  });

  it('refuses an inactive employee, one without an account, the system account and an unknown id', async () => {
    const resigned = await addEmployee({ status: 'Resigned' });
    const noAccount = await addEmployee({ withAccount: false });
    const system = await UserModel.create({
      email: 'system.account@xtreme-works.com',
      passwordHash: 'not-a-real-hash',
      mustChangePassword: false,
      isSystemAdministrator: true,
      isSystemAccount: true,
      employeeId: null,
    });
    const { id, name } = await addClient();

    for (const accountManagerEmployeeId of [
      resigned._id.toHexString(),
      noAccount._id.toHexString(),
      system._id.toHexString(),
      new Types.ObjectId().toHexString(),
    ]) {
      await expect(
        createClient(WRITER, { name: nextName(), accountManagerEmployeeId }),
      ).rejects.toMatchObject({ field: 'accountManagerEmployeeId' });
      await expect(
        updateClient(WRITER, id, { name, accountManagerEmployeeId }),
      ).rejects.toMatchObject({ field: 'accountManagerEmployeeId' });
    }
    expect(await entriesFor(id)).toHaveLength(1);
  });

  it('keeps an unchanged Account Manager who later became inactive, shown as inactive', async () => {
    const manager = await addEmployee();
    const { id, name } = await addClient();
    await updateClient(WRITER, id, { name, accountManagerEmployeeId: manager._id.toHexString() });
    await EmployeeModel.updateOne(
      { _id: manager._id },
      { $set: { employmentStatus: 'Resigned', separationDate: new Date('2026-07-01') } },
    );

    await updateClient(WRITER, id, {
      name,
      notes: 'Still theirs',
      accountManagerEmployeeId: manager._id.toHexString(),
    });
    const stored = await ClientModel.findById(id).lean().orFail();
    expect(stored.accountManagerEmployeeId?.toHexString()).toBe(manager._id.toHexString());
    expect(stored.notes).toBe('Still theirs');
    expect((await getClient(READER, id))?.accountManagerActive).toBe(false);

    // Picking them again on another client is refused.
    await expect(
      createClient(WRITER, {
        name: nextName(),
        accountManagerEmployeeId: manager._id.toHexString(),
      }),
    ).rejects.toMatchObject({ field: 'accountManagerEmployeeId' });
  });

  it('searches only employees whose account is active', async () => {
    const active = await addEmployee({ firstName: 'Teodora', lastName: 'Bagatsing' });
    await addEmployee({ firstName: 'Teodora', lastName: 'Separated', status: 'Terminated' });
    await addEmployee({ firstName: 'Teodora', lastName: 'Noaccount', withAccount: false });
    const found = await searchEligibleAccountManagers(WRITER, 'teodora');
    expect(found.map((option) => option.id)).toEqual([active._id.toHexString()]);
    expect(found[0]).toMatchObject({
      name: 'Teodora Bagatsing',
      employeeNumber: active.employeeNumber,
    });
  });
});

describe('updateClient', () => {
  it('writes one update entry with before and after, labelled with the new name', async () => {
    const { id, name } = await addClient();
    const renamed = nextName();
    await updateClient(WRITER, id, { name: renamed, vatTreatment: 'zeroRated' });

    const entries = await entriesFor(id);
    expect(entries.map((entry) => entry.action)).toEqual(['create', 'update']);
    expect(entries[1]).toMatchObject({
      record: { type: 'core.client', label: renamed },
      before: { name, vatTreatment: 'vatRegistered' },
      after: { name: renamed, vatTreatment: 'zeroRated' },
    });
  });

  it('refuses a retired client until it is restored', async () => {
    const { id, name } = await addClient();
    await retireClient(OWNER, id);
    await expect(updateClient(WRITER, id, { name, industry: 'X' })).rejects.toBeInstanceOf(
      ActionError,
    );
    await restoreClient(OWNER, id);
    await updateClient(WRITER, id, { name, industry: 'X' });
    expect((await ClientModel.findById(id).lean())?.industry).toBe('X');
  });

  it('refuses an unknown client', async () => {
    await expect(
      updateClient(WRITER, new Types.ObjectId().toHexString(), { name: 'X' }),
    ).rejects.toBeInstanceOf(ActionError);
  });

  it('leaves the client unchanged when the audit entry can’t be written', async () => {
    const { id, name } = await addClient();
    await failAuditWrites();
    await expect(updateClient(WRITER, id, { name: nextName() })).rejects.toThrow();
    expect((await ClientModel.findById(id).lean())?.name).toBe(name);
  });
});

describe('retire and restore', () => {
  it('retires with a delete entry whose after is null, leaving sites and contacts as they are', async () => {
    const { id, name } = await addClient();
    const site = await addClientSite(WRITER, { clientId: id, name: 'Head Office' });
    const contact = await addClientContact(WRITER, {
      clientId: id,
      name: 'Ana Made-up',
      isPrimary: true,
    });
    await retireClient(OWNER, id);

    expect(await ClientModel.findById(id).lean()).toBeNull();
    const entries = await entriesFor(id);
    expect(entries[1]).toMatchObject({
      action: 'delete',
      record: { type: 'core.client', label: name },
      before: { name, deletedAt: null },
      after: null,
    });
    expect(await ClientSiteModel.findById(site.id).lean()).not.toBeNull();
    expect(await ClientContactModel.findById(contact.id).lean()).toMatchObject({
      isPrimary: true,
    });

    expect((await listClients(READER)).some((client) => client.id === id)).toBe(false);
    const withRetired = await listClients(READER, { includeRetired: true });
    expect(withRetired.find((client) => client.id === id)).toMatchObject({
      siteCount: 1,
      contactCount: 1,
    });
    expect(withRetired.find((client) => client.id === id)?.retiredAt).toBeInstanceOf(Date);
    expect((await listClientOptions()).some((option) => option.id === id)).toBe(false);
    await expect(retireClient(OWNER, id)).rejects.toBeInstanceOf(ActionError);
  });

  it('restores unchanged, with its sites and contacts', async () => {
    const { id, name } = await addClient();
    await addClientSite(WRITER, { clientId: id, name: 'Branch' });
    await retireClient(OWNER, id);
    await restoreClient(OWNER, id);

    const view = await getClient(READER, id);
    expect(view).toMatchObject({ name, retiredAt: null, siteCount: 1 });
    expect(view?.sites.map((site) => site.name)).toEqual(['Branch']);
    const entries = await entriesFor(id);
    expect(entries.map((entry) => entry.action)).toEqual(['create', 'delete', 'restore']);
    expect(entries[2]?.after).toMatchObject({ name, deletedAt: null });
    await expect(restoreClient(OWNER, id)).rejects.toBeInstanceOf(ActionError);
  });

  it('rolls back a retire or restore when the audit entry can’t be written', async () => {
    const { id } = await addClient();
    await failAuditWrites();
    await expect(retireClient(OWNER, id)).rejects.toThrow();
    expect(await ClientModel.findById(id).lean()).not.toBeNull();

    await database().command({ collMod: 'auditLogs', validator: {} });
    await retireClient(OWNER, id);
    await failAuditWrites();
    await expect(restoreClient(OWNER, id)).rejects.toThrow();
    expect(await ClientModel.findById(id).lean()).toBeNull();
  });
});

describe('reading', () => {
  it('lists live site and contact counts, and opens a client with its sites and contacts', async () => {
    const { id } = await addClient();
    await addClientSite(WRITER, { clientId: id, name: 'Zeta Branch' });
    await addClientSite(WRITER, { clientId: id, name: 'alpha branch' });
    await addClientContact(WRITER, { clientId: id, name: 'Zed Contact' });
    await addClientContact(WRITER, { clientId: id, name: 'Primary Contact', isPrimary: true });

    const listed = (await listClients(READER)).find((client) => client.id === id);
    expect(listed).toMatchObject({ siteCount: 2, contactCount: 2 });
    const view = await getClient(READER, id);
    expect(view?.sites.map((site) => site.name)).toEqual(['alpha branch', 'Zeta Branch']);
    expect(view?.contacts.map((contact) => contact.name)).toEqual([
      'Primary Contact',
      'Zed Contact',
    ]);
    expect(await getClient(READER, new Types.ObjectId().toHexString())).toBeNull();
    expect(await getClient(READER, 'not-an-id')).toBeNull();
  });

  it('gives the picker only the id and name of live clients', async () => {
    const { id, name } = await addClient();
    const option = (await listClientOptions()).find((client) => client.id === id);
    expect(option).toEqual({ id, name });
  });
});
