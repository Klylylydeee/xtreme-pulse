import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose, { type mongo, Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { AccessDeniedError, ActionError } from '../../actions';
import { emptyModuleAccess, fullModuleAccess, type LevelFor } from '../../module-access';
import { AuditLogModel } from '../audit/model';
import type { MasterDataActor } from '../master-data-access';
import { ClientModel } from './model';
import { createClient, getClient, restoreClient, retireClient } from './service';
import { ClientSiteModel } from './site-model';
import {
  addClientSite,
  listClientSiteOptions,
  removeClientSite,
  restoreClientSite,
  updateClientSite,
} from './sites';

// Client sites (docs/modules/core.md#managing-master-data, docs/modules/engage.md#clients-sites-and-contacts,
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
const HR_WITHOUT_ACCESS = { ...actor('none'), roles: ['hr'], isSystemAdministrator: false };

let counter = 0;
async function addClient(name?: string) {
  counter += 1;
  const clientName = name ?? `Made-up Bank ${counter}`;
  const { id } = await createClient(WRITER, { name: clientName, allowDuplicateName: true });
  return { id, name: clientName };
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

beforeAll(async () => {
  await connectDb();
  await Promise.all([ClientModel.init(), ClientSiteModel.init(), AuditLogModel.init()]);
});

afterEach(async () => {
  await database().command({ collMod: 'auditLogs', validator: {} });
});

describe('access', () => {
  it.each([
    ['Engage Read', READER],
    ['HR without module access', HR_WITHOUT_ACCESS],
  ])('refuses %s every change', async (_label, outsider) => {
    const client = await addClient();
    const { id } = await addClientSite(WRITER, { clientId: client.id, name: 'Main' });
    await expect(addClientSite(outsider, { clientId: client.id, name: 'Other' })).rejects.toThrow(
      AccessDeniedError,
    );
    await expect(updateClientSite(outsider, id, { name: 'Renamed' })).rejects.toThrow(
      AccessDeniedError,
    );
    await expect(removeClientSite(outsider, id)).rejects.toThrow(AccessDeniedError);
    await removeClientSite(WRITER, id);
    await expect(restoreClientSite(outsider, id)).rejects.toThrow(AccessDeniedError);

    expect(await ClientSiteModel.countDocuments({ clientId: client.id })).toBe(0);
    expect((await entriesFor(id)).map((entry) => entry.action)).toEqual(['create', 'delete']);
  });

  it('lets Engage Write, Owner and the System Administrator manage sites', async () => {
    for (const by of [WRITER, OWNER, ADMIN]) {
      const client = await addClient();
      const { id } = await addClientSite(by, { clientId: client.id, name: 'Main' });
      await updateClientSite(by, id, { name: 'Main Office' });
      await removeClientSite(by, id);
      await restoreClientSite(by, id);
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
});

describe('addClientSite', () => {
  it('stores the site with one create entry labelled “<client> · <site>”', async () => {
    const client = await addClient();
    const { id } = await addClientSite(WRITER, {
      clientId: client.id,
      name: ' Makati Branch ',
      address: '1 Made-up Avenue',
      city: 'Makati',
      siteContact: 'Guard on duty',
    });
    const stored = await ClientSiteModel.findById(id).lean().orFail();
    expect(stored).toMatchObject({
      name: 'Makati Branch',
      address: '1 Made-up Avenue',
      city: 'Makati',
      siteContact: 'Guard on duty',
    });
    expect(stored.clientId.toHexString()).toBe(client.id);

    const entries = await entriesFor(id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      module: 'core',
      action: 'create',
      record: { type: 'core.clientSite', label: `${client.name} · Makati Branch` },
      before: null,
      after: { name: 'Makati Branch', city: 'Makati' },
    });
  });

  it('refuses a retired or unknown client', async () => {
    const client = await addClient();
    await retireClient(OWNER, client.id);
    await expect(
      addClientSite(WRITER, { clientId: client.id, name: 'Too late' }),
    ).rejects.toMatchObject({ name: 'ActionError', field: 'clientId' });
    await expect(
      addClientSite(WRITER, { clientId: new Types.ObjectId().toHexString(), name: 'Nowhere' }),
    ).rejects.toMatchObject({ field: 'clientId' });
    await expect(addClientSite(WRITER, { clientId: 'bad', name: 'Bad' })).rejects.toMatchObject({
      field: 'clientId',
    });
    expect(await ClientSiteModel.countDocuments({ name: { $in: ['Too late', 'Nowhere'] } })).toBe(
      0,
    );
  });

  it('refuses a name the client already has ignoring case, removed sites included', async () => {
    const client = await addClient();
    const other = await addClient();
    const { id } = await addClientSite(WRITER, { clientId: client.id, name: 'Cebu Branch' });

    await expect(
      addClientSite(WRITER, { clientId: client.id, name: 'CEBU branch' }),
    ).rejects.toMatchObject({ field: 'name' });
    // The same name on another client is fine.
    await addClientSite(WRITER, { clientId: other.id, name: 'Cebu Branch' });

    await removeClientSite(WRITER, id);
    await expect(
      addClientSite(WRITER, { clientId: client.id, name: 'cebu branch' }),
    ).rejects.toMatchObject({ field: 'name', message: expect.stringContaining('Restore') });
  });

  it('has a unique index that refuses a name differing only in case', async () => {
    const client = await addClient();
    await ClientSiteModel.create({ clientId: client.id, name: 'Davao Branch' });
    await expect(
      ClientSiteModel.create({ clientId: client.id, name: 'DAVAO BRANCH' }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('writes nothing when the audit entry can’t be written', async () => {
    const client = await addClient();
    await failAuditWrites();
    await expect(
      addClientSite(WRITER, { clientId: client.id, name: 'Rolled back' }),
    ).rejects.toThrow();
    expect(
      await ClientSiteModel.exists({ clientId: client.id }).setOptions({ withDeleted: true }),
    ).toBeNull();
  });
});

describe('updateClientSite', () => {
  it('writes one update entry with before and after', async () => {
    const client = await addClient();
    const { id } = await addClientSite(WRITER, { clientId: client.id, name: 'Old Name' });
    await updateClientSite(WRITER, id, { name: 'New Name', city: 'Pasig' });

    const entries = await entriesFor(id);
    expect(entries[1]).toMatchObject({
      action: 'update',
      record: { type: 'core.clientSite', label: `${client.name} · New Name` },
      before: { name: 'Old Name', city: null },
      after: { name: 'New Name', city: 'Pasig' },
    });
  });

  it('refuses a name another site of the client has, but allows a change of case of its own', async () => {
    const client = await addClient();
    await addClientSite(WRITER, { clientId: client.id, name: 'North' });
    const { id } = await addClientSite(WRITER, { clientId: client.id, name: 'South' });
    await expect(updateClientSite(WRITER, id, { name: 'north' })).rejects.toMatchObject({
      field: 'name',
    });
    await updateClientSite(WRITER, id, { name: 'SOUTH' });
    expect((await ClientSiteModel.findById(id).lean())?.name).toBe('SOUTH');
  });

  it('can’t move a site to another client', async () => {
    const client = await addClient();
    const other = await addClient();
    const { id } = await addClientSite(WRITER, { clientId: client.id, name: 'Fixed' });
    const moved = { name: 'Fixed', clientId: other.id } as unknown as { name: string };
    await expect(updateClientSite(WRITER, id, moved)).rejects.toMatchObject({
      field: 'clientId',
    });
  });

  it('refuses a removed site, and any site of a retired client', async () => {
    const client = await addClient();
    const { id } = await addClientSite(WRITER, { clientId: client.id, name: 'Kept' });
    const removed = await addClientSite(WRITER, { clientId: client.id, name: 'Gone' });
    await removeClientSite(WRITER, removed.id);
    await expect(updateClientSite(WRITER, removed.id, { name: 'Gone 2' })).rejects.toBeInstanceOf(
      ActionError,
    );

    await retireClient(OWNER, client.id);
    await expect(updateClientSite(WRITER, id, { name: 'Kept 2' })).rejects.toBeInstanceOf(
      ActionError,
    );
    await expect(removeClientSite(WRITER, id)).rejects.toBeInstanceOf(ActionError);
    await expect(restoreClientSite(WRITER, removed.id)).rejects.toBeInstanceOf(ActionError);
    expect((await ClientSiteModel.findById(id).lean())?.name).toBe('Kept');
  });

  it('leaves the site unchanged when the audit entry can’t be written', async () => {
    const client = await addClient();
    const { id } = await addClientSite(WRITER, { clientId: client.id, name: 'Steady' });
    await failAuditWrites();
    await expect(updateClientSite(WRITER, id, { name: 'Changed' })).rejects.toThrow();
    expect((await ClientSiteModel.findById(id).lean())?.name).toBe('Steady');
  });
});

describe('remove and restore', () => {
  it('removes with a delete entry whose after is null, and restores unchanged', async () => {
    const client = await addClient();
    const { id } = await addClientSite(WRITER, {
      clientId: client.id,
      name: 'Pop-up',
      city: 'Taguig',
    });
    await removeClientSite(WRITER, id);
    expect(await ClientSiteModel.findById(id).lean()).toBeNull();
    expect((await getClient(READER, client.id))?.sites).toEqual([]);
    const withRemoved = await getClient(READER, client.id, { includeRemoved: true });
    expect(withRemoved?.sites[0]?.removedAt).toBeInstanceOf(Date);
    expect(withRemoved?.siteCount).toBe(0);
    await expect(removeClientSite(WRITER, id)).rejects.toBeInstanceOf(ActionError);

    await restoreClientSite(WRITER, id);
    expect(await ClientSiteModel.findById(id).lean()).toMatchObject({
      name: 'Pop-up',
      city: 'Taguig',
      deletedAt: null,
    });
    const entries = await entriesFor(id);
    expect(entries.map((entry) => entry.action)).toEqual(['create', 'delete', 'restore']);
    expect(entries[1]).toMatchObject({
      record: { label: `${client.name} · Pop-up` },
      before: { name: 'Pop-up' },
      after: null,
    });
    await expect(restoreClientSite(WRITER, id)).rejects.toBeInstanceOf(ActionError);
  });

  it('restores a site once its client is restored', async () => {
    const client = await addClient();
    const { id } = await addClientSite(WRITER, { clientId: client.id, name: 'Later' });
    await removeClientSite(WRITER, id);
    await retireClient(OWNER, client.id);
    await expect(restoreClientSite(WRITER, id)).rejects.toMatchObject({ field: 'clientId' });
    await restoreClient(OWNER, client.id);
    await restoreClientSite(WRITER, id);
    expect(await ClientSiteModel.findById(id).lean()).not.toBeNull();
  });

  it('rolls back a removal when the audit entry can’t be written', async () => {
    const client = await addClient();
    const { id } = await addClientSite(WRITER, { clientId: client.id, name: 'Stays' });
    await failAuditWrites();
    await expect(removeClientSite(WRITER, id)).rejects.toThrow();
    expect(await ClientSiteModel.findById(id).lean()).not.toBeNull();
  });

  it('never leaves a live site on a retired client when a retire overlaps an add', async () => {
    for (let round = 0; round < 5; round += 1) {
      const client = await addClient();
      const [added, retired] = await Promise.allSettled([
        addClientSite(WRITER, { clientId: client.id, name: `Race ${round}` }),
        retireClient(OWNER, client.id),
      ]);
      expect(retired.status).toBe('fulfilled');
      const stored = await ClientModel.findById(client.id, null, { withDeleted: true })
        .lean()
        .orFail();
      expect(stored.deletedAt).not.toBeNull();
      // The add either landed before the retire (allowed: retiring leaves sites as they are) or
      // was refused as on a retired client; it never fails any other way.
      if (added.status === 'rejected') {
        expect(added.reason).toMatchObject({ name: 'ActionError', field: 'clientId' });
      }
    }
  });
});

describe('listClientSiteOptions', () => {
  it('lists only the id and name of live sites of a live client', async () => {
    const client = await addClient();
    const { id } = await addClientSite(WRITER, { clientId: client.id, name: 'Shown' });
    const removed = await addClientSite(WRITER, { clientId: client.id, name: 'Hidden' });
    await removeClientSite(WRITER, removed.id);
    expect(await listClientSiteOptions(client.id)).toEqual([{ id, name: 'Shown' }]);

    await retireClient(OWNER, client.id);
    expect(await listClientSiteOptions(client.id)).toEqual([]);
    expect(await listClientSiteOptions('not-an-id')).toEqual([]);
  });
});
