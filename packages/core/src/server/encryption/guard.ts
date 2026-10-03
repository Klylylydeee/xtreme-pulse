import mongoose, { mongo, type Schema } from 'mongoose';
import { SENSITIVE_OPTION } from '@pulse/db';
import { isEncryptedValue } from './format';

// The write guard for sensitive fields (SECURITY.md#sensitive-data, ADR 0012). A sensitive field
// only ever stores ciphertext from `encryptSensitive`. `sensitiveField()`'s validator covers
// `create()` and `save()`, but Mongoose skips validators on query writes, `bulkWrite` updates, lean
// `insertMany` and `save({ validateBeforeSave: false })`. So every write path is checked here as
// well, on the values as the caller passed them, before Mongoose casts them (so `strictQuery:
// false` changes nothing):
//
// - query writes (updateOne, updateMany, findOneAndUpdate, replaceOne, findOneAndReplace, and a
//   document's updateOne), which also get `runValidators: true`;
// - bulkWrite (insertOne, updateOne, updateMany, replaceOne);
// - insertMany (lean or not). The hook can't see the `lean` option, which skips casting, so a
//   plain object must carry the Binary that encryptSensitive returns (plain bytes would be stored
//   as the wrong subtype); a Mongoose document is checked as usual;
// - save, whether or not validation runs.
//
// What a write may do to a sensitive field:
//
// - Set it (top-level keys, $set, $setOnInsert, a replacement, an insert) to ciphertext, also
//   inside a parent object or subdocument that is set as a whole. `null` is refused: an absent
//   field means "no value".
// - Remove it ($unset, or $pull, $pullAll and $pop on its array of subdocuments).
// - $push or $addToSet (with or without $each) new subdocuments into an array of subdocuments;
//   the new subdocuments are checked like an insert.
// - Nothing else. Refused: any other operator on it ($rename from or to it, $inc, $min…), a key
//   below it (`acct.x`), an update pipeline stage that writes it, and an upsert whose filter names
//   it (MongoDB would copy the filter value into the new record).
//
// Refused on any write to a model with a sensitive field, whatever it changes:
//
// - `strict: false` (a query option, a bulkWrite option or operation, or a document created with
//   it), which lets values past the schema;
// - `bypassDocumentValidation`, which skips the database validator (ADR 0012): in query and
//   bulkWrite options, and on an aggregate of the model. An aggregate of any model with this
//   option is refused too when its `$out` or `$merge` writes to a collection with sensitive
//   fields. Mongoose 9's insertMany hook can't see its options, so it can't refuse the option
//   there; the documents are still checked. `save` and `create` never pass it to MongoDB.
//
// A refused write throws SensitiveFieldNotEncryptedError, which names the field, never the value,
// and nothing is written. The raw driver collection bypasses Mongoose and this guard; module code
// never uses it, and the database validator still refuses a plain value written through it.
//
// KNOWN LIMITS (accepted, ADR 0012). Mongoose's per-call option `middleware: false` (or
// `middleware: { pre: false }`) skips every user hook, this guard included, and
// `mongoose.connection.bulkWrite` never runs a model's bulkWrite hooks. Through them, a plain
// value with `bypassDocumentValidation` is stored as plain text; without it, `sensitiveField()`'s
// setter turns a plain value or `null` into an empty placeholder that the validator accepts, so
// the value is lost silently. Code never passes these options or calls `connection.bulkWrite`: a
// lint rule (eslint.config.mjs) bans the option keys, and review checks the rest.
//
// SUPPORTED SHAPES. A sensitive field may be a top-level field, a field of a nested object, or a
// field of a subdocument or an array of subdocuments, at any depth. These shapes are refused with
// SensitiveFieldShapeError when the model or discriminator is defined, because this guard can't
// check every write to them:
//
// - an array of sensitive values (`[sensitiveField()]`), at any depth of nesting: use an array of
//   subdocuments instead;
// - a Map of sensitive values (`{ type: Map, of: sensitiveField() }`) or of subdocuments with one;
// - discriminators: a discriminator schema with a sensitive field, or a discriminator of a schema
//   that has one (Mongoose runs query and insert middleware from the base schema only);
// - a schema with a sensitive field that has the schema option `strict: false`, or whose nested
//   schemas do.
//
// The guard is a global Mongoose plugin, registered the first time `sensitiveField()` is called, so
// it is in place before any model with a sensitive field is compiled. On a schema without a
// sensitive field it adds only the aggregate check for `bypassDocumentValidation` above.

export { SENSITIVE_OPTION };

/** Thrown when a write would store something other than ciphertext in a sensitive field. */
export class SensitiveFieldNotEncryptedError extends Error {
  readonly path: string;
  constructor(path: string, message?: string) {
    super(
      message ??
        `The sensitive field "${path}" must be encrypted with encryptSensitive before it is saved. Nothing was written.`,
    );
    this.name = 'SensitiveFieldNotEncryptedError';
    this.path = path;
  }
}

function pipelineRefusal(path: string): SensitiveFieldNotEncryptedError {
  return new SensitiveFieldNotEncryptedError(
    path,
    `An update pipeline can't change the sensitive field "${path}". Use a plain update with a value from encryptSensitive. Nothing was written.`,
  );
}

function operatorRefusal(path: string, operator: string): SensitiveFieldNotEncryptedError {
  return new SensitiveFieldNotEncryptedError(
    path,
    `The update operator ${operator} can't change the sensitive field "${path}". Set it with a value from encryptSensitive, or unset it. Nothing was written.`,
  );
}

function upsertFilterRefusal(path: string): SensitiveFieldNotEncryptedError {
  return new SensitiveFieldNotEncryptedError(
    path,
    `An upsert can't filter on the sensitive field "${path}": MongoDB would copy the filter value into the new record. Nothing was written.`,
  );
}

function nullRefusal(path: string): SensitiveFieldNotEncryptedError {
  return new SensitiveFieldNotEncryptedError(
    path,
    `The sensitive field "${path}" can't be set to null. Leave it out, or $unset it, to store no value. Nothing was written.`,
  );
}

function optionRefusal(path: string, option: string): SensitiveFieldNotEncryptedError {
  return new SensitiveFieldNotEncryptedError(
    path,
    `The option ${option} can't be used to write to a collection with sensitive fields (such as "${path}"). Nothing was written.`,
  );
}

/**
 * Thrown when a model or discriminator is defined with a sensitive field in a shape the write guard
 * can't protect (see SUPPORTED SHAPES above). A programming error, raised before any data is read.
 */
export class SensitiveFieldShapeError extends Error {
  constructor(where: string) {
    super(
      `A sensitive field can't be used in ${where}. Use a top-level field, a nested object field, or a field of a subdocument or an array of subdocuments, in a schema without strict: false.`,
    );
    this.name = 'SensitiveFieldShapeError';
  }
}

const QUERY_WRITES = [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'replaceOne',
  'findOneAndReplace',
] as const;
// Update operators that may set a sensitive field (checked value by value), that add subdocuments
// (checked like inserts), and that only remove. Any other operator on a sensitive field is refused.
const SETTING_OPERATORS = new Set(['$set', '$setOnInsert']);
const ADDING_OPERATORS = new Set(['$push', '$addToSet']);
const REMOVING_OPERATORS = new Set(['$unset', '$pull', '$pullAll', '$pop']);
// Filter operators followed into an upsert's filter: those that can carry a value into the
// upserted record (`$in` or `$all` with one element acts as equality), and those that reach a
// field below a parent object or an array of subdocuments (`$nin` and `$elemMatch` too, to fail
// closed).
const FILTER_OPERATORS_TO_CHECK = new Set([
  '$and',
  '$or',
  '$nor',
  '$eq',
  '$in',
  '$nin',
  '$all',
  '$elemMatch',
]);
const PIPELINE_WRITING_STAGES = new Set([
  '$set',
  '$addFields',
  '$project',
  '$unset',
  '$replaceWith',
  '$replaceRoot',
]);

interface SchemaTypeLike {
  options?: Record<string, unknown>;
  schema?: Schema;
  instance?: string;
  $isMongooseArray?: boolean;
  embeddedSchemaType?: SchemaTypeLike;
  caster?: SchemaTypeLike;
  $__schemaType?: SchemaTypeLike;
}

function isMarked(type: SchemaTypeLike | undefined): boolean {
  return type?.options?.[SENSITIVE_OPTION] === true;
}

function discriminatorSchemas(schema: Schema | undefined): Schema[] {
  const found = (schema as { discriminators?: Record<string, Schema> } | undefined)?.discriminators;
  return found ? Object.values(found) : [];
}

interface SchemaInspection {
  /** The supported sensitive paths, as dotted paths without array positions. */
  paths: string[];
  /** Where a sensitive field is used in an unsupported shape. */
  unsupported: string[];
  /** Where the schema, or a nested schema, has the option `strict: false`. */
  notStrict: string[];
}

/** Finds every sensitive field in the schema, including in nested schemas. */
function inspectSchema(
  schema: Schema,
  prefix = '',
  result: SchemaInspection = { paths: [], unsupported: [], notStrict: [] },
): SchemaInspection {
  const before = result.paths.length;
  if ((schema as { options?: { strict?: unknown } }).options?.strict === false) {
    result.notStrict.push(prefix ? `"${prefix.slice(0, -1)}"` : 'the schema');
  }
  schema.eachPath((path, schemaType) => {
    const type = schemaType as unknown as SchemaTypeLike;
    const full = prefix + path;
    if (isMarked(type)) result.paths.push(full);
    if (type.schema) {
      inspectSchema(type.schema, `${full}.`, result);
    } else if (type.$isMongooseArray) {
      // An array of values (or of arrays of values): the sensitive option sits on the element type.
      let element = type.embeddedSchemaType ?? type.caster;
      while (element) {
        if (isMarked(element) || (element.schema && hasSensitiveField(element.schema))) {
          result.unsupported.push(`an array of values ("${full}")`);
          break;
        }
        element = element.$isMongooseArray
          ? (element.embeddedSchemaType ?? element.caster)
          : undefined;
      }
    }
    if (type.instance === 'Map') {
      const value = type.$__schemaType;
      if (isMarked(value) || (value?.schema && hasSensitiveField(value.schema))) {
        result.unsupported.push(`a Map ("${full}")`);
      }
    }
  });
  const hasOwn = result.paths.length > before;
  for (const child of discriminatorSchemas(schema)) {
    if (hasOwn || hasSensitiveField(child)) {
      result.unsupported.push(
        prefix ? `a discriminator of "${prefix.slice(0, -1)}"` : 'a discriminator',
      );
    }
  }
  return result;
}

/**
 * The schema's sensitive paths (fields made with `sensitiveField()`), as dotted paths without
 * array positions, at any depth: `bankAccountNumber`, `profile.tin`, `accounts.number` for an
 * array of subdocuments. Read-only: it doesn't check the shapes (the guard does that when the
 * model is defined). The audit log uses it to hide these fields in snapshots.
 */
export function sensitivePathsOf(schema: Schema): string[] {
  return [...inspectSchema(schema).paths];
}

/** True when the schema has a sensitive field anywhere, in any shape. */
function hasSensitiveField(schema: Schema): boolean {
  const { paths, unsupported } = inspectSchema(schema);
  return paths.length > 0 || unsupported.length > 0;
}

/** A dotted update key without array positions (`items.0.acct`, `items.$[].acct` → `items.acct`). */
function normalize(key: string): string {
  return key
    .split('.')
    .filter((part) => !/^\d+$/.test(part) && !part.startsWith('$'))
    .join('.');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** A Mongoose document or subdocument as a plain object, for checking; anything else unchanged. */
function plain(value: unknown): unknown {
  if (typeof value === 'object' && value !== null && '$__' in value) {
    return (value as unknown as { toObject(options: object): unknown }).toObject({
      depopulate: true,
      getters: false,
      virtuals: false,
      transform: false,
    });
  }
  return value;
}

class Checker {
  private readonly paths: Set<string>;
  constructor(
    paths: string[],
    /** Lean inserts aren't cast by Mongoose, so only a subtype 6 Binary is stored correctly. */
    private readonly strictBinary = false,
  ) {
    this.paths = new Set(paths);
  }

  /** A sensitive path, to name in a refusal that isn't about one field. */
  get first(): string {
    return this.paths.values().next().value ?? '';
  }

  private isParent(path: string): boolean {
    for (const sensitive of this.paths) if (sensitive.startsWith(`${path}.`)) return true;
    return false;
  }

  /** True for a path inside a sensitive field (`acct.x`), which would store a readable value. */
  private isBelow(path: string): boolean {
    for (const sensitive of this.paths) if (path.startsWith(`${sensitive}.`)) return true;
    return false;
  }

  /** True when a write to `path` could change a sensitive field. */
  private touches(path: string): boolean {
    return this.paths.has(path) || this.isParent(path) || this.isBelow(path);
  }

  private checkValue(path: string, value: unknown): void {
    // Absent: nothing is stored (Mongoose drops undefined keys from updates and documents).
    if (value === undefined) return;
    if (value === null) throw nullRefusal(path);
    const ok = this.strictBinary
      ? value instanceof mongo.Binary && isEncryptedValue(value)
      : isEncryptedValue(value);
    if (!ok) throw new SensitiveFieldNotEncryptedError(path);
  }

  /** Checks a document (or part of one) found at `prefix`. */
  document(value: unknown, prefix = ''): void {
    const current = plain(value);
    if (Array.isArray(current)) {
      for (const element of current) this.document(element, prefix);
      return;
    }
    if (!isPlainObject(current)) return;
    for (const [key, child] of Object.entries(current)) {
      const path = normalize(prefix ? `${prefix}.${key}` : key);
      if (this.paths.has(path)) {
        // A sensitive field holds one value; an array there is never ciphertext.
        if (Array.isArray(child)) throw new SensitiveFieldNotEncryptedError(path);
        this.checkValue(path, plain(child));
      } else if (this.isBelow(path)) {
        throw new SensitiveFieldNotEncryptedError(path);
      } else if (this.isParent(path)) {
        this.document(child, path);
      }
    }
  }

  /** Checks an update document or a replacement. */
  update(update: unknown): void {
    const current = plain(update);
    if (Array.isArray(current)) return this.pipeline(current);
    if (!isPlainObject(current)) return;
    const replacement: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(current)) {
      if (!key.startsWith('$')) {
        replacement[key] = value;
      } else if (SETTING_OPERATORS.has(key)) {
        this.document(value);
      } else if (REMOVING_OPERATORS.has(key) || !isPlainObject(value)) {
        continue;
      } else if (ADDING_OPERATORS.has(key)) {
        for (const [field, added] of Object.entries(value)) {
          this.added(normalize(field), added, key);
        }
      } else if (key === '$rename') {
        // The new name is the value: check both ends.
        for (const [from, to] of Object.entries(value)) {
          for (const path of [normalize(from), normalize(String(to))]) {
            if (this.touches(path)) throw operatorRefusal(path, key);
          }
        }
      } else {
        for (const field of Object.keys(value)) {
          const path = normalize(field);
          if (this.touches(path)) throw operatorRefusal(path, key);
        }
      }
    }
    this.document(replacement);
  }

  /** $push/$addToSet: only whole subdocuments into an array of them, checked like inserts. */
  private added(path: string, value: unknown, operator: string): void {
    if (this.paths.has(path) || this.isBelow(path)) throw operatorRefusal(path, operator);
    if (!this.isParent(path)) return;
    const current = plain(value);
    const each = isPlainObject(current) && '$each' in current ? current.$each : [current];
    for (const element of Array.isArray(each) ? each : [each]) this.document(element, path);
  }

  /**
   * An upsert's filter: MongoDB copies its equality conditions into the record it inserts, so a
   * sensitive field (or a parent object holding one) must not be named in it, also not through
   * `$in`, `$nin`, `$all` or `$elemMatch` on the parent.
   */
  upsertFilter(filter: unknown, prefix = ''): void {
    const current = plain(filter);
    if (Array.isArray(current)) {
      for (const element of current) this.upsertFilter(element, prefix);
      return;
    }
    if (!isPlainObject(current)) return;
    for (const [key, value] of Object.entries(current)) {
      if (key.startsWith('$')) {
        if (FILTER_OPERATORS_TO_CHECK.has(key)) this.upsertFilter(value, prefix);
        continue;
      }
      const path = normalize(prefix ? `${prefix}.${key}` : key);
      if (this.paths.has(path) || this.isBelow(path)) throw upsertFilterRefusal(path);
      if (this.isParent(path)) this.upsertFilter(value, path);
    }
  }

  private pipeline(stages: unknown[]): void {
    for (const stage of stages) {
      if (!isPlainObject(stage)) continue;
      for (const [name, spec] of Object.entries(stage)) {
        if (!PIPELINE_WRITING_STAGES.has(name)) continue;
        if (name === '$replaceWith' || name === '$replaceRoot') throw pipelineRefusal(this.first);
        const fields = Array.isArray(spec)
          ? spec.map(String)
          : typeof spec === 'string'
            ? [spec]
            : isPlainObject(spec)
              ? Object.keys(spec)
              : [];
        for (const field of fields) {
          const path = normalize(field);
          if (this.touches(path)) throw pipelineRefusal(path);
        }
      }
    }
  }

  /** Refuses the options that let a write past the schema or the database validator. */
  options(options: unknown): void {
    if (!isPlainObject(options)) return;
    if (options.strict === false) throw optionRefusal(this.first, 'strict: false');
    if (options.bypassDocumentValidation) {
      throw optionRefusal(this.first, 'bypassDocumentValidation');
    }
  }
}

interface BulkUpdate {
  filter?: unknown;
  update?: unknown;
  replacement?: unknown;
  upsert?: boolean;
  strict?: unknown;
}

interface BulkOperation {
  insertOne?: { document?: unknown; strict?: unknown };
  updateOne?: BulkUpdate;
  updateMany?: BulkUpdate;
  replaceOne?: BulkUpdate;
}

// Schemas found to have a sensitive field, for the aggregate check of any model.
const sensitiveSchemas = new WeakMap<Schema, boolean>();

function schemaIsSensitive(schema: Schema): boolean {
  let known = sensitiveSchemas.get(schema);
  if (known === undefined) {
    known = hasSensitiveField(schema);
    sensitiveSchemas.set(schema, known);
  }
  return known;
}

/** The collections an aggregate pipeline writes to with `$out` or `$merge`. */
function outputCollections(pipeline: unknown[]): string[] {
  const names: string[] = [];
  const nameOf = (target: unknown): string | undefined => {
    if (typeof target === 'string') return target;
    if (isPlainObject(target) && typeof target.coll === 'string') return target.coll;
    return undefined;
  };
  for (const stage of pipeline) {
    if (!isPlainObject(stage)) continue;
    const out = nameOf(stage.$out);
    if (out) names.push(out);
    const merge = stage.$merge;
    const into = nameOf(isPlainObject(merge) ? merge.into : merge);
    if (into) names.push(into);
  }
  return names;
}

/** A sensitive path of a registered model stored in `collection`, or undefined for none. */
function sensitiveCollectionPath(collection: string): string | undefined {
  for (const name of mongoose.modelNames()) {
    const model = mongoose.model(name);
    if (model.collection.collectionName !== collection) continue;
    const schema = model.schema as unknown as Schema;
    if (schemaIsSensitive(schema)) return inspectSchema(schema).paths[0] ?? collection;
  }
  return undefined;
}

interface AggregateLike {
  options?: Record<string, unknown>;
  pipeline(): unknown[];
}

/**
 * The plugin. Refuses unsupported shapes, and adds the checks to schemas that have a sensitive
 * field; other schemas get only the aggregate check for `$out`/`$merge` into a sensitive
 * collection with `bypassDocumentValidation`.
 */
export function sensitiveFieldGuard(schema: Schema): void {
  const { paths, unsupported, notStrict } = inspectSchema(schema);
  if (unsupported.length) throw new SensitiveFieldShapeError(unsupported[0] as string);
  if (paths.length && notStrict.length) {
    throw new SensitiveFieldShapeError(`a schema with strict: false (${notStrict[0] as string})`);
  }
  sensitiveSchemas.set(schema, paths.length > 0);

  if (!paths.length) {
    schema.pre('aggregate', function () {
      const aggregate = this as unknown as AggregateLike;
      if (!aggregate.options?.bypassDocumentValidation) return;
      for (const collection of outputCollections(aggregate.pipeline())) {
        const path = sensitiveCollectionPath(collection);
        if (path) throw optionRefusal(path, 'bypassDocumentValidation');
      }
    });
    return;
  }
  const checker = new Checker(paths);

  schema.pre([...QUERY_WRITES], { document: false, query: true }, function () {
    checker.options({
      strict: this.mongooseOptions().strict,
      // eslint-disable-next-line no-restricted-syntax -- reads the option to refuse it, never sets it
      bypassDocumentValidation: this.getOptions().bypassDocumentValidation,
    });
    checker.update(this.getUpdate());
    if (this.getOptions().upsert) checker.upsertFilter(this.getFilter());
    this.setOptions({ runValidators: true });
  });

  schema.pre('bulkWrite', function (ops: unknown, options?: unknown) {
    checker.options(options);
    for (const operation of ops as BulkOperation[]) {
      if (operation.insertOne) {
        checker.options({ strict: operation.insertOne.strict });
        checker.document(operation.insertOne.document);
      }
      for (const write of [operation.updateOne, operation.updateMany, operation.replaceOne]) {
        if (!write) continue;
        checker.options({ strict: write.strict });
        checker.update(write.update ?? write.replacement);
        if (write.upsert) checker.upsertFilter(write.filter);
      }
    }
  });

  const strictChecker = new Checker(paths, true);
  schema.pre('insertMany', function (docs: unknown) {
    for (const doc of Array.isArray(docs) ? docs : [docs]) {
      const isDocument = typeof doc === 'object' && doc !== null && '$__' in doc;
      (isDocument ? checker : strictChecker).document(doc);
    }
  });

  // Runs with or without validation, on new and existing documents. Reads the values as stored on
  // the document, after the setter (so the empty placeholder fails here too).
  schema.pre('save', function () {
    const state = (this as unknown as { $__?: { strictMode?: unknown } }).$__;
    if (state?.strictMode === false) throw optionRefusal(checker.first, 'strict: false');
    checker.document(
      this.toObject({ depopulate: true, getters: false, virtuals: false, transform: false }),
    );
  });

  // An aggregate can't write a field of this collection's documents in place, but its $out or
  // $merge could write anywhere: only the database validator stops a plain value there, so it
  // must not be bypassed.
  schema.pre('aggregate', function () {
    const aggregate = this as unknown as AggregateLike;
    if (aggregate.options?.bypassDocumentValidation) {
      throw optionRefusal(checker.first, 'bypassDocumentValidation');
    }
  });
}

type DiscriminatorMethod = (
  this: unknown,
  name: unknown,
  schema: unknown,
  ...rest: unknown[]
) => unknown;

/**
 * Refuses a discriminator that involves a sensitive field, when it is defined. Global plugins don't
 * run on a discriminator's own schema, so the plugin can't catch this itself. Covers
 * `Model.discriminator`, `Schema#discriminator` and the embedded discriminators of subdocument and
 * document array paths.
 */
function refuseSensitiveDiscriminators(): void {
  const schemaOf = (self: unknown) => (self as { schema?: unknown }).schema;
  const targets: [object, (self: unknown) => unknown][] = [
    [mongoose.Model, schemaOf],
    [mongoose.Schema.prototype, (self) => self],
    [mongoose.Schema.Types.DocumentArray.prototype, schemaOf],
    [mongoose.Schema.Types.Subdocument.prototype, schemaOf],
  ];
  for (const [target, baseOf] of targets) {
    const holder = target as { discriminator?: DiscriminatorMethod };
    const original = holder.discriminator;
    if (typeof original !== 'function') continue;
    holder.discriminator = function (this: unknown, name, child, ...rest) {
      const base = baseOf(this);
      if (
        (base instanceof mongoose.Schema && hasSensitiveField(base)) ||
        (child instanceof mongoose.Schema && hasSensitiveField(child))
      ) {
        throw new SensitiveFieldShapeError(`a discriminator ("${String(name)}")`);
      }
      return original.call(this, name, child, ...rest);
    };
  }
}

const globalForGuard = globalThis as typeof globalThis & { __pulseSensitiveGuard?: boolean };

/**
 * Registers the guard as a global Mongoose plugin, and the discriminator check, once per process.
 */
export function registerSensitiveFieldGuard(): void {
  if (globalForGuard.__pulseSensitiveGuard) return;
  globalForGuard.__pulseSensitiveGuard = true;
  mongoose.plugin(sensitiveFieldGuard);
  refuseSensitiveDiscriminators();
}
