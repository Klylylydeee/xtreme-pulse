import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose, { type Model, mongo, Schema } from 'mongoose';
import { buildSensitiveValidator, connectDb, defineModel } from '@pulse/db';
import { type EncryptedValue, encryptSensitive, sensitiveField } from './fields';
import { SensitiveFieldNotEncryptedError, SensitiveFieldShapeError } from './guard';

// The sensitive-field guard and its database backstop (SECURITY.md#sensitive-data, ADR 0012,
// docs/TESTING.md#sensitive-data-guard-tests). Every refusal checks three things: the error class,
// a message without the plaintext, and an unchanged collection. Every accepted write is read back
// raw to check that the stored value is BSON binary subtype 6.

/** A made-up value. Never real data. */
const PLAIN = 'PLAINTEXT-0042-9999';

type Doc = Record<string, unknown>;
type LooseModel = Model<Doc>;
type ErrorClass = abstract new (...args: never[]) => Error;

const accountSchema = new Schema({ bank: String, number: sensitiveField() });
const personSchema = new Schema({
  key: String,
  value: sensitiveField(),
  profile: { tin: sensitiveField(), note: String },
  payroll: new Schema({ salary: sensitiveField(), grade: String }),
  accounts: [accountSchema],
  tags: [String],
});
const Person = defineModel('GuardPerson', personSchema, 'guardPeople') as unknown as LooseModel;

// A collection only `$out` writes to (it replaces the whole collection).
const OutTarget = defineModel(
  'GuardOutTarget',
  new Schema({ key: String, value: sensitiveField() }),
  'guardOutTargets',
) as unknown as LooseModel;

// A model without sensitive fields, whose aggregates write into the sensitive collections.
const Source = defineModel(
  'GuardSource',
  new Schema({ key: String, value: Schema.Types.Mixed }),
  'guardSources',
) as unknown as LooseModel;

let enc: EncryptedValue;
let enc2: EncryptedValue;

beforeAll(async () => {
  await connectDb();
  enc = await encryptSensitive(PLAIN);
  enc2 = await encryptSensitive('another-made-up-value');
});

// ---------------------------------------------------------------------------------------------
// Helpers

function database(): mongo.Db {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Not connected.');
  return db;
}

async function caught(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    return error;
  }
  return undefined;
}

async function snapshot(model: LooseModel): Promise<string> {
  const docs = await model.collection.find({}).sort({ _id: 1 }).toArray();
  return mongo.BSON.EJSON.stringify(docs, { relaxed: false });
}

/**
 * Runs a write that must be refused: the error is an `errorClass`, its message doesn't include the
 * plaintext, and the collection is unchanged.
 */
async function expectRefused(
  work: () => Promise<unknown>,
  errorClass: ErrorClass = SensitiveFieldNotEncryptedError,
  model: LooseModel = Person,
): Promise<Error> {
  const before = await snapshot(model);
  const error = await caught(work);
  expect(error).toBeInstanceOf(errorClass);
  expect((error as Error).message).not.toContain(PLAIN);
  expect(await snapshot(model)).toBe(before);
  return error as Error;
}

/** A write only MongoDB's validator stops: DocumentValidationFailure, code 121. */
async function expectValidatorRefused(
  work: () => Promise<unknown>,
  model: LooseModel = Person,
): Promise<void> {
  const error = await expectRefused(work, mongo.MongoServerError, model);
  expect((error as mongo.MongoServerError).code).toBe(121);
}

function valueAt(doc: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (current, key) =>
        current === null || current === undefined
          ? undefined
          : (current as Record<string, unknown>)[key],
      doc,
    );
}

/** Reads the record raw (no Mongoose) and checks each path holds binary subtype 6. */
async function expectStoredEncrypted(
  filter: Doc,
  paths: string[],
  model: LooseModel = Person,
): Promise<void> {
  const doc = await model.collection.findOne(filter);
  expect(doc).not.toBeNull();
  for (const path of paths) {
    const value = valueAt(doc, path);
    expect(value, path).toBeInstanceOf(mongo.Binary);
    expect((value as mongo.Binary).sub_type, path).toBe(6);
  }
  expect(mongo.BSON.EJSON.stringify(doc)).not.toContain(PLAIN);
}

async function seed(key: string, extra: Doc = {}): Promise<mongo.ObjectId> {
  const doc = await Person.create({
    key,
    value: enc,
    accounts: [{ bank: 'A', number: enc }],
    ...extra,
  });
  return doc._id as mongo.ObjectId;
}

/** Mongoose 9 accepts an update pipeline only with this option. */
const PIPELINE = { updatePipeline: true } as const;

let counter = 0;
const uniqueName = (base: string) => `${base}${++counter}`;

// ---------------------------------------------------------------------------------------------

describe('shapes checked when the model is defined', () => {
  const defineWith =
    (definition: Doc, options: Doc = {}) =>
    () =>
      defineModel(
        uniqueName('GuardShape'),
        new Schema(definition, options),
        uniqueName('guardShape'),
      );

  it.each([
    ['an array of sensitive values', { list: [sensitiveField()] }],
    ['a nested array of sensitive values', { list: [[sensitiveField()]] }],
    ['a Map of sensitive values', { map: { type: Map, of: sensitiveField() } }],
    ['an array of values inside a subdocument', { sub: new Schema({ list: [sensitiveField()] }) }],
  ])('refuses %s', (_label, definition) => {
    expect(defineWith(definition)).toThrow(SensitiveFieldShapeError);
  });

  it('refuses a Map of subdocuments with a sensitive field', () => {
    // Mongoose refuses it first (`select: false` isn't allowed inside a Map); the guard would too.
    const definition = { map: { type: Map, of: new Schema({ n: sensitiveField() }) } };
    expect(defineWith(definition)).toThrow(/within maps/);
  });

  it('refuses a Map of subdocuments with a sensitive field one level further down', () => {
    // Mongoose checks only the Map's own subdocument paths, so this one reaches the guard.
    const deeper = new Schema({ inner: new Schema({ n: sensitiveField() }) });
    expect(defineWith({ map: { type: Map, of: deeper } })).toThrow(SensitiveFieldShapeError);
    const list = new Schema({ items: [new Schema({ n: sensitiveField() })] });
    expect(defineWith({ map: { type: Map, of: list } })).toThrow(SensitiveFieldShapeError);
  });

  it('refuses a schema with strict: false', () => {
    expect(defineWith({ value: sensitiveField() }, { strict: false })).toThrow(
      SensitiveFieldShapeError,
    );
  });

  it('refuses a nested schema with strict: false', () => {
    const child = new Schema({ number: sensitiveField() }, { strict: false });
    expect(defineWith({ accounts: [child] })).toThrow(SensitiveFieldShapeError);
  });

  it('refuses a discriminator of a model with a sensitive field', () => {
    const Base = defineModel(
      uniqueName('GuardDiscBase'),
      new Schema({ value: sensitiveField() }),
      uniqueName('guardDiscBase'),
    );
    expect(() => Base.discriminator(uniqueName('Child'), new Schema({ other: String }))).toThrow(
      SensitiveFieldShapeError,
    );
  });

  it('refuses a discriminator whose own schema has a sensitive field', () => {
    const Base = defineModel(
      uniqueName('GuardDiscPlain'),
      new Schema({ name: String }),
      uniqueName('guardDiscPlain'),
    );
    expect(() =>
      Base.discriminator(uniqueName('Child'), new Schema({ value: sensitiveField() })),
    ).toThrow(SensitiveFieldShapeError);
  });

  it('refuses Schema#discriminator and embedded discriminators', () => {
    const base = new Schema({ value: sensitiveField() });
    expect(() => base.discriminator(uniqueName('Child'), new Schema({ x: String }))).toThrow(
      SensitiveFieldShapeError,
    );
    const holder = new Schema({ items: [new Schema({ kind: String })] });
    const items = holder.path('items') as unknown as {
      discriminator(name: string, schema: Schema): unknown;
    };
    expect(() =>
      items.discriminator(uniqueName('Item'), new Schema({ number: sensitiveField() })),
    ).toThrow(SensitiveFieldShapeError);
  });

  it('compiles every supported shape', () => {
    expect(() =>
      defineModel(
        uniqueName('GuardSupported'),
        new Schema({
          top: sensitiveField({ required: true }),
          nested: { deeper: { value: sensitiveField() } },
          sub: new Schema({ value: sensitiveField() }),
          list: [new Schema({ value: sensitiveField(), inner: [{ value: sensitiveField() }] })],
        }),
        uniqueName('guardSupported'),
      ),
    ).not.toThrow();
  });
});

describe('the database validator', () => {
  it('is installed on every collection with sensitive paths', async () => {
    for (const model of [Person, OutTarget]) {
      const [info] = await database()
        .listCollections({ name: model.collection.collectionName })
        .toArray();
      expect((info as { options?: Doc }).options?.validator).toEqual(
        buildSensitiveValidator(model.schema),
      );
    }
    const [plain] = await database().listCollections({ name: 'guardSources' }).toArray();
    expect((plain as { options?: Doc } | undefined)?.options?.validator).toBeUndefined();
  });
});

describe('strict: false', () => {
  let id: mongo.ObjectId;
  beforeEach(async () => {
    id = await seed(uniqueName('strict'));
  });

  it('is refused on updateOne', async () => {
    await expectRefused(() =>
      Person.updateOne({ _id: id }, { $set: { key: 'changed' } }, { strict: false }),
    );
  });

  it('is refused on findOneAndUpdate', async () => {
    await expectRefused(() =>
      Person.findOneAndUpdate({ _id: id }, { $set: { key: 'changed' } }, { strict: false }),
    );
  });

  it('is refused in bulkWrite options', async () => {
    await expectRefused(() =>
      Person.bulkWrite([{ updateOne: { filter: { _id: id }, update: { key: 'changed' } } }], {
        strict: false,
      } as never),
    );
  });

  it('is refused on a single bulkWrite operation', async () => {
    await expectRefused(() =>
      Person.bulkWrite([
        { updateOne: { filter: { _id: id }, update: { key: 'changed' }, strict: false } } as never,
      ]),
    );
  });

  it('is refused on save of a document created with it', async () => {
    const doc = new Person({ key: 'strict-save', value: enc }, null, { strict: false });
    await expectRefused(() => doc.save());
  });
});

describe('bypassDocumentValidation', () => {
  let id: mongo.ObjectId;
  beforeEach(async () => {
    id = await seed(uniqueName('bypass'));
  });

  it('is refused in query options', async () => {
    await expectRefused(() =>
      Person.updateOne(
        { _id: id },
        { $set: { key: 'changed' } },
        { bypassDocumentValidation: true },
      ),
    );
  });

  it('is refused in bulkWrite options', async () => {
    await expectRefused(() =>
      Person.bulkWrite([{ updateOne: { filter: { _id: id }, update: { key: 'changed' } } }], {
        bypassDocumentValidation: true,
      }),
    );
  });

  it('is refused on an aggregate of a sensitive model', async () => {
    await expectRefused(() =>
      Person.aggregate([{ $match: { _id: id } }]).option({ bypassDocumentValidation: true }),
    );
  });

  it('is refused on any aggregate whose $out or $merge writes to a sensitive collection', async () => {
    await Source.collection.deleteMany({});
    await Source.collection.insertOne({ key: 'from-source', value: PLAIN });
    await expectRefused(
      () =>
        Source.aggregate([{ $merge: { into: 'guardPeople' } }]).option({
          bypassDocumentValidation: true,
        }),
      SensitiveFieldNotEncryptedError,
      Person,
    );
    await expectRefused(
      () =>
        Source.aggregate([{ $out: 'guardOutTargets' }]).option({ bypassDocumentValidation: true }),
      SensitiveFieldNotEncryptedError,
      OutTarget,
    );
  });
});

describe('null and absent values', () => {
  it('refuses null on create', async () => {
    await expectRefused(
      () => Person.create({ key: 'null-create', value: null }),
      mongoose.Error.ValidationError,
    );
  });

  it('refuses null in $set, also inside a parent object', async () => {
    const id = await seed(uniqueName('null-set'));
    await expectRefused(() => Person.updateOne({ _id: id }, { $set: { value: null } }));
    await expectRefused(() => Person.updateOne({ _id: id }, { $set: { profile: { tin: null } } }));
    await expectRefused(() =>
      Person.updateOne({ _id: id }, { $set: { 'accounts.0.number': null } }),
    );
  });

  it('refuses null through the setter, with or without validation', async () => {
    const id = await seed(uniqueName('null-setter'));
    const doc = await Person.findById(id).select('+value').orFail();
    doc.set('value', null);
    await expectRefused(() => doc.save(), mongoose.Error.ValidationError);
    await expectRefused(() => doc.save({ validateBeforeSave: false }));
  });

  it('allows an absent value', async () => {
    const key = uniqueName('absent');
    await Person.create({ key });
    const raw = await Person.collection.findOne({ key });
    expect(raw).not.toBeNull();
    expect(raw).not.toHaveProperty('value');
  });

  it('allows $unset', async () => {
    const id = await seed(uniqueName('unset'));
    await Person.updateOne({ _id: id }, { $unset: { value: 1, 'accounts.0.number': 1 } });
    const raw = await Person.collection.findOne({ _id: id });
    expect(raw).not.toHaveProperty('value');
    expect(raw?.accounts?.[0]).not.toHaveProperty('number');
  });
});

describe('$rename', () => {
  let id: mongo.ObjectId;
  beforeEach(async () => {
    id = await seed(uniqueName('rename'), { profile: { tin: enc, note: PLAIN } });
  });

  it.each([
    ['into a sensitive field', { key: 'value' }],
    ['out of a sensitive field', { value: 'key' }],
    ['into a nested sensitive field', { 'profile.note': 'profile.tin' }],
    ['the parent object of a sensitive field', { profile: 'oldProfile' }],
    ['onto the parent object of a sensitive field', { key: 'profile' }],
  ])('is refused %s', async (_label, rename) => {
    await expectRefused(() => Person.updateOne({ _id: id }, { $rename: rename }));
  });
});

describe('upserts with a sensitive filter', () => {
  const update = () => ({ $set: { key: uniqueName('upsert') } });

  it.each([
    ['updateOne', () => Person.updateOne({ value: PLAIN }, update(), { upsert: true })],
    [
      'findOneAndUpdate',
      () => Person.findOneAndUpdate({ 'profile.tin': PLAIN }, update(), { upsert: true }),
    ],
    [
      'replaceOne',
      () => Person.replaceOne({ value: PLAIN }, { key: 'replaced' }, { upsert: true }),
    ],
    [
      'findOneAndReplace',
      () => Person.findOneAndReplace({ value: PLAIN }, { key: 'replaced' }, { upsert: true }),
    ],
    [
      'a bulkWrite upsert',
      () =>
        Person.bulkWrite([
          { updateOne: { filter: { value: PLAIN }, update: update(), upsert: true } },
        ]),
    ],
    [
      'a filter inside $and',
      () => Person.updateOne({ $and: [{ value: PLAIN }] }, update(), { upsert: true }),
    ],
    [
      'a filter inside $or',
      () =>
        Person.updateOne({ $or: [{ key: 'x' }, { 'payroll.salary': PLAIN }] }, update(), {
          upsert: true,
        }),
    ],
    [
      'equality on the parent object',
      () => Person.updateOne({ profile: { tin: PLAIN } }, update(), { upsert: true }),
    ],
    [
      'a field of an array of subdocuments',
      () => Person.updateOne({ 'accounts.number': PLAIN }, update(), { upsert: true }),
    ],
    [
      '$in on the parent object',
      () => Person.updateOne({ profile: { $in: [{ tin: PLAIN }] } }, update(), { upsert: true }),
    ],
    [
      '$nin on the parent object',
      () => Person.updateOne({ profile: { $nin: [{ tin: PLAIN }] } }, update(), { upsert: true }),
    ],
    [
      '$all on an array of subdocuments',
      () =>
        Person.updateOne({ accounts: { $all: [{ number: PLAIN }] } }, update(), { upsert: true }),
    ],
    [
      '$elemMatch on an array of subdocuments',
      () =>
        Person.updateOne({ accounts: { $elemMatch: { number: PLAIN } } }, update(), {
          upsert: true,
        }),
    ],
    [
      '$in on the sensitive field itself',
      () => Person.updateOne({ value: { $in: [PLAIN] } }, update(), { upsert: true }),
    ],
  ])('is refused on %s', async (_label, work) => {
    await expectRefused(work);
  });
});

describe('$setOnInsert', () => {
  it('refuses a plain value', async () => {
    await expectRefused(() =>
      Person.updateOne(
        { key: uniqueName('soi') },
        { $setOnInsert: { value: PLAIN } },
        { upsert: true },
      ),
    );
  });

  it('stores an encrypted value as subtype 6', async () => {
    const key = uniqueName('soi');
    await Person.updateOne(
      { key },
      { $setOnInsert: { value: enc, payroll: { salary: enc2 } } },
      { upsert: true },
    );
    await expectStoredEncrypted({ key }, ['value', 'payroll.salary']);
  });
});

describe('arrays of sensitive subdocuments', () => {
  let id: mongo.ObjectId;
  beforeEach(async () => {
    id = await seed(uniqueName('array'));
  });

  it.each(['$push', '$addToSet'])('%s with an encrypted value passes', async (operator) => {
    await Person.updateOne({ _id: id }, { [operator]: { accounts: { bank: 'B', number: enc2 } } });
    await expectStoredEncrypted({ _id: id }, ['accounts.0.number', 'accounts.1.number']);
  });

  it.each(['$push', '$addToSet'])('%s with a plain value is refused', async (operator) => {
    await expectRefused(() =>
      Person.updateOne({ _id: id }, { [operator]: { accounts: { bank: 'B', number: PLAIN } } }),
    );
  });

  it.each(['$push', '$addToSet'])('%s with $each of mixed values is refused', async (operator) => {
    await expectRefused(() =>
      Person.updateOne(
        { _id: id },
        {
          [operator]: {
            accounts: {
              $each: [
                { bank: 'B', number: enc2 },
                { bank: 'C', number: PLAIN },
              ],
            },
          },
        },
      ),
    );
  });

  it('$push with $each of encrypted values passes', async () => {
    await Person.updateOne(
      { _id: id },
      {
        $push: {
          accounts: {
            $each: [
              { bank: 'B', number: enc2 },
              { bank: 'C', number: enc },
            ],
          },
        },
      },
    );
    await expectStoredEncrypted({ _id: id }, ['accounts.1.number', 'accounts.2.number']);
  });

  it('$pull and $pop are allowed', async () => {
    await Person.updateOne({ _id: id }, { $push: { accounts: { bank: 'B', number: enc2 } } });
    await Person.updateOne({ _id: id }, { $pull: { accounts: { bank: 'A' } } });
    let raw = await Person.collection.findOne({ _id: id });
    expect(raw?.accounts).toHaveLength(1);
    await Person.updateOne({ _id: id }, { $pop: { accounts: 1 } });
    raw = await Person.collection.findOne({ _id: id });
    expect(raw?.accounts).toHaveLength(0);
  });

  it.each(['accounts.0.number', 'accounts.$[].number'])(
    '$set on %s with a plain value is refused',
    async (path) => {
      await expectRefused(() => Person.updateOne({ _id: id }, { $set: { [path]: PLAIN } }));
    },
  );

  it.each(['accounts.0.number', 'accounts.$[].number'])(
    '$set on %s with an encrypted value passes',
    async (path) => {
      await Person.updateOne({ _id: id }, { $set: { [path]: enc2 } });
      await expectStoredEncrypted({ _id: id }, ['accounts.0.number']);
    },
  );
});

describe('bulkWrite', () => {
  let id: mongo.ObjectId;
  beforeEach(async () => {
    id = await seed(uniqueName('bulk'));
  });

  it.each([
    ['insertOne', () => ({ insertOne: { document: { key: 'bulk-insert', value: PLAIN } } })],
    ['updateOne', () => ({ updateOne: { filter: { _id: id }, update: { value: PLAIN } } })],
    [
      'updateMany',
      () => ({ updateMany: { filter: { _id: id }, update: { $set: { 'profile.tin': PLAIN } } } }),
    ],
    [
      'replaceOne',
      () => ({ replaceOne: { filter: { _id: id }, replacement: { key: 'r', value: PLAIN } } }),
    ],
  ])('%s with a plain value is refused', async (_label, operation) => {
    await expectRefused(() => Person.bulkWrite([operation() as never]));
  });

  it('every operation with encrypted values passes', async () => {
    const key = uniqueName('bulk-insert');
    const other = await seed(uniqueName('bulk-other'));
    const third = await seed(uniqueName('bulk-third'));
    await Person.bulkWrite([
      { insertOne: { document: { key, value: enc, profile: { tin: enc2 } } } },
      { updateOne: { filter: { _id: id }, update: { $set: { value: enc2 } } } },
      { updateMany: { filter: { _id: other }, update: { $set: { 'payroll.salary': enc } } } },
      { replaceOne: { filter: { _id: third }, replacement: { key: 'replaced', value: enc2 } } },
    ] as never);
    await expectStoredEncrypted({ key }, ['value', 'profile.tin']);
    await expectStoredEncrypted({ _id: id }, ['value']);
    await expectStoredEncrypted({ _id: other }, ['payroll.salary']);
    await expectStoredEncrypted({ _id: third }, ['value']);
  });
});

describe('replacements and update pipelines', () => {
  let id: mongo.ObjectId;
  beforeEach(async () => {
    id = await seed(uniqueName('replace'));
  });

  it('replaceOne with a plain value is refused, with an encrypted one passes', async () => {
    await expectRefused(() => Person.replaceOne({ _id: id }, { key: 'r', value: PLAIN }));
    await Person.replaceOne({ _id: id }, { key: 'r', value: enc2, profile: { tin: enc } });
    await expectStoredEncrypted({ _id: id }, ['value', 'profile.tin']);
  });

  it('findOneAndReplace with a plain value is refused, with an encrypted one passes', async () => {
    await expectRefused(() =>
      Person.findOneAndReplace({ _id: id }, { key: 'r', payroll: { salary: PLAIN } }),
    );
    await Person.findOneAndReplace({ _id: id }, { key: 'r', payroll: { salary: enc } });
    await expectStoredEncrypted({ _id: id }, ['payroll.salary']);
  });

  it('an update pipeline that writes a sensitive field is refused', async () => {
    await expectRefused(() =>
      Person.updateOne({ _id: id }, [{ $set: { value: PLAIN } }], PIPELINE),
    );
    await expectRefused(() =>
      Person.updateOne({ _id: id }, [{ $set: { 'profile.tin': '$key' } }], PIPELINE),
    );
    // Even with an encrypted value: the guard can't evaluate pipeline expressions.
    await expectRefused(() =>
      Person.updateOne({ _id: id }, [{ $set: { value: { $literal: enc } } }], PIPELINE),
    );
  });

  it('$replaceWith and $replaceRoot are refused', async () => {
    await expectRefused(() =>
      Person.updateOne({ _id: id }, [{ $replaceWith: { key: 'x', value: PLAIN } }], PIPELINE),
    );
    await expectRefused(() =>
      Person.updateOne(
        { _id: id },
        [{ $replaceRoot: { newRoot: { key: 'x', value: enc } } }],
        PIPELINE,
      ),
    );
  });

  it('an update pipeline that leaves sensitive fields alone passes', async () => {
    await Person.updateOne({ _id: id }, [{ $set: { key: 'piped' } }], PIPELINE);
    const raw = await Person.collection.findOne({ _id: id });
    expect(raw?.key).toBe('piped');
    await expectStoredEncrypted({ _id: id }, ['value', 'accounts.0.number']);
  });
});

describe('insertMany and save', () => {
  it('refuses a plain value in a lean insertMany', async () => {
    await expectRefused(() => Person.insertMany([{ key: 'lean', value: PLAIN }], { lean: true }));
  });

  it('refuses ciphertext as a plain Buffer (not a subtype 6 Binary) in a lean insertMany', async () => {
    const bytes = Buffer.from(enc.buffer);
    await expectRefused(() => Person.insertMany([{ key: 'lean', value: bytes }], { lean: true }));
  });

  it('refuses a plain value in insertMany', async () => {
    await expectRefused(() => Person.insertMany([{ key: 'many', profile: { tin: PLAIN } }]));
  });

  it('stores a lean insertMany of encrypted values as subtype 6', async () => {
    const key = uniqueName('lean');
    await Person.insertMany([{ key, value: enc, accounts: [{ number: enc2 }] }], { lean: true });
    await expectStoredEncrypted({ key }, ['value', 'accounts.0.number']);
  });

  it('refuses a plain value on save without validation', async () => {
    const doc = new Person({ key: 'no-validation' });
    doc.set('value', PLAIN);
    await expectRefused(() => doc.save({ validateBeforeSave: false }));
    const nested = new Person({ key: 'no-validation', accounts: [{ number: PLAIN }] });
    await expectRefused(() => nested.save({ validateBeforeSave: false }));
  });

  it('refuses a plain value on create, through validation', async () => {
    await expectRefused(
      () => Person.create({ key: 'create', value: PLAIN }),
      mongoose.Error.ValidationError,
    );
  });

  it('stores create and save of encrypted values as subtype 6', async () => {
    const key = uniqueName('create');
    await Person.create({
      key,
      value: enc,
      profile: { tin: enc2 },
      payroll: { salary: enc },
      accounts: [{ number: enc2 }],
    });
    await expectStoredEncrypted({ key }, [
      'value',
      'profile.tin',
      'payroll.salary',
      'accounts.0.number',
    ]);
  });
});

describe('writes only the database validator stops', () => {
  let id: mongo.ObjectId;
  beforeEach(async () => {
    id = await seed(uniqueName('raw'));
  });

  it('raw insertOne', async () => {
    await expectValidatorRefused(() => Person.collection.insertOne({ key: 'raw', value: PLAIN }));
    const key = uniqueName('raw');
    await Person.collection.insertOne({ key, value: enc });
    await expectStoredEncrypted({ key }, ['value']);
  });

  it('raw bulkWrite', async () => {
    await expectValidatorRefused(() =>
      Person.collection.bulkWrite([
        { updateOne: { filter: { _id: id }, update: { $set: { 'accounts.0.number': PLAIN } } } },
        { insertOne: { document: { key: 'raw' } } },
      ]),
    );
    await Person.collection.bulkWrite([
      { updateOne: { filter: { _id: id }, update: { $set: { 'accounts.0.number': enc2 } } } },
    ]);
    await expectStoredEncrypted({ _id: id }, ['accounts.0.number']);
  });

  it('raw replaceOne', async () => {
    await expectValidatorRefused(() =>
      Person.collection.replaceOne({ _id: id }, { key: 'raw', profile: { tin: PLAIN } }),
    );
    await Person.collection.replaceOne({ _id: id }, { key: 'raw', profile: { tin: enc } });
    await expectStoredEncrypted({ _id: id }, ['profile.tin']);
  });

  it('raw findOneAndReplace', async () => {
    await expectValidatorRefused(() =>
      Person.collection.findOneAndReplace({ _id: id }, { key: 'raw', value: PLAIN }),
    );
    await Person.collection.findOneAndReplace({ _id: id }, { key: 'raw', value: enc2 });
    await expectStoredEncrypted({ _id: id }, ['value']);
  });

  it('raw updateOne with a pipeline', async () => {
    await expectValidatorRefused(() =>
      Person.collection.updateOne({ _id: id }, [{ $set: { value: PLAIN } }]),
    );
    await expectValidatorRefused(() =>
      Person.collection.updateOne({ _id: id }, [{ $set: { 'payroll.salary': '$key' } }]),
    );
    await Person.collection.updateOne({ _id: id }, [{ $set: { value: { $literal: enc2 } } }]);
    await expectStoredEncrypted({ _id: id }, ['value']);
  });

  it('aggregate $merge into the collection', async () => {
    await Source.collection.deleteMany({});
    await Source.collection.insertOne({ key: 'merge-plain', value: PLAIN });
    await expectValidatorRefused(() => Source.aggregate([{ $merge: { into: 'guardPeople' } }]));
    await Source.collection.deleteMany({});
    const key = uniqueName('merge');
    await Source.collection.insertOne({ key, value: enc });
    await Source.aggregate([{ $merge: { into: 'guardPeople' } }]);
    await expectStoredEncrypted({ key }, ['value']);
  });

  it('aggregate $out into the collection, which keeps its validator', async () => {
    await OutTarget.create({ key: 'before-out', value: enc });
    await Source.collection.deleteMany({});
    await Source.collection.insertOne({ key: 'out-plain', value: PLAIN });
    await expectValidatorRefused(() => Source.aggregate([{ $out: 'guardOutTargets' }]), OutTarget);

    await Source.collection.deleteMany({});
    const key = uniqueName('out');
    await Source.collection.insertOne({ key, value: enc2 });
    await Source.aggregate([{ $out: 'guardOutTargets' }]);
    await expectStoredEncrypted({ key }, ['value'], OutTarget);

    const [info] = await database().listCollections({ name: 'guardOutTargets' }).toArray();
    const options = (info as { options?: Doc }).options;
    expect(options?.validator).toEqual(buildSensitiveValidator(OutTarget.schema));
    expect(options?.validationAction ?? 'error').toBe('error');
    expect(options?.validationLevel ?? 'strict').toBe('strict');
    await expectValidatorRefused(
      () => OutTarget.collection.insertOne({ key: 'after-out', value: PLAIN }),
      OutTarget,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// KNOWN LIMITATIONS (accepted, ADR 0012 Consequences, SECURITY.md#sensitive-data). These tests
// pin today's behaviour of writes that skip the guard: Mongoose's `middleware: false` option and
// `connection.bulkWrite`. Code must never use them (a lint rule bans the option keys). If a later
// fix closes a gap, the matching test fails: flip it to expect a refusal.

describe('known limitation: writes that skip the guard', () => {
  let id: mongo.ObjectId;
  beforeEach(async () => {
    id = await seed(uniqueName('limit'));
  });

  /** Reads the stored value raw. */
  async function storedValue(filter: Doc): Promise<unknown> {
    return valueAt(await Person.collection.findOne(filter), 'value');
  }

  /** The setter's empty subtype 6 placeholder: the value written was lost. */
  function expectEmptyPlaceholder(value: unknown): void {
    expect(value).toBeInstanceOf(mongo.Binary);
    expect((value as mongo.Binary).sub_type).toBe(6);
    expect((value as mongo.Binary).length()).toBe(0);
  }

  it('known limitation: middleware: false with bypassDocumentValidation stores plain text through an update pipeline', async () => {
    await Person.updateOne({ _id: id }, [{ $set: { value: PLAIN } }], {
      ...PIPELINE,
      middleware: false,
      bypassDocumentValidation: true,
    });
    expect(await storedValue({ _id: id })).toBe(PLAIN);
    await Person.collection.deleteOne({ _id: id });
  });

  it('known limitation: middleware: false with bypassDocumentValidation stores plain text through $merge', async () => {
    const key = uniqueName('limit-merge');
    await Source.collection.deleteMany({});
    await Source.collection.insertOne({ key, value: PLAIN });
    await Source.aggregate([{ $merge: { into: 'guardPeople' } }]).option({
      bypassDocumentValidation: true,
      middleware: false,
    });
    expect(await storedValue({ key })).toBe(PLAIN);
    await Person.collection.deleteOne({ key });
    await Source.collection.deleteMany({});
  });

  it('known limitation: middleware: false with bypassDocumentValidation stores plain text through a lean insertMany', async () => {
    const key = uniqueName('limit-insert');
    // Mongoose's types leave the option out of insertMany, but Mongoose passes it to MongoDB.
    const options = { lean: true, middleware: false, bypassDocumentValidation: true } as const;
    await Person.insertMany([{ key, value: PLAIN }], options as { lean: true });
    expect(await storedValue({ key })).toBe(PLAIN);
    await Person.collection.deleteOne({ key });
  });

  it('known limitation: middleware: false alone stops a pipeline only at the validator (code 121)', async () => {
    await expectValidatorRefused(() =>
      Person.updateOne({ _id: id }, [{ $set: { value: PLAIN } }], {
        ...PIPELINE,
        middleware: false,
      }),
    );
  });

  it.each([
    ['a plain value', PLAIN],
    ['null', null],
  ])(
    'known limitation: middleware: false alone silently replaces %s with an empty placeholder',
    async (_label, written) => {
      await Person.updateOne({ _id: id }, { $set: { value: written } }, { middleware: false });
      expectEmptyPlaceholder(await storedValue({ _id: id }));
    },
  );

  it.each([
    ['a plain value', PLAIN],
    ['null', null],
  ])(
    'known limitation: connection.bulkWrite skips the bulkWrite hooks and silently replaces %s with an empty placeholder',
    async (_label, written) => {
      await mongoose.connection.bulkWrite([
        {
          model: 'GuardPerson',
          name: 'updateOne',
          filter: { _id: id },
          update: { $set: { value: written } },
        },
      ]);
      expectEmptyPlaceholder(await storedValue({ _id: id }));
    },
  );
});
