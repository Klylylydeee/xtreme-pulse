import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose, { mongo, Schema, Types } from 'mongoose';
import { connectDb, defineModel } from '@pulse/db';
import { AccessDeniedError } from '../../actions';
import { lastFourOf } from '../../sensitive';
import { AuditLogModel } from '../audit/model';
import type { DepartmentRole } from '../auth/roles';
import {
  DEV_SAMPLE_FIELD,
  DEV_SAMPLE_OWNER_TYPE,
  DEV_SAMPLE_PLAINTEXT,
  loadDevEncryptionSample,
} from '../encryption/dev-sample';
import { encryptSensitive, sensitiveField } from '../encryption/fields';
import { revealSensitive } from '../encryption/reveal';
import { canRevealSensitive, type RevealActor } from './policy';
import {
  registerSensitiveReveal,
  SENSITIVE_CATEGORIES,
  type SensitiveCategory,
  type SensitiveSubject,
} from './registry';
import { revealSensitiveField } from './service';

// Revealing sensitive values (SECURITY.md#sensitive-data,
// docs/TESTING.md#audit-notification-and-reveal-tests). Made-up data only.

// The salary ends in upper-case letters, so its last four ("QXZJ") can't turn up by chance in the
// raw audit JSON: timestamps and numbers are digits, and ObjectIds are lower-case hex.
const SALARY = 'MADE-UP-SALARY-4455667788-QXZJ';
const BANK = 'MADE-UP-BANK-1122334455';
const OWNER_TYPE = 'talent.revealTest';

interface TestRecord {
  employeeId: Types.ObjectId;
  departmentCode: string;
  salary: Buffer;
  bankAccount: Buffer;
  notes: string;
}

const TestModel = defineModel(
  'RevealTestRecord',
  new Schema<TestRecord>({
    employeeId: { type: Schema.Types.ObjectId, required: true },
    departmentCode: { type: String, required: true },
    salary: sensitiveField(),
    bankAccount: sensitiveField(),
    notes: String,
  }),
  'revealTestRecords',
);

registerSensitiveReveal(OWNER_TYPE, {
  module: 'talent',
  fields: { salary: 'salary', bankAccount: 'bankAccount' },
  async loadValue(ownerId, field) {
    const doc = await TestModel.findById(ownerId).select(`+${field}`).lean();
    const value = doc?.[field as 'salary' | 'bankAccount'];
    return value ?? null;
  },
  async subject(ownerId) {
    const doc = await TestModel.findById(ownerId).lean();
    return doc
      ? { employeeId: doc.employeeId.toHexString(), departmentCode: doc.departmentCode }
      : null;
  },
});

function actor(
  roles: DepartmentRole[],
  { admin = false, employeeId = new Types.ObjectId().toHexString() } = {},
): RevealActor {
  return {
    id: new Types.ObjectId().toHexString(),
    email: 'actor@xtreme-works.com',
    isSystemAdministrator: admin,
    roles,
    employee: { id: employeeId },
  };
}

function database(): mongo.Db {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Not connected.');
  return db;
}

async function rawAudit(): Promise<string> {
  const docs = await AuditLogModel.collection.find({}).toArray();
  return mongo.BSON.EJSON.stringify(docs, { relaxed: false });
}

async function createRecord(departmentCode: string) {
  const employeeId = new Types.ObjectId();
  const doc = await TestModel.create({
    employeeId,
    departmentCode,
    salary: await encryptSensitive(SALARY),
    bankAccount: await encryptSensitive(BANK),
    notes: 'plain',
  });
  return { id: doc._id.toHexString(), employeeId: employeeId.toHexString() };
}

beforeAll(async () => {
  await connectDb();
});

afterEach(async () => {
  await database().command({ collMod: 'auditLogs', validator: {} });
});

describe('canRevealSensitive (role × subject matrix)', () => {
  const ownId = new Types.ObjectId().toHexString();
  const hrSubject: SensitiveSubject = { employeeId: ownId, departmentCode: 'HR' };
  const otherHrSubject: SensitiveSubject = {
    employeeId: new Types.ObjectId().toHexString(),
    departmentCode: 'HR',
  };
  const salesSubject: SensitiveSubject = {
    employeeId: new Types.ObjectId().toHexString(),
    departmentCode: 'SALES',
  };
  const boardHrCategories = new Set<SensitiveCategory>([
    'salary',
    'allowances',
    'governmentId',
    'bankAccount',
  ]);

  const cases: {
    name: string;
    who: RevealActor;
    expected: (c: SensitiveCategory, s: SensitiveSubject | null) => boolean;
  }[] = [
    { name: 'System Administrator', who: actor([], { admin: true }), expected: () => true },
    { name: 'HR', who: actor(['hr']), expected: () => true },
    { name: 'Accounting', who: actor(['accounting']), expected: () => true },
    {
      name: 'Board',
      who: actor(['board']),
      expected: (category, subject) =>
        subject?.departmentCode === 'HR' && boardHrCategories.has(category),
    },
    {
      name: 'the employee themself',
      who: actor([], { employeeId: ownId }),
      expected: (_category, subject) => subject?.employeeId === ownId,
    },
    { name: 'another employee', who: actor([]), expected: () => false },
    {
      name: 'a user with no employee',
      who: { ...actor([]), employee: null },
      expected: () => false,
    },
  ];

  for (const { name, who, expected } of cases) {
    it(`follows the rules for ${name}`, () => {
      for (const category of SENSITIVE_CATEGORIES) {
        for (const subject of [hrSubject, otherHrSubject, salesSubject, null]) {
          expect(
            canRevealSensitive(who, category, subject),
            `${name} / ${category} / ${subject?.departmentCode ?? 'no subject'}`,
          ).toBe(expected(category, subject));
        }
      }
    });
  }
});

describe('revealSensitiveField', () => {
  it('returns the value to HR and logs the field, never the value or its last 4', async () => {
    const record = await createRecord('SALES');
    const hr = actor(['hr']);
    const value = await revealSensitiveField({
      actor: hr,
      ownerType: OWNER_TYPE,
      ownerId: record.id,
      field: 'salary',
    });
    expect(value).toBe(SALARY);

    const entries = await AuditLogModel.find({ 'record.id': record.id }).lean();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'reveal',
      module: 'talent',
      fields: ['salary'],
      before: null,
      after: null,
      actorEmail: hr.email,
      record: { type: OWNER_TYPE },
    });
    const raw = await rawAudit();
    expect(raw).not.toContain(SALARY);
    expect(raw).not.toContain(lastFourOf(SALARY));
    expect(raw).not.toContain(BANK);
  });

  it('lets an employee reveal their own record only', async () => {
    const record = await createRecord('SALES');
    const self = actor([], { employeeId: record.employeeId });
    await expect(
      revealSensitiveField({
        actor: self,
        ownerType: OWNER_TYPE,
        ownerId: record.id,
        field: 'bankAccount',
      }),
    ).resolves.toBe(BANK);
    const before = await rawAudit();
    await expect(
      revealSensitiveField({
        actor: actor([]),
        ownerType: OWNER_TYPE,
        ownerId: record.id,
        field: 'bankAccount',
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    expect(await rawAudit()).toBe(before);
  });

  it('lets the Board reveal HR-department pay only', async () => {
    const hrRecord = await createRecord('HR');
    const salesRecord = await createRecord('SALES');
    const board = actor(['board']);
    await expect(
      revealSensitiveField({
        actor: board,
        ownerType: OWNER_TYPE,
        ownerId: hrRecord.id,
        field: 'salary',
      }),
    ).resolves.toBe(SALARY);
    await expect(
      revealSensitiveField({
        actor: board,
        ownerType: OWNER_TYPE,
        ownerId: salesRecord.id,
        field: 'salary',
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it('refuses unregistered record types and fields, and bad ids, without logging', async () => {
    const record = await createRecord('SALES');
    const admin = actor([], { admin: true });
    const before = await rawAudit();
    for (const input of [
      { ownerType: 'talent.unknownThing', ownerId: record.id, field: 'salary' },
      { ownerType: OWNER_TYPE, ownerId: record.id, field: 'notes' },
      { ownerType: OWNER_TYPE, ownerId: record.id, field: 'employeeId' },
      { ownerType: OWNER_TYPE, ownerId: record.id, field: 'constructor' },
      { ownerType: OWNER_TYPE, ownerId: 'not-an-id', field: 'salary' },
    ]) {
      await expect(revealSensitiveField({ actor: admin, ...input })).rejects.toBeInstanceOf(
        AccessDeniedError,
      );
    }
    expect(await rawAudit()).toBe(before);
  });

  it('returns nothing when the audit entry can’t be written', async () => {
    const record = await createRecord('SALES');
    await database().command({
      collMod: 'auditLogs',
      validator: { $jsonSchema: { required: ['aFieldNoEntryHas'] } },
      validationLevel: 'strict',
      validationAction: 'error',
    });
    let result: unknown = 'not set';
    let error: unknown;
    try {
      result = await revealSensitiveField({
        actor: actor(['accounting']),
        ownerType: OWNER_TYPE,
        ownerId: record.id,
        field: 'salary',
      });
    } catch (caught) {
      error = caught;
    }
    expect(result).toBe('not set');
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).not.toContain(SALARY);
    expect(await AuditLogModel.countDocuments({ 'record.id': record.id })).toBe(0);
  });
});

describe('the development sample', () => {
  it('is revealed through the same checks: System Administrator yes, an employee no', async () => {
    const sample = await loadDevEncryptionSample();
    const owner = { type: DEV_SAMPLE_OWNER_TYPE, id: sample.id };
    await expect(
      revealSensitive({ actor: actor([], { admin: true }), owner, field: DEV_SAMPLE_FIELD }),
    ).resolves.toBe(DEV_SAMPLE_PLAINTEXT);
    await expect(
      revealSensitive({ actor: actor([]), owner, field: DEV_SAMPLE_FIELD }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    const entries = await AuditLogModel.find({ 'record.type': DEV_SAMPLE_OWNER_TYPE }).lean();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.fields).toEqual([DEV_SAMPLE_FIELD]);
  });
});
