import { beforeAll, describe, expect, it } from 'vitest';
import { mongo, Schema, Types } from 'mongoose';
import { connectDb, defineModel } from '@pulse/db';
import { type EncryptedValue, encryptSensitive, sensitiveField } from '../encryption/fields';
import { bytesOf } from '../encryption/format';
import { AuditLogModel } from './model';
import { listAuditEntries, recordAudit } from './service';
import {
  HIDDEN_REDACTED,
  HIDDEN_SENSITIVE,
  HIDDEN_SENSITIVE_CHANGED,
  redactForAudit,
  SNAPSHOT_ARRAY_MAX,
  SNAPSHOT_STRING_MAX,
  snapshotForAudit,
  snapshotsForAudit,
} from './snapshot';

// The append-only audit log and its snapshot redaction (docs/modules/core.md#audit-log,
// SECURITY.md#audit-logging, docs/TESTING.md#audit-notification-and-reveal-tests). Made-up data.

const PLAIN = 'MADE-UP-ACCOUNT-0042-9999';
const SECRET = 'made-up-secret-value';

let enc: EncryptedValue;

beforeAll(async () => {
  await connectDb();
  enc = await encryptSensitive(PLAIN);
});

const baseEntry = () => ({
  actorId: new Types.ObjectId(),
  actorEmail: 'actor@xtreme-works.com',
  module: 'core' as const,
  action: 'update' as const,
  record: { type: 'core.thing', id: new Types.ObjectId(), label: 'Thing' },
  before: { name: 'Old' },
  after: { name: 'New' },
});

async function rawEntries(): Promise<string> {
  const docs = await AuditLogModel.collection.find({}).sort({ _id: 1 }).toArray();
  return mongo.BSON.EJSON.stringify(docs, { relaxed: false });
}

async function caught(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('append-only', () => {
  it('inserts an entry', async () => {
    const { id } = await recordAudit(baseEntry());
    const stored = await AuditLogModel.findById(id).lean();
    expect(stored?.action).toBe('update');
    expect(stored?.before).toEqual({ name: 'Old' });
    expect(stored?.after).toEqual({ name: 'New' });
    expect(stored?.fields).toEqual([]);
    expect(stored?.reason).toBeNull();
  });

  it('refuses an invalid entry without writing it', async () => {
    const before = await rawEntries();
    for (const bad of [
      { ...baseEntry(), module: 'payroll' },
      { ...baseEntry(), action: 'edit' },
      { ...baseEntry(), record: { type: 'not a type', id: null } },
      { ...baseEntry(), reason: 'x'.repeat(1001) },
      { ...baseEntry(), actorId: 'not-an-id' },
    ]) {
      const error = await caught(() => recordAudit(bad as never));
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe('AuditEntryInvalidError');
    }
    expect(await rawEntries()).toBe(before);
  });

  const refusals: [string, () => Promise<unknown>][] = [
    ['updateOne', () => AuditLogModel.updateOne({}, { $set: { reason: 'changed' } })],
    ['updateMany', () => AuditLogModel.updateMany({}, { $set: { reason: 'changed' } })],
    ['findOneAndUpdate', () => AuditLogModel.findOneAndUpdate({}, { $set: { reason: 'changed' } })],
    [
      'replaceOne',
      () =>
        AuditLogModel.replaceOne({}, { module: 'core', action: 'create', record: { type: 'a.b' } }),
    ],
    ['findOneAndReplace', () => AuditLogModel.findOneAndReplace({}, { module: 'core' })],
    ['deleteOne', () => AuditLogModel.deleteOne({})],
    ['deleteMany', () => AuditLogModel.deleteMany({})],
    ['findOneAndDelete', () => AuditLogModel.findOneAndDelete({})],
    [
      'bulkWrite with an update',
      () =>
        AuditLogModel.bulkWrite([
          { updateOne: { filter: {}, update: { $set: { reason: 'changed' } } } },
        ]),
    ],
    ['bulkWrite with a delete', () => AuditLogModel.bulkWrite([{ deleteOne: { filter: {} } }])],
    [
      'save on a loaded entry',
      async () => {
        const entry = await AuditLogModel.findOne({}).orFail();
        entry.set('reason', 'changed');
        await entry.save();
      },
    ],
    [
      'deleteOne on a loaded entry',
      async () => {
        const entry = await AuditLogModel.findOne({}).orFail();
        await entry.deleteOne();
      },
    ],
    ['$out', () => AuditLogModel.aggregate([{ $match: {} }, { $out: 'auditLogs' }]).exec()],
    [
      '$merge',
      () =>
        AuditLogModel.aggregate([
          { $set: { reason: 'changed' } },
          { $merge: { into: 'auditLogs', whenMatched: 'replace' } },
        ]).exec(),
    ],
  ];

  for (const [name, write] of refusals) {
    it(`refuses ${name} and changes nothing`, async () => {
      await recordAudit(baseEntry());
      const before = await rawEntries();
      const error = await caught(write);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/never changed or deleted/);
      expect(await rawEntries()).toBe(before);
    });
  }

  it('lets bulkWrite insert', async () => {
    const count = await AuditLogModel.countDocuments();
    await AuditLogModel.bulkWrite([
      {
        insertOne: {
          document: { module: 'core', action: 'create', record: { type: 'core.thing', id: null } },
        },
      },
    ]);
    expect(await AuditLogModel.countDocuments()).toBe(count + 1);
  });
});

describe('snapshot redaction', () => {
  const accountSchema = new Schema({ bank: String, number: sensitiveField() });
  const recordSchema = new Schema({
    name: String,
    passwordHash: { type: String, select: false },
    internalNote: { type: String, select: false },
    tin: sensitiveField(),
    profile: { taxId: sensitiveField(), city: String },
    payroll: new Schema({ salary: sensitiveField(), grade: String }),
    accounts: [accountSchema],
    ownerId: Schema.Types.ObjectId,
    hiredAt: Date,
    extra: Schema.Types.Mixed,
  });
  const Thing = defineModel('AuditSnapshotThing', recordSchema, 'auditSnapshotThings');

  it('hides sensitive paths at every depth and leaves out select: false fields', async () => {
    const ownerId = new Types.ObjectId();
    const created = await Thing.create({
      name: 'Juan',
      passwordHash: 'argon2-made-up-hash',
      internalNote: 'select false note',
      tin: enc,
      profile: { taxId: enc, city: 'Makati' },
      payroll: { salary: enc, grade: 'A' },
      accounts: [
        { bank: 'BDO', number: enc },
        { bank: 'BPI', number: enc },
      ],
      ownerId,
      hiredAt: new Date('2026-01-05T00:00:00.000Z'),
    });
    const loaded = await Thing.findById(created._id)
      .select('+passwordHash +internalNote +tin +profile.taxId +payroll.salary +accounts.number')
      .orFail();
    const snapshot = snapshotForAudit(Thing, loaded);

    expect(snapshot).not.toHaveProperty('passwordHash');
    expect(snapshot).not.toHaveProperty('internalNote');
    expect(snapshot).not.toHaveProperty('__v');
    expect(snapshot?.tin).toEqual(HIDDEN_SENSITIVE);
    expect(snapshot?.profile).toEqual({ taxId: HIDDEN_SENSITIVE, city: 'Makati' });
    expect(snapshot?.payroll).toEqual(
      expect.objectContaining({ salary: HIDDEN_SENSITIVE, grade: 'A' }),
    );
    expect(snapshot?.accounts).toEqual([
      expect.objectContaining({ bank: 'BDO', number: HIDDEN_SENSITIVE }),
      expect.objectContaining({ bank: 'BPI', number: HIDDEN_SENSITIVE }),
    ]);
    expect(snapshot?.ownerId).toBe(ownerId.toHexString());
    expect(snapshot?.hiredAt).toBe('2026-01-05T00:00:00.000Z');
    expect(snapshot?._id).toBe(created._id.toHexString());

    // Also on a lean read.
    const lean = await Thing.findById(created._id).select('+passwordHash +tin').lean();
    const leanSnapshot = snapshotForAudit(Thing, lean);
    expect(leanSnapshot).not.toHaveProperty('passwordHash');
    expect(leanSnapshot?.tin).toEqual(HIDDEN_SENSITIVE);

    // Stored, the entry has none of it.
    await recordAudit({ ...baseEntry(), before: null, after: snapshot });
    const raw = await rawEntries();
    expect(raw).not.toContain('argon2-made-up-hash');
    expect(raw).not.toContain('select false note');
    expect(raw).not.toContain(PLAIN);
    expect(raw).not.toContain('"$binary"');
  });

  it('redacts password-like keys, encrypted values and bytes anywhere, without a schema', () => {
    const snapshot = redactForAudit({
      name: 'ok',
      password: SECRET,
      newPassword: SECRET,
      pass: SECRET,
      resetToken: SECRET,
      clientSecret: SECRET,
      apiKey: SECRET,
      otp: SECRET,
      hash: SECRET,
      mustChangePassword: false,
      tokenExpiresAt: null,
      nested: { deeper: [{ sessionToken: SECRET, keep: 1 }] },
      cipher: enc,
      buffer: Buffer.from(SECRET),
      binary: new mongo.Binary(Buffer.from(SECRET)),
      bytes: new Uint8Array([1, 2, 3]),
      list: [enc, Buffer.from(SECRET)],
      when: new Date('2026-02-01T00:00:00.000Z'),
      id: new Types.ObjectId('64b7f0c2a1b2c3d4e5f60718'),
    });
    expect(JSON.stringify(snapshot)).not.toContain(SECRET);
    expect(snapshot).toMatchObject({
      name: 'ok',
      password: HIDDEN_REDACTED,
      newPassword: HIDDEN_REDACTED,
      pass: HIDDEN_REDACTED,
      resetToken: HIDDEN_REDACTED,
      clientSecret: HIDDEN_REDACTED,
      apiKey: HIDDEN_REDACTED,
      otp: HIDDEN_REDACTED,
      hash: HIDDEN_REDACTED,
      // A boolean or null can't hold a secret, so it is kept.
      mustChangePassword: false,
      tokenExpiresAt: null,
      nested: { deeper: [{ sessionToken: HIDDEN_REDACTED, keep: 1 }] },
      cipher: HIDDEN_REDACTED,
      buffer: HIDDEN_REDACTED,
      binary: HIDDEN_REDACTED,
      bytes: HIDDEN_REDACTED,
      list: [HIDDEN_REDACTED, HIDDEN_REDACTED],
      when: '2026-02-01T00:00:00.000Z',
      id: '64b7f0c2a1b2c3d4e5f60718',
    });
  });

  it('caps sizes with markers, and redacting again changes nothing', () => {
    const snapshot = redactForAudit({
      long: 'a'.repeat(SNAPSHOT_STRING_MAX * 2),
      items: Array.from({ length: SNAPSHOT_ARRAY_MAX + 50 }, (_, index) => index),
    });
    const long = snapshot?.long as string;
    expect(long.length).toBeLessThanOrEqual(SNAPSHOT_STRING_MAX);
    expect(long.endsWith('[truncated]')).toBe(true);
    const items = snapshot?.items as unknown[];
    expect(items).toHaveLength(SNAPSHOT_ARRAY_MAX);
    expect(items.at(-1)).toEqual({ $truncated: 'items', omitted: 51 });
    expect(redactForAudit(snapshot)).toEqual(snapshot);

    const huge = redactForAudit({
      parts: Array.from({ length: 90 }, () => 'b'.repeat(1000)),
    });
    expect(huge).toEqual({ $truncated: 'snapshot', bytes: expect.any(Number) });
  });

  describe('changed sensitive fields (snapshotsForAudit)', () => {
    const PLAIN_NEW = 'MADE-UP-ACCOUNT-7777-1234';
    const allSensitive = '+tin +profile.taxId +payroll.salary +accounts.number';

    async function createThing() {
      return Thing.create({
        name: 'Maria',
        tin: enc,
        profile: { taxId: enc, city: 'Pasig' },
        payroll: { salary: enc, grade: 'B' },
        accounts: [
          { bank: 'BDO', number: enc },
          { bank: 'BPI', number: enc },
        ],
      });
    }

    it('marks a changed sensitive field, and only that one', async () => {
      const encNew = await encryptSensitive(PLAIN_NEW);
      const created = await createThing();
      const loaded = await Thing.findById(created._id).select(allSensitive).orFail();
      const original = loaded.toObject();
      loaded.set('tin', encNew);
      loaded.set('accounts.1.number', encNew);
      loaded.set('name', 'Maria C.');
      await loaded.save();

      const { before, after } = snapshotsForAudit(Thing, original, loaded);
      // The before side is never marked.
      expect(before?.tin).toEqual(HIDDEN_SENSITIVE);
      expect(before?.accounts).toEqual([
        expect.objectContaining({ number: HIDDEN_SENSITIVE }),
        expect.objectContaining({ number: HIDDEN_SENSITIVE }),
      ]);
      // Changed: marked. Unchanged: plain hidden marker.
      expect(after?.tin).toEqual(HIDDEN_SENSITIVE_CHANGED);
      expect(after?.accounts).toEqual([
        expect.objectContaining({ bank: 'BDO', number: HIDDEN_SENSITIVE }),
        expect.objectContaining({ bank: 'BPI', number: HIDDEN_SENSITIVE_CHANGED }),
      ]);
      expect(after?.profile).toEqual({ taxId: HIDDEN_SENSITIVE, city: 'Pasig' });
      expect(after?.payroll).toEqual(
        expect.objectContaining({ salary: HIDDEN_SENSITIVE, grade: 'B' }),
      );
      expect(after?.name).toBe('Maria C.');
    });

    it('does not mark unchanged sensitive fields, on lean reads too', async () => {
      const created = await createThing();
      const original = await Thing.findById(created._id).select(allSensitive).lean();
      await Thing.updateOne({ _id: created._id }, { $set: { name: 'Maria D.' } });
      const reloaded = await Thing.findById(created._id).select(allSensitive).lean();

      const { after } = snapshotsForAudit(Thing, original, reloaded);
      expect(after?.tin).toEqual(HIDDEN_SENSITIVE);
      expect(after?.profile).toEqual({ taxId: HIDDEN_SENSITIVE, city: 'Pasig' });
      expect(after?.accounts).toEqual([
        expect.objectContaining({ number: HIDDEN_SENSITIVE }),
        expect.objectContaining({ number: HIDDEN_SENSITIVE }),
      ]);
      expect(JSON.stringify(after)).not.toContain('changed');
    });

    it('marks a sensitive field that is new, and one written again with the same value', async () => {
      const created = await Thing.create({ name: 'Ana' });
      const original = await Thing.findById(created._id).select(allSensitive).lean();
      // Encryption is randomized: the same plain value stores different bytes.
      const again = await encryptSensitive(PLAIN);
      await Thing.updateOne({ _id: created._id }, { $set: { tin: enc, 'profile.taxId': again } });
      const reloaded = await Thing.findById(created._id).select(allSensitive).lean();

      const { before, after } = snapshotsForAudit(Thing, original, reloaded);
      expect(before).not.toHaveProperty('tin');
      expect(after?.tin).toEqual(HIDDEN_SENSITIVE_CHANGED);
      expect((after?.profile as Record<string, unknown>).taxId).toEqual(HIDDEN_SENSITIVE_CHANGED);
    });

    it('never marks anything without a before, or in a single snapshot', async () => {
      const created = await createThing();
      const loaded = await Thing.findById(created._id).select(allSensitive).orFail();
      const { before, after } = snapshotsForAudit(Thing, null, loaded);
      expect(before).toBeNull();
      expect(after?.tin).toEqual(HIDDEN_SENSITIVE);
      expect(JSON.stringify(snapshotForAudit(Thing, loaded))).not.toContain('changed');
    });

    it('stores neither the ciphertext nor the plain value', async () => {
      const encNew = await encryptSensitive(PLAIN_NEW);
      const created = await createThing();
      const original = await Thing.findById(created._id).select(allSensitive).lean();
      await Thing.updateOne({ _id: created._id }, { $set: { tin: encNew } });
      const reloaded = await Thing.findById(created._id).select(allSensitive).lean();
      const snapshots = snapshotsForAudit(Thing, original, reloaded);

      const ciphertexts = [enc, encNew].flatMap((value) => {
        const bytes = bytesOf(value);
        if (!bytes) throw new Error('Expected encrypted bytes.');
        return [bytes.toString('base64'), bytes.toString('hex'), bytes.toString('latin1')];
      });
      const inMemory = JSON.stringify(snapshots);
      for (const text of [PLAIN, PLAIN_NEW, ...ciphertexts]) {
        expect(inMemory).not.toContain(text);
      }

      const { id } = await recordAudit({ ...baseEntry(), ...snapshots });
      const stored = await AuditLogModel.findById(id).lean();
      // The backstop in recordAudit keeps the marker as it is.
      expect(stored?.after?.tin).toEqual(HIDDEN_SENSITIVE_CHANGED);
      expect(stored?.after).toEqual(snapshots.after);
      const raw = await rawEntries();
      for (const text of [PLAIN, PLAIN_NEW, ...ciphertexts]) expect(raw).not.toContain(text);
      expect(raw).not.toContain('"$binary"');
    });
  });

  it('runs the backstop in recordAudit on raw before/after values', async () => {
    const { id } = await recordAudit({
      ...baseEntry(),
      before: { password: SECRET, value: enc },
      after: { apiKey: SECRET, data: Buffer.from(SECRET) },
    });
    const stored = await AuditLogModel.findById(id).lean();
    expect(stored?.before).toEqual({ password: HIDDEN_REDACTED, value: HIDDEN_REDACTED });
    expect(stored?.after).toEqual({ apiKey: HIDDEN_REDACTED, data: HIDDEN_REDACTED });
    expect(await rawEntries()).not.toContain(SECRET);
  });
});

describe('listing', () => {
  it('pages newest first with filters', async () => {
    const recordId = new Types.ObjectId();
    for (let index = 0; index < 5; index += 1) {
      await recordAudit({
        ...baseEntry(),
        module: 'talent',
        action: 'reveal',
        record: { type: 'talent.listTest', id: recordId },
        before: null,
        after: null,
        fields: [`field${index}`],
      });
    }
    const first = await listAuditEntries(
      { module: 'talent', recordType: 'talent.listTest' },
      { limit: 2 },
    );
    expect(first.entries).toHaveLength(2);
    expect(first.entries[0]?.fields).toEqual(['field4']);
    expect(first.nextCursor).not.toBeNull();
    const second = await listAuditEntries(
      { module: 'talent', recordType: 'talent.listTest' },
      { limit: 2, cursor: first.nextCursor },
    );
    expect(second.entries.map((entry) => entry.fields[0])).toEqual(['field2', 'field1']);
    const third = await listAuditEntries(
      { recordId: recordId.toHexString() },
      { limit: 2, cursor: second.nextCursor },
    );
    expect(third.entries.map((entry) => entry.fields[0])).toEqual(['field0']);
    expect(third.nextCursor).toBeNull();

    const none = await listAuditEntries({ module: 'talent', from: '2000-01-01', to: '2000-01-02' });
    expect(none.entries).toHaveLength(0);
  });

  it('refuses a cursor it didn’t make', async () => {
    const error = await caught(() => listAuditEntries({}, { cursor: 'garbage' }));
    expect((error as Error).name).toBe('ActionError');
  });
});
