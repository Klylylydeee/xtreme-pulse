import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose, { mongo, Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { AuditLogModel } from '../audit/model';
import { UserModel } from '../users/model';
import { changePassword } from './change-password';
import { hashPassword, verifyPassword } from './password';

// Password changes are audit-logged in the same transaction, without the password or its hash
// (SECURITY.md#audit-logging, docs/TESTING.md#audit-notification-and-reveal-tests). Made-up data.

const OLD_PASSWORD = 'made-up old password 1';
const NEW_PASSWORD = 'made-up new password 2';

function database(): mongo.Db {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Not connected.');
  return db;
}

async function createUser(email: string) {
  const user = await UserModel.create({
    email,
    passwordHash: await hashPassword(OLD_PASSWORD),
    mustChangePassword: true,
    employeeId: new Types.ObjectId(),
  });
  const stored = await UserModel.findById(user._id).select('+passwordHash').lean().orFail();
  return { id: user._id, hash: stored.passwordHash };
}

async function entriesFor(userId: Types.ObjectId) {
  return AuditLogModel.collection.find({ 'record.id': userId }).toArray();
}

beforeAll(async () => {
  await connectDb();
});

afterEach(async () => {
  // Remove the validator the failure test installs.
  await database().command({ collMod: 'auditLogs', validator: {} });
});

describe('changePassword', () => {
  it('writes exactly one passwordChange entry, without the password or a hash', async () => {
    const user = await createUser('change.one@xtreme-works.com');
    await changePassword(user.id.toHexString(), {
      currentPassword: OLD_PASSWORD,
      newPassword: NEW_PASSWORD,
      confirm: NEW_PASSWORD,
    });

    const stored = await UserModel.findById(user.id).select('+passwordHash').lean().orFail();
    expect(await verifyPassword(stored.passwordHash, NEW_PASSWORD)).toBe(true);
    expect(stored.mustChangePassword).toBe(false);

    const entries = await entriesFor(user.id);
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry).toMatchObject({
      action: 'passwordChange',
      module: 'core',
      record: { type: 'core.user', id: user.id, label: 'change.one@xtreme-works.com' },
    });
    expect(entry?.actorId).toEqual(user.id);
    expect(entry?.before).toMatchObject({ mustChangePassword: true });
    expect(entry?.after).toMatchObject({ mustChangePassword: false });
    expect(entry?.before).not.toHaveProperty('passwordHash');
    expect(entry?.after).not.toHaveProperty('passwordHash');

    const serialized = mongo.BSON.EJSON.stringify(entries, { relaxed: false });
    for (const secret of [OLD_PASSWORD, NEW_PASSWORD, user.hash, stored.passwordHash]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain('$argon2');
  });

  it('leaves the password unchanged when the audit entry can’t be written', async () => {
    const user = await createUser('change.two@xtreme-works.com');
    // Make every audit insert fail at the database.
    await database().command({
      collMod: 'auditLogs',
      validator: { $jsonSchema: { required: ['aFieldNoEntryHas'] } },
      validationLevel: 'strict',
      validationAction: 'error',
    });

    let error: unknown;
    try {
      await changePassword(user.id.toHexString(), {
        currentPassword: OLD_PASSWORD,
        newPassword: NEW_PASSWORD,
        confirm: NEW_PASSWORD,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).not.toContain(NEW_PASSWORD);

    const stored = await UserModel.findById(user.id).select('+passwordHash').lean().orFail();
    expect(stored.passwordHash).toBe(user.hash);
    expect(stored.mustChangePassword).toBe(true);
    expect(await verifyPassword(stored.passwordHash, OLD_PASSWORD)).toBe(true);
    expect(await entriesFor(user.id)).toHaveLength(0);
  });
});
