import { Schema, type ClientSession } from 'mongoose';
import { baseSchemaPlugin, defineModel } from '@pulse/db';
import { businessYear, now } from '../dates';
import { assertDocumentPrefix, formatDocumentNumber } from '../document-number';
import { guardWrites, hasOnlyKeys } from './write-guards';

// Spec: docs/DATA_MODEL.md#document-numbers — business documents are numbered `PREFIX-YYYY-NNNN`
// from atomic per-prefix, per-year counters, so two records can never share a number.
//
// The number is taken inside the caller's transaction, together with the insert of the document
// that carries it. If that transaction aborts, the counter increment is rolled back with it, so an
// aborted save leaves no gap. Two transactions taking a number at once conflict on the counter
// record; MongoDB aborts one with a TransientTransactionError and `withTransaction` retries it.
// Verified with 60 concurrent allocations, with and without aborts: no duplicates and no gaps.

interface DocumentNumberCounter {
  /** The document number prefix, for example `QT`. */
  prefix: string;
  /** The Manila calendar year the numbers belong to. */
  year: number;
  /** The last sequence issued; 0 before the first. */
  lastSequence: number;
}

const ALLOWED_SET = new Set(['updatedAt', 'updatedBy']);
const ALLOWED_SET_ON_INSERT = new Set(['createdAt', 'updatedAt', 'createdBy', 'updatedBy']);

/** True for exactly `{ $inc: { lastSequence: 1 } }`, plus timestamp and creator fields. */
function isIncrementOnly(update: Record<string, unknown>): boolean {
  const { $inc, $set = {}, $setOnInsert = {}, ...rest } = update;
  return (
    Object.keys(rest).length === 0 &&
    typeof $inc === 'object' &&
    $inc !== null &&
    Object.keys($inc).length === 1 &&
    ($inc as Record<string, unknown>).lastSequence === 1 &&
    hasOnlyKeys($set, ALLOWED_SET) &&
    hasOnlyKeys($setOnInsert, ALLOWED_SET_ON_INSERT)
  );
}

const counterSchema = new Schema<DocumentNumberCounter>({
  prefix: { type: String, required: true, immutable: true },
  year: { type: Number, required: true, immutable: true },
  lastSequence: { type: Number, required: true, default: 0, min: 0 },
});
counterSchema.index({ prefix: 1, year: 1 }, { unique: true });
// Counters are never deleted: a removed counter would issue its numbers again.
counterSchema.plugin(baseSchemaPlugin, { softDelete: false });
// The only change a counter ever takes is the atomic +1 in nextDocumentNumber (plus the timestamp
// and creator fields the base plugin and upsert set). Anything else could reissue a number.
guardWrites(counterSchema, {
  message: 'Document number counters only change through nextDocumentNumber.',
  allowUpdate: isIncrementOnly,
});

const DocumentNumberCounterModel = defineModel(
  'DocumentNumberCounter',
  counterSchema,
  'documentNumberCounters',
);

export interface NextDocumentNumberOptions {
  /**
   * The transaction that saves the document. Required: the number must commit or roll back
   * together with the document that carries it.
   */
  session: ClientSession;
  /** The instant whose Manila year the number belongs to. Defaults to now. */
  at?: Date;
}

export interface IssuedDocumentNumber {
  /** The formatted number, for example `QT-2026-0012`. */
  number: string;
  prefix: string;
  year: number;
  sequence: number;
}

/**
 * Issues the next document number for `prefix` in the Manila year of `at`, for example
 * `QT-2026-0012`. Call it inside `withTransaction`, in the same transaction that inserts the
 * document, and pass that session.
 *
 * ```ts
 * await withTransaction(async (session) => {
 *   const { number } = await nextDocumentNumber('QT', { session });
 *   await QuotationModel.create([{ number, ... }], { session });
 * });
 * ```
 *
 * Where the spec makes the series a setting (the invoice series), read the prefix from that
 * setting and pass it here.
 */
export async function nextDocumentNumber(
  prefix: string,
  { session, at = now() }: NextDocumentNumberOptions,
): Promise<IssuedDocumentNumber> {
  assertDocumentPrefix(prefix);
  if (typeof session?.inTransaction !== 'function' || !session.inTransaction()) {
    throw new Error(
      'nextDocumentNumber must run inside withTransaction, in the transaction that saves the document.',
    );
  }
  const year = businessYear(at);

  // The first number of a year creates the counter (upsert). Two transactions creating it at once
  // conflict like any other pair, and the loser is retried.
  const counter = await DocumentNumberCounterModel.findOneAndUpdate(
    { prefix, year },
    { $inc: { lastSequence: 1 }, $setOnInsert: { createdBy: null, updatedBy: null } },
    { session, upsert: true, returnDocument: 'after', runValidators: true },
  ).lean();
  if (!counter) throw new Error(`The ${prefix} ${year} document counter is missing.`);

  const sequence = counter.lastSequence;
  return { number: formatDocumentNumber({ prefix, year, sequence }), prefix, year, sequence };
}
