import mongoose, { type ClientSession, type Model, Schema } from 'mongoose';
import { beforeWrite } from './indexes';

// Spec: docs/DATA_MODEL.md#naming — collections are plural camelCase (`purchaseOrders`).
const COLLECTION_NAME = /^[a-z][a-zA-Z0-9]*$/;

// Every query that can insert a document (upsert) or change an indexed field. `save` (behind
// `create`), `insertMany` and `bulkWrite` are hooked separately.
const QUERY_WRITES = [
  'findOneAndReplace',
  'findOneAndUpdate',
  'replaceOne',
  'updateMany',
  'updateOne',
] as const;

type SessionOption = { session?: ClientSession | null } | undefined;

/** Registers the index check (see indexes.ts) before every write on the model. */
function checkIndexesBeforeWrites(schema: Schema, model: () => Model<unknown>): void {
  schema.pre('save', function () {
    return beforeWrite(model(), this.$session());
  });
  schema.pre([...QUERY_WRITES], { document: false, query: true }, function () {
    return beforeWrite(model(), this.getOptions().session);
  });
  schema.pre('insertMany', function (_docs: unknown, options?: SessionOption) {
    return beforeWrite(model(), options?.session);
  });
  schema.pre('bulkWrite', function (_ops: unknown, options?: SessionOption) {
    return beforeWrite(model(), options?.session);
  });
}

/** Compiles a new model, with the index check hooked in first. */
function compile<TSchema extends Schema>(name: string, schema: TSchema, collection: string) {
  // Taken before compiling: compiling adds paths (`__v`) and global plugins to the schema, which
  // another bundle's not-yet-compiled copy of the same schema doesn't have.
  const shape = schemaShape(schema, collection);
  // Hooks must be on the schema before the model is compiled; they only run later, after it is.
  let compiled: Model<unknown> | null = null;
  checkIndexesBeforeWrites(schema, () => {
    if (!compiled) throw new Error(`Model ${name} is not compiled yet.`);
    return compiled;
  });
  const model = mongoose.model(name, schema, collection);
  compiled = model as unknown as Model<unknown>;
  shapes.set(compiled, shape);
  return model;
}

// The shape each compiled model was defined with, to tell a real schema edit (development hot
// reload) from the same model file evaluated again by another bundle. On globalThis, like the
// models themselves (Mongoose is one instance per process).
const globalForModels = globalThis as typeof globalThis & {
  __pulseModelShapes?: WeakMap<Model<unknown>, string>;
};
const shapes = (globalForModels.__pulseModelShapes ??= new WeakMap());

/**
 * A fingerprint of a schema: its collection, paths, types, options and indexes. Functions
 * (validators, defaults, hooks) count only as "a function": bundlers rewrite their source per
 * bundle, so comparing it would see a change where there is none. Editing only a function body
 * therefore needs a dev server restart to take effect.
 */
function schemaShape(schema: Schema, collection: string): string {
  const seen = new WeakSet<object>();
  const describe = (value: unknown): unknown => {
    if (typeof value === 'function') return 'fn';
    if (value === null || typeof value !== 'object') return value;
    if (value instanceof RegExp || value instanceof Date) return String(value);
    if (value instanceof Schema) return describeSchema(value);
    if (seen.has(value)) return 'cycle';
    seen.add(value);
    if (Array.isArray(value)) return value.map(describe);
    const prototype = Object.getPrototypeOf(value) as object | null;
    // Anything that isn't plain data (Mongoose internals, ObjectIds) by its type only.
    if (prototype !== Object.prototype && prototype !== null) return value.constructor.name;
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, describe((value as Record<string, unknown>)[key])]),
    );
  };
  const describeSchema = (target: Schema): unknown =>
    Object.keys(target.paths)
      .sort()
      .map((path) => {
        const type = target.paths[path];
        return [path, type?.instance, describe(type?.options), describe(target.indexes())];
      });
  return JSON.stringify([collection, describeSchema(schema), describe(schema.indexes())]);
}

/**
 * Registers a Mongoose model with an explicit collection name. Mongoose would otherwise derive a
 * lowercased name (`purchaseorders`), which breaks the naming convention.
 *
 * Its indexes are built by `connectDb()` before any write needs them, and a write never runs
 * before they exist (see indexes.ts), so unique indexes hold from the first write and a failed
 * build throws instead of going unnoticed.
 *
 * Idempotent: Next evaluates model files once per bundle (the proxy and the app each run them,
 * against the one Mongoose in the process), so a name already registered returns the existing
 * model. It was compiled with the same hooks: the index check above and the global plugins, such
 * as the sensitive-field guard. Replacing it instead would break the other bundle's copy (its
 * collection is dropped from the connection and never opens), and production would throw.
 *
 * In development only, a hot-reloaded file whose schema really changed replaces the model, but
 * only once the connection is open, so the old model's collection is already open and the bundle
 * still holding it keeps working until it reloads too. A change before then, or one only inside a
 * function body, needs a dev server restart; a warning says so.
 */
export function defineModel<TSchema extends Schema>(
  name: string,
  schema: TSchema,
  collection: string,
): ReturnType<typeof compile<TSchema>> {
  if (!COLLECTION_NAME.test(collection)) {
    throw new Error(
      `Collection "${collection}" must be plural camelCase, for example "purchaseOrders".`,
    );
  }
  const existing = mongoose.models[name] as Model<unknown> | undefined;
  if (!existing) return compile(name, schema, collection);

  if (existing.collection.collectionName !== collection) {
    throw new Error(
      `Model ${name} is already registered for the "${existing.collection.collectionName}" collection, not "${collection}".`,
    );
  }
  const reuse = () => existing as unknown as ReturnType<typeof compile<TSchema>>;
  if (
    process.env.NODE_ENV === 'production' ||
    shapes.get(existing) === schemaShape(schema, collection)
  ) {
    return reuse();
  }
  if (mongoose.connection.readyState !== mongoose.ConnectionStates.connected) {
    console.warn(
      `[db] The ${name} schema changed before the database connected. Restart the dev server to use the new schema.`,
    );
    return reuse();
  }
  mongoose.deleteModel(name);
  return compile(name, schema, collection);
}
