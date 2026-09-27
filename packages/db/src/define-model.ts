import mongoose, { type ClientSession, type Model, type Schema } from 'mongoose';
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

/**
 * Registers a Mongoose model with an explicit collection name. Mongoose would otherwise derive a
 * lowercased name (`purchaseorders`), which breaks the naming convention.
 *
 * Its indexes are built by `connectDb()` before any write needs them, and a write never runs
 * before they exist (see indexes.ts), so unique indexes hold from the first write and a failed
 * build throws instead of going unnoticed.
 *
 * In development, Next's hot reload re-evaluates model files; the old model is replaced so schema
 * edits take effect without a restart. In production a duplicate name still throws.
 */
export function defineModel<TSchema extends Schema>(
  name: string,
  schema: TSchema,
  collection: string,
) {
  if (!COLLECTION_NAME.test(collection)) {
    throw new Error(
      `Collection "${collection}" must be plural camelCase, for example "purchaseOrders".`,
    );
  }
  if (process.env.NODE_ENV !== 'production' && mongoose.models[name]) {
    mongoose.deleteModel(name);
  }
  // Hooks must be on the schema before the model is compiled; they only run later, after it is.
  let compiled: Model<unknown> | null = null;
  checkIndexesBeforeWrites(schema, () => {
    if (!compiled) throw new Error(`Model ${name} is not compiled yet.`);
    return compiled;
  });
  const model = mongoose.model(name, schema, collection);
  compiled = model as unknown as Model<unknown>;
  return model;
}
