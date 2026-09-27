import { Schema, type ClientSession, type Query, type Types } from 'mongoose';

// Spec: docs/DATA_MODEL.md#general — every document has createdAt, updatedAt, createdBy and
// updatedBy; business records are soft-deleted (`deletedAt`), with no hard deletes outside admin
// tooling.

/** Fields the base plugin adds to every schema. */
export interface BaseFields {
  createdAt: Date;
  updatedAt: Date;
  /** The user who created the record, or null for a record the system created. */
  createdBy: Types.ObjectId | null;
  /** The user who last changed the record, or null for a system change. */
  updatedBy: Types.ObjectId | null;
}

/** Field the plugin adds when soft delete is on. */
export interface SoftDeleteFields {
  /** When the record was soft-deleted; null while it is live. */
  deletedAt: Date | null;
}

/** Instance methods the plugin adds when soft delete is on. */
export interface SoftDeleteMethods {
  /**
   * Marks the record deleted (sets `deletedAt` and `updatedBy`) and saves it. It then drops out of
   * normal queries. Pass the session when this runs inside a transaction.
   */
  softDelete(actorId: Types.ObjectId | null, options?: { session?: ClientSession }): Promise<void>;
}

export interface BaseSchemaPluginOptions {
  /**
   * Required, with no default, so every schema states its choice and an append-only record can't
   * get a `softDelete()` method by accident.
   *
   * - `true`: business records that can be removed (soft delete adds `deletedAt` and leaves
   *   deleted records out of normal queries).
   * - `false`: records that are never deleted. That includes every append-only record under
   *   ADR 0007 (docs/adr/0007-append-only-records-and-derived-balances.md) and
   *   docs/DATA_MODEL.md#locked-and-append-only-records: journal entries, stock movements, leave
   *   and offset entries, compensation (salary and allowance) history, finalized payroll runs and
   *   payslips, audit log entries and employee records. Also counters.
   */
  softDelete: boolean;
}

declare module 'mongoose' {
  interface QueryOptions {
    /** Include soft-deleted records in this query. For admin tooling and restores. */
    withDeleted?: boolean;
  }
  interface AggregateOptions {
    /** Include soft-deleted records in this aggregation. For admin tooling and restores. */
    withDeleted?: boolean;
  }
}

// Reads and updates that should skip soft-deleted records. Hard deletes (deleteOne/deleteMany)
// are left alone: they are admin tooling only. `estimatedDocumentCount` takes no filter, so it
// always counts every record; use `countDocuments` instead.
//
// Populate runs these queries too, so a reference to a soft-deleted record populates as null.
// Populate with `options: { withDeleted: true }` where a screen must still show it (for example
// the client name on an old invoice).
const FILTERED_QUERIES = [
  'countDocuments',
  'distinct',
  'find',
  'findOne',
  'findOneAndDelete',
  'findOneAndReplace',
  'findOneAndUpdate',
  'replaceOne',
  'updateMany',
  'updateOne',
] as const;

// Aggregation stages that must be first in a pipeline.
const FIRST_ONLY_STAGES = new Set(['$geoNear', '$search', '$vectorSearch']);
// First stages that return metadata rather than the collection's records; left unfiltered.
const METADATA_STAGES = new Set(['$collStats', '$indexStats', '$searchMeta', '$changeStream']);

function excludeDeleted(this: Query<unknown, unknown>): void {
  const options = this.getOptions();
  if (options.withDeleted) return;
  // A query that already filters on deletedAt (for example `{ deletedAt: { $ne: null } }` to list
  // deleted records) keeps its own condition.
  if (Object.hasOwn(this.getFilter(), 'deletedAt')) return;
  // Upserts are refused unless the caller decides about deleted records. Adding `deletedAt: null`
  // would miss a soft-deleted match and insert a duplicate; dropping the filter would silently
  // update a deleted record. Either breaks docs/DATA_MODEL.md#general, so the service must choose:
  // pass `withDeleted: true` (and restore or reject a deleted match itself) or put `deletedAt` in
  // the filter.
  if (options.upsert) {
    throw new Error(
      'Upsert on a soft-delete collection needs an explicit choice: pass { withDeleted: true } or filter on deletedAt.',
    );
  }
  this.where({ deletedAt: null });
}

/**
 * The base schema plugin. Apply it to every schema:
 *
 * ```ts
 * schema.plugin(baseSchemaPlugin, { softDelete: true });    // records that can be removed
 * schema.plugin(baseSchemaPlugin, { softDelete: false });   // append-only records, counters
 * ```
 *
 * Services set `createdBy` on create and `updatedBy` on every change; on create, `updatedBy`
 * defaults to `createdBy`.
 */
export function baseSchemaPlugin(schema: Schema, options: BaseSchemaPluginOptions): void {
  if (typeof options?.softDelete !== 'boolean') {
    throw new Error('baseSchemaPlugin needs { softDelete: true } or { softDelete: false }.');
  }
  const { softDelete } = options;

  schema.set('timestamps', true);
  schema.add({
    createdBy: { type: Schema.Types.ObjectId, default: null, immutable: true },
    updatedBy: { type: Schema.Types.ObjectId, default: null },
  });

  schema.pre('save', function () {
    if (this.isNew && this.get('updatedBy') == null) {
      this.set('updatedBy', this.get('createdBy'));
    }
  });

  if (!softDelete) return;

  schema.add({ deletedAt: { type: Date, default: null, index: true } });

  schema.pre([...FILTERED_QUERIES], excludeDeleted);

  schema.pre('aggregate', function () {
    if (this.options.withDeleted) return;
    const pipeline = this.pipeline();
    const firstStage = Object.keys(pipeline[0] ?? {})[0];
    if (firstStage && METADATA_STAGES.has(firstStage)) return;
    // $geoNear, $search and $vectorSearch must stay first, so filter right after them.
    const at = firstStage && FIRST_ONLY_STAGES.has(firstStage) ? 1 : 0;
    pipeline.splice(at, 0, { $match: { deletedAt: null } });
  });

  schema.method(
    'softDelete',
    async function (
      actorId: Types.ObjectId | null,
      { session }: { session?: ClientSession } = {},
    ): Promise<void> {
      this.set({ deletedAt: new Date(), updatedBy: actorId });
      await this.save({ session });
    },
  );
}
