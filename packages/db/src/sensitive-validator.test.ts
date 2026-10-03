import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose, { type Connection, type Model, mongo, Schema } from 'mongoose';
import { connectDb } from './connection';
import { defineModel } from './define-model';
import {
  buildSensitiveValidator,
  ensureSensitiveValidator,
  SENSITIVE_OPTION,
} from './sensitive-validator';

// The `$jsonSchema` backstop for sensitive fields (ADR 0012, docs/TESTING.md). This package can't
// import core, so the fields are marked with the raw option and the values are made-up subtype 6
// binaries: the validator only checks the type, never the content.

const sensitive = () => ({ [SENSITIVE_OPTION]: true, type: Buffer });
const ENCRYPTED = { encrypt: {} };
const fakeEncrypted = () => new mongo.Binary(Buffer.alloc(82, 2), 6);
const PLAIN = 'plain-test-value';

function fullSchema(): Schema {
  return new Schema({
    name: String,
    a: sensitive(),
    n: { b: sensitive(), other: String, deeper: { c: sensitive() } },
    s: new Schema({ c: sensitive(), label: String }),
    arr: [new Schema({ d: sensitive(), inner: [new Schema({ e: sensitive() })] })],
    plainList: [String],
    tags: { type: Map, of: String },
  });
}

async function validatorOf(collection: string): Promise<unknown> {
  const db = mongoose.connection.db;
  if (!db) throw new Error('no db');
  const [info] = await db.listCollections({ name: collection }).toArray();
  return (info as { options?: { validator?: unknown } } | undefined)?.options?.validator;
}

async function rawInsertCode(model: Model<unknown>, doc: object): Promise<unknown> {
  try {
    await model.collection.insertOne(doc);
    return 'written';
  } catch (error) {
    return (error as { code?: unknown }).code;
  }
}

describe('buildSensitiveValidator', () => {
  it('builds the rule for top-level, nested, subdocument and document-array paths', () => {
    expect(buildSensitiveValidator(fullSchema())).toEqual({
      $jsonSchema: {
        bsonType: 'object',
        properties: {
          a: ENCRYPTED,
          n: {
            bsonType: ['object', 'null'],
            properties: {
              b: ENCRYPTED,
              deeper: { bsonType: ['object', 'null'], properties: { c: ENCRYPTED } },
            },
          },
          s: { bsonType: ['object', 'null'], properties: { c: ENCRYPTED } },
          arr: {
            bsonType: ['array', 'null'],
            items: {
              bsonType: 'object',
              properties: {
                d: ENCRYPTED,
                inner: {
                  bsonType: ['array', 'null'],
                  items: { bsonType: 'object', properties: { e: ENCRYPTED } },
                },
              },
            },
          },
        },
      },
    });
  });

  it('lists no sensitive path as required', () => {
    expect(JSON.stringify(buildSensitiveValidator(fullSchema()))).not.toContain('required');
  });

  it('returns null for a schema without sensitive paths', () => {
    const schema = new Schema({
      name: String,
      nested: { x: Number },
      sub: new Schema({ y: String }),
      list: [new Schema({ z: Buffer })],
    });
    expect(buildSensitiveValidator(schema)).toBeNull();
  });

  it('skips Map paths (the core guard refuses a sensitive Map when the model is defined)', () => {
    const schema = new Schema({ m: { type: Map, of: new Schema({ v: sensitive() }) } });
    expect(buildSensitiveValidator(schema)).toBeNull();
  });
});

describe('ensureSensitiveValidator', () => {
  let monitored: Connection;
  const commands: string[] = [];

  beforeAll(async () => {
    await connectDb();
    const uri = process.env.MONGODB_URI as string;
    monitored = await mongoose.createConnection(uri, { monitorCommands: true }).asPromise();
    monitored.getClient().on('commandStarted', (event) => commands.push(event.commandName));
  });

  afterAll(async () => {
    await monitored.close();
  });

  it('installs the validator on a fresh database through connectDb', async () => {
    const Fresh = defineModel('ValidatorFresh', fullSchema(), 'validatorFresh');
    await connectDb();
    expect(await validatorOf('validatorFresh')).toEqual(buildSensitiveValidator(fullSchema()));
    const db = mongoose.connection.db;
    const [info] = (await db?.listCollections({ name: 'validatorFresh' }).toArray()) ?? [];
    const options = (info as { options?: Record<string, unknown> }).options ?? {};
    expect(options.validationLevel ?? 'strict').toBe('strict');
    expect(options.validationAction ?? 'error').toBe('error');
    expect(await rawInsertCode(Fresh as unknown as Model<unknown>, { a: PLAIN })).toBe(121);
    expect(await rawInsertCode(Fresh as unknown as Model<unknown>, { a: fakeEncrypted() })).toBe(
      'written',
    );
  });

  it('adds the validator to an existing collection that has none, with collMod', async () => {
    const db = mongoose.connection.db;
    await db?.createCollection('validatorExisting');
    await db?.collection('validatorExisting').insertOne({ name: 'before' });
    expect(await validatorOf('validatorExisting')).toBeUndefined();
    const model = monitored.model('ValidatorExisting', fullSchema(), 'validatorExisting');
    await model.init();
    commands.length = 0;
    await ensureSensitiveValidator(model as unknown as Model<unknown>);
    expect(commands.filter((name) => name === 'collMod')).toHaveLength(1);
    expect(await validatorOf('validatorExisting')).toEqual(buildSensitiveValidator(fullSchema()));
  });

  it('runs no collMod when the validator is already installed', async () => {
    const model = monitored.model('ValidatorTwice', fullSchema(), 'validatorTwice');
    await model.init();
    await ensureSensitiveValidator(model as unknown as Model<unknown>);
    commands.length = 0;
    await ensureSensitiveValidator(model as unknown as Model<unknown>);
    expect(commands).toContain('listCollections');
    expect(commands.filter((name) => name === 'collMod' || name === 'create')).toHaveLength(0);
  });

  it('updates the validator when the schema changes', async () => {
    const first = monitored.model(
      'ValidatorChange',
      new Schema({ a: sensitive() }),
      'validatorChange',
    );
    await first.init();
    await ensureSensitiveValidator(first as unknown as Model<unknown>);
    monitored.deleteModel('ValidatorChange');
    const changed = new Schema({ a: sensitive(), b: sensitive() });
    const second = monitored.model('ValidatorChange', changed, 'validatorChange');
    commands.length = 0;
    await ensureSensitiveValidator(second as unknown as Model<unknown>);
    expect(commands.filter((name) => name === 'collMod')).toHaveLength(1);
    expect(await validatorOf('validatorChange')).toEqual(buildSensitiveValidator(changed));
    expect(await rawInsertCode(second as unknown as Model<unknown>, { b: PLAIN })).toBe(121);
  });

  it('creates a missing collection with the validator', async () => {
    const model = monitored.model(
      'ValidatorMissing',
      new Schema({ a: sensitive() }, { autoCreate: false, autoIndex: false }),
      'validatorMissing',
    );
    commands.length = 0;
    await ensureSensitiveValidator(model as unknown as Model<unknown>);
    expect(commands).toContain('create');
    expect(await validatorOf('validatorMissing')).toEqual(
      buildSensitiveValidator(new Schema({ a: sensitive() })),
    );
  });

  it('updates the collection when another process creates it first (NamespaceExists, code 48)', async () => {
    const schema = new Schema({ a: sensitive() }, { autoCreate: false, autoIndex: false });
    const model = monitored.model('ValidatorRace', schema, 'validatorRace');
    const db = model.db.db as mongo.Db;
    const original = db.listCollections.bind(db);
    let first = true;
    // The first lookup finds nothing, and the collection is created (without a validator) before
    // createCollection runs, as when another process wins the race.
    const stub = ((...args: Parameters<mongo.Db['listCollections']>) => {
      if (!first) return original(...args);
      first = false;
      return {
        toArray: async () => {
          await db.createCollection('validatorRace');
          return [];
        },
      };
    }) as unknown as mongo.Db['listCollections'];
    Object.defineProperty(db, 'listCollections', { value: stub, configurable: true });
    commands.length = 0;
    try {
      await ensureSensitiveValidator(model as unknown as Model<unknown>);
    } finally {
      delete (db as unknown as Record<string, unknown>).listCollections;
    }
    expect(first).toBe(false);
    expect(commands.filter((name) => name === 'create')).toHaveLength(2);
    expect(commands.filter((name) => name === 'collMod')).toHaveLength(1);
    expect(await validatorOf('validatorRace')).toEqual(
      buildSensitiveValidator(new Schema({ a: sensitive() })),
    );
    expect(await rawInsertCode(model as unknown as Model<unknown>, { a: PLAIN })).toBe(121);
  });

  it('does nothing for a schema without sensitive paths', async () => {
    const model = monitored.model('ValidatorNone', new Schema({ x: String }), 'validatorNone');
    await model.init();
    commands.length = 0;
    await ensureSensitiveValidator(model as unknown as Model<unknown>);
    expect(commands).toHaveLength(0);
    expect(await validatorOf('validatorNone')).toBeUndefined();
  });
});

describe('the installed validator', () => {
  let Guarded: Model<unknown>;

  beforeAll(async () => {
    Guarded = defineModel(
      'ValidatorShapes',
      fullSchema(),
      'validatorShapes',
    ) as unknown as Model<unknown>;
    await connectDb();
  });

  it('accepts encrypted values in every supported place, and absent fields', async () => {
    expect(
      await rawInsertCode(Guarded, {
        a: fakeEncrypted(),
        n: { b: fakeEncrypted(), deeper: { c: fakeEncrypted() } },
        s: { c: fakeEncrypted() },
        arr: [{ d: fakeEncrypted(), inner: [{ e: fakeEncrypted() }] }],
      }),
    ).toBe('written');
    expect(await rawInsertCode(Guarded, { name: 'nothing sensitive' })).toBe('written');
    expect(await rawInsertCode(Guarded, { s: null, arr: null, n: null })).toBe('written');
  });

  it.each([
    ['a plain value at the top level', { a: PLAIN }],
    ['a plain number', { a: 1234 }],
    ['null', { a: null }],
    ['another binary subtype', { a: new mongo.Binary(Buffer.alloc(82, 2), 0) }],
    ['a plain value in a nested object', { n: { b: PLAIN } }],
    ['a plain value two levels down', { n: { deeper: { c: PLAIN } } }],
    ['a plain value in a subdocument', { s: { c: PLAIN } }],
    ['a plain value in an array of subdocuments', { arr: [{ d: PLAIN }] }],
    ['a plain value in a nested array of subdocuments', { arr: [{ inner: [{ e: PLAIN }] }] }],
    ['an array of encrypted values in a sensitive path', { a: [fakeEncrypted()] }],
    ['an object where the array of subdocuments belongs', { arr: { d: PLAIN } }],
    ['an array where the subdocument belongs', { s: [{ c: PLAIN }] }],
    ['an array where the nested object belongs', { n: [{ b: PLAIN }] }],
    ['an array inside the array of subdocuments', { arr: [[{ d: PLAIN }]] }],
    ['a plain value where the subdocument belongs', { s: PLAIN }],
  ])('rejects %s (code 121)', async (_label, doc) => {
    const before = await Guarded.collection.countDocuments();
    expect(await rawInsertCode(Guarded, doc)).toBe(121);
    expect(await Guarded.collection.countDocuments()).toBe(before);
  });

  it('rejects a plain value set by an update', async () => {
    const { insertedId } = await Guarded.collection.insertOne({ name: 'update target' });
    await expect(
      Guarded.collection.updateOne({ _id: insertedId }, { $set: { 'arr.0.d': PLAIN } }),
    ).rejects.toMatchObject({ code: 121 });
    await expect(
      Guarded.collection.updateOne({ _id: insertedId }, { $set: { 's.c': PLAIN } }),
    ).rejects.toMatchObject({ code: 121 });
    const stored = await Guarded.collection.findOne({ _id: insertedId });
    expect(JSON.stringify(stored)).not.toContain(PLAIN);
  });
});
