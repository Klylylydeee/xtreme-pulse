import type { Aggregate, Query, Schema, UpdateQuery } from 'mongoose';

// Guards for records that are never edited or deleted (docs/DATA_MODEL.md#locked-and-append-only-records).
// They refuse every Mongoose write path that could change or remove an existing record: query
// updates and deletes, replacements, `bulkWrite` (which `bulkSave` also uses) and `save()` on a
// loaded document. Inserts (`create`, `insertMany`, `save()` on a new document) still work.
// Aggregations run on a guarded model may not use `$merge` or `$out`, which can overwrite or
// replace records.
// The raw driver collection bypasses Mongoose and so these guards; module code never uses it.
// Also deliberately left unblocked: queries with `{ middleware: false }`, `connection.bulkWrite`,
// and `$merge`/`$out` from an aggregation on another model into a guarded collection.

// updateMany is never allowed: an allowed update changes one record at a time.
const UPDATES = ['updateOne', 'findOneAndUpdate'] as const;
const REPLACES_AND_DELETES = [
  'updateMany',
  'replaceOne',
  'findOneAndReplace',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
] as const;

export interface WriteGuardOptions {
  /** The error message for a refused write. It should say what to do instead. */
  message: string;
  /**
   * Returns true for the one update shape the owning service is allowed to make (for example the
   * counter's atomic `$inc`), through updateOne or findOneAndUpdate. Omit it to refuse every update.
   */
  allowUpdate?: (update: UpdateQuery<unknown>, query: Query<unknown, unknown>) => boolean;
}

/** Makes the schema's records insert-only, apart from an optional allowed update. */
export function guardWrites(schema: Schema, { message, allowUpdate }: WriteGuardOptions): void {
  schema.pre([...REPLACES_AND_DELETES], { document: false, query: true }, function () {
    throw new Error(message);
  });
  schema.pre(
    [...UPDATES],
    { document: false, query: true },
    function (this: Query<unknown, unknown>) {
      const update = this.getUpdate();
      if (allowUpdate && update && !Array.isArray(update) && allowUpdate(update, this)) return;
      throw new Error(message);
    },
  );
  // `deleteOne()` and `updateOne()` called on a loaded document.
  schema.pre(['deleteOne', 'updateOne'], { document: true, query: false }, function () {
    throw new Error(message);
  });
  schema.pre('bulkWrite', function (ops) {
    // Only inserts. Updates go through the guarded query path above instead.
    if (ops.some((op) => !('insertOne' in op))) throw new Error(message);
  });
  schema.pre('save', function () {
    if (!this.isNew) throw new Error(message);
  });
  schema.pre('aggregate', function (this: Aggregate<unknown>) {
    const writes = this.pipeline().some((stage) => '$merge' in stage || '$out' in stage);
    if (writes) throw new Error(message);
  });
}

/** True when `value` is an object whose keys are all in `allowed`. For `allowUpdate` checks. */
export function hasOnlyKeys(value: unknown, allowed: ReadonlySet<string>): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}
