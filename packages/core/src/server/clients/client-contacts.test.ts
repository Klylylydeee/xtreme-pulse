import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose, { type mongo, Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { AccessDeniedError, ActionError } from '../../actions';
import { emptyModuleAccess, fullModuleAccess, type LevelFor } from '../../module-access';
import { AuditLogModel } from '../audit/model';
import type { MasterDataActor } from '../master-data-access';
import { ClientContactModel, PRIMARY_CONTACT_INDEX } from './contact-model';
import {
  addClientContact,
  listClientContactOptions,
  removeClientContact,
  restoreClientContact,
  updateClientContact,
} from './contacts';
import { ClientModel } from './model';
import { createClient, getClient, restoreClient, retireClient } from './service';

// Client contacts (docs/modules/core.md#managing-master-data, docs/modules/engage.md#clients-sites-and-contacts,
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
async function addClient() {
  counter += 1;
  const name = `Made-up Retailer ${counter}`;
  const { id } = await createClient(WRITER, { name });
  return { id, name };
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

async function primaryIds(clientId: string): Promise<string[]> {
  const primaries = await ClientContactModel.find({ clientId, isPrimary: true }, { _id: 1 })
    .setOptions({ withDeleted: true })
    .lean();
  return primaries.map((contact) => contact._id.toHexString());
}

beforeAll(async () => {
  await connectDb();
  await Promise.all([ClientModel.init(), ClientContactModel.init(), AuditLogModel.init()]);
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
    const { id } = await addClientContact(WRITER, { clientId: client.id, name: 'Rosa Made-up' });
    await expect(
      addClientContact(outsider, { clientId: client.id, name: 'Other Person' }),
    ).rejects.toThrow(AccessDeniedError);
    await expect(updateClientContact(outsider, id, { name: 'Renamed' })).rejects.toThrow(
      AccessDeniedError,
    );
    await expect(removeClientContact(outsider, id)).rejects.toThrow(AccessDeniedError);
    await removeClientContact(WRITER, id);
    await expect(restoreClientContact(outsider, id)).rejects.toThrow(AccessDeniedError);

    expect(await ClientContactModel.countDocuments({ clientId: client.id })).toBe(0);
    expect((await entriesFor(id)).map((entry) => entry.action)).toEqual(['create', 'delete']);
  });

  it('lets Engage Write, Owner and the System Administrator manage contacts', async () => {
    for (const by of [WRITER, OWNER, ADMIN]) {
      const client = await addClient();
      const { id } = await addClientContact(by, { clientId: client.id, name: 'Lito Made-up' });
      await updateClientContact(by, id, { name: 'Lito Made-up Jr.' });
      await removeClientContact(by, id);
      await restoreClientContact(by, id);
      expect((await entriesFor(id)).map((entry) => entry.action)).toEqual([
        'create',
        'update',
        'delete',
        'restore',
      ]);
    }
  });
});

describe('addClientContact', () => {
  it('stores the contact, email lowercased and mobile as typed, with a labelled create entry', async () => {
    const client = await addClient();
    const { id } = await addClientContact(WRITER, {
      clientId: client.id,
      name: 'Ana Cruz',
      position: 'IT Manager',
      email: ' Ana.Cruz@Example.COM ',
      mobile: '+63 (917) 123-4567',
    });
    const stored = await ClientContactModel.findById(id).lean().orFail();
    expect(stored).toMatchObject({
      name: 'Ana Cruz',
      position: 'IT Manager',
      email: 'ana.cruz@example.com',
      mobile: '+63 (917) 123-4567',
      isPrimary: false,
    });
    const entries = await entriesFor(id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      module: 'core',
      action: 'create',
      record: { type: 'core.clientContact', label: `${client.name} · Ana Cruz` },
      before: null,
      after: { name: 'Ana Cruz', email: 'ana.cruz@example.com' },
    });
  });

  it('accepts the lenient Philippine mobile forms and refuses others', async () => {
    const client = await addClient();
    for (const mobile of ['09171234567', '0917 123 4567', '639171234567', '+63-917-123-4567']) {
      await addClientContact(WRITER, { clientId: client.id, name: `Mobile ${mobile}`, mobile });
    }
    for (const mobile of ['0817 123 4567', '0917 123 456', '+1 917 123 4567', 'call me']) {
      await expect(
        addClientContact(WRITER, { clientId: client.id, name: 'Bad mobile', mobile }),
      ).rejects.toMatchObject({ field: 'mobile' });
    }
  });

  it('refuses an email that doesn’t look like one, and a missing name', async () => {
    const client = await addClient();
    for (const email of ['not-an-email', 'a@', '@example.com']) {
      await expect(
        addClientContact(WRITER, { clientId: client.id, name: 'Bad email', email }),
      ).rejects.toMatchObject({ field: 'email' });
    }
    await expect(
      addClientContact(WRITER, { clientId: client.id, name: ' ' }),
    ).rejects.toMatchObject({ field: 'name' });
    expect(await ClientContactModel.countDocuments({ clientId: client.id })).toBe(0);
  });

  it('refuses a retired client', async () => {
    const client = await addClient();
    await retireClient(OWNER, client.id);
    await expect(
      addClientContact(WRITER, { clientId: client.id, name: 'Too late' }),
    ).rejects.toMatchObject({ name: 'ActionError', field: 'clientId' });
    expect(
      await ClientContactModel.countDocuments({ clientId: client.id }).setOptions({
        withDeleted: true,
      }),
    ).toBe(0);
  });

  it('writes nothing when the audit entry can’t be written', async () => {
    const client = await addClient();
    await failAuditWrites();
    await expect(
      addClientContact(WRITER, { clientId: client.id, name: 'Rolled back' }),
    ).rejects.toThrow();
    expect(await ClientContactModel.exists({ clientId: client.id })).toBeNull();
  });
});

describe('primary contact', () => {
  it('marking a new primary clears the old one, with an update entry for it', async () => {
    const client = await addClient();
    const first = await addClientContact(WRITER, {
      clientId: client.id,
      name: 'First Primary',
      isPrimary: true,
    });
    const second = await addClientContact(WRITER, {
      clientId: client.id,
      name: 'Second Primary',
      isPrimary: 'on',
    });
    expect(await primaryIds(client.id)).toEqual([second.id]);
    const firstEntries = await entriesFor(first.id);
    expect(firstEntries.map((entry) => entry.action)).toEqual(['create', 'update']);
    expect(firstEntries[1]).toMatchObject({
      record: { type: 'core.clientContact', label: `${client.name} · First Primary` },
      before: { isPrimary: true },
      after: { isPrimary: false },
    });

    // Marking an existing contact primary on edit.
    await updateClientContact(WRITER, first.id, { name: 'First Primary', isPrimary: true });
    expect(await primaryIds(client.id)).toEqual([first.id]);
    // Unmarking leaves the client with no primary contact.
    await updateClientContact(WRITER, first.id, { name: 'First Primary', isPrimary: false });
    expect(await primaryIds(client.id)).toEqual([]);
  });

  it('keeps the old primary when the audit entry can’t be written', async () => {
    const client = await addClient();
    const first = await addClientContact(WRITER, {
      clientId: client.id,
      name: 'Kept Primary',
      isPrimary: true,
    });
    await failAuditWrites();
    await expect(
      addClientContact(WRITER, { clientId: client.id, name: 'Not saved', isPrimary: true }),
    ).rejects.toThrow();
    expect(await primaryIds(client.id)).toEqual([first.id]);
  });

  it('never leaves two primaries when two marks overlap', async () => {
    for (let round = 0; round < 5; round += 1) {
      const client = await addClient();
      const results = await Promise.allSettled([
        addClientContact(WRITER, { clientId: client.id, name: `A ${round}`, isPrimary: true }),
        addClientContact(WRITER, { clientId: client.id, name: `B ${round}`, isPrimary: true }),
      ]);
      expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
      expect(await primaryIds(client.id)).toHaveLength(1);
    }
  });

  it('removing the primary contact clears its flag, and it comes back not primary', async () => {
    const client = await addClient();
    const { id } = await addClientContact(WRITER, {
      clientId: client.id,
      name: 'Leaving Primary',
      isPrimary: true,
    });
    await removeClientContact(WRITER, id);
    const removed = await ClientContactModel.findById(id, null, { withDeleted: true })
      .lean()
      .orFail();
    expect(removed).toMatchObject({ isPrimary: false });
    expect(removed.deletedAt).toBeInstanceOf(Date);

    // A new primary can be marked while the old one is removed.
    const next = await addClientContact(WRITER, {
      clientId: client.id,
      name: 'New Primary',
      isPrimary: true,
    });
    await restoreClientContact(WRITER, id);
    expect(await ClientContactModel.findById(id).lean()).toMatchObject({ isPrimary: false });
    expect(await primaryIds(client.id)).toEqual([next.id]);

    const entries = await entriesFor(id);
    expect(entries.map((entry) => entry.action)).toEqual(['create', 'delete', 'restore']);
    expect(entries[1]).toMatchObject({
      record: { label: `${client.name} · Leaving Primary` },
      before: { isPrimary: true },
      after: null,
    });
  });

  it('has a partial unique index that refuses a second primary', async () => {
    const indexes = await ClientContactModel.collection.indexes();
    expect(indexes.find((index) => index.name === PRIMARY_CONTACT_INDEX)).toMatchObject({
      unique: true,
      partialFilterExpression: { isPrimary: true },
    });
    const client = await addClient();
    await ClientContactModel.create({ clientId: client.id, name: 'One', isPrimary: true });
    await expect(
      ClientContactModel.create({ clientId: client.id, name: 'Two', isPrimary: true }),
    ).rejects.toMatchObject({ code: 11000 });
  });
});

describe('updateClientContact', () => {
  it('writes one update entry with before and after', async () => {
    const client = await addClient();
    const { id } = await addClientContact(WRITER, { clientId: client.id, name: 'Old Name' });
    await updateClientContact(WRITER, id, { name: 'New Name', email: 'new@example.com' });
    const entries = await entriesFor(id);
    expect(entries[1]).toMatchObject({
      action: 'update',
      record: { type: 'core.clientContact', label: `${client.name} · New Name` },
      before: { name: 'Old Name', email: null },
      after: { name: 'New Name', email: 'new@example.com' },
    });
  });

  it('can’t move a contact to another client', async () => {
    const client = await addClient();
    const other = await addClient();
    const { id } = await addClientContact(WRITER, { clientId: client.id, name: 'Fixed' });
    const moved = { name: 'Fixed', clientId: other.id } as unknown as { name: string };
    await expect(updateClientContact(WRITER, id, moved)).rejects.toMatchObject({
      field: 'clientId',
    });
  });

  it('refuses a removed contact, and any contact of a retired client', async () => {
    const client = await addClient();
    const { id } = await addClientContact(WRITER, { clientId: client.id, name: 'Kept' });
    const removed = await addClientContact(WRITER, { clientId: client.id, name: 'Gone' });
    await removeClientContact(WRITER, removed.id);
    await expect(updateClientContact(WRITER, removed.id, { name: 'X' })).rejects.toBeInstanceOf(
      ActionError,
    );

    await retireClient(OWNER, client.id);
    await expect(updateClientContact(WRITER, id, { name: 'X' })).rejects.toBeInstanceOf(
      ActionError,
    );
    await expect(removeClientContact(WRITER, id)).rejects.toBeInstanceOf(ActionError);
    await expect(restoreClientContact(WRITER, removed.id)).rejects.toMatchObject({
      field: 'clientId',
    });

    await restoreClient(OWNER, client.id);
    await restoreClientContact(WRITER, removed.id);
    expect((await getClient(READER, client.id))?.contacts.map((c) => c.name).sort()).toEqual([
      'Gone',
      'Kept',
    ]);
  });

  it('leaves the contact unchanged when the audit entry can’t be written', async () => {
    const client = await addClient();
    const { id } = await addClientContact(WRITER, { clientId: client.id, name: 'Steady' });
    await failAuditWrites();
    await expect(updateClientContact(WRITER, id, { name: 'Changed' })).rejects.toThrow();
    await expect(removeClientContact(WRITER, id)).rejects.toThrow();
    expect(await ClientContactModel.findById(id).lean()).toMatchObject({ name: 'Steady' });
  });
});

describe('listClientContactOptions', () => {
  it('lists only the id and name of live contacts of a live client, the primary first', async () => {
    const client = await addClient();
    const plain = await addClientContact(WRITER, { clientId: client.id, name: 'Aaron' });
    const primary = await addClientContact(WRITER, {
      clientId: client.id,
      name: 'Zoila',
      isPrimary: true,
    });
    const removed = await addClientContact(WRITER, { clientId: client.id, name: 'Removed' });
    await removeClientContact(WRITER, removed.id);

    expect(await listClientContactOptions(client.id)).toEqual([
      { id: primary.id, name: 'Zoila' },
      { id: plain.id, name: 'Aaron' },
    ]);
    await retireClient(OWNER, client.id);
    expect(await listClientContactOptions(client.id)).toEqual([]);
  });
});
