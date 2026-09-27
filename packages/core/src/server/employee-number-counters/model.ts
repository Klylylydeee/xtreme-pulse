import { type Query, Schema, type Types, type UpdateQuery } from 'mongoose';
import { baseSchemaPlugin, defineModel } from '@pulse/db';
import { EMPLOYEE_SEQUENCE_MAX } from '../../employee-number';
import { guardWrites, hasOnlyKeys } from '../write-guards';

// Spec: docs/modules/core.md#employee-number-company-id — one counter per hire year. Numbers are
// issued with an atomic `$inc` (upsert), and a manually entered company ID raises the year's
// counter with `$max` so its sequence is never issued again. The issuing service comes in build
// step 1.5; these guards already hold every other write off.

export interface EmployeeNumberCounterRecord {
  _id: Types.ObjectId;
  /** The hire year. */
  year: number;
  /** The last sequence issued or entered; 0 before the first. At most 99. */
  lastSequence: number;
  createdAt: Date;
  updatedAt: Date;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
}

const ALLOWED_SET: ReadonlySet<string> = new Set(['updatedAt', 'updatedBy']);
// `__v`: Mongoose adds `$setOnInsert: { __v: 0 }` to an `updateOne` upsert.
const ALLOWED_SET_ON_INSERT: ReadonlySet<string> = new Set([
  '__v',
  'createdAt',
  'updatedAt',
  'createdBy',
  'updatedBy',
]);

function isValidSequence(value: unknown): boolean {
  return (
    Number.isInteger(value) && (value as number) >= 1 && (value as number) <= EMPLOYEE_SEQUENCE_MAX
  );
}

/** True when the query only matches a counter below 99, as every increment must. */
function isBelowMaximum(query: Query<unknown, unknown>): boolean {
  const condition: unknown = query.getFilter().lastSequence;
  return (
    typeof condition === 'object' &&
    condition !== null &&
    Object.keys(condition).length === 1 &&
    (condition as Record<string, unknown>).$lt === EMPLOYEE_SEQUENCE_MAX
  );
}

/**
 * True when the query matches one year's counter by equality (`year: 2027`). An upsert takes the
 * year from it, so without it the upsert would insert a counter with no year.
 */
function pinsYear(query: Query<unknown, unknown>): boolean {
  const year: unknown = query.getFilter().year;
  return Number.isInteger(year) && (year as number) >= 1000 && (year as number) <= 9999;
}

/**
 * True for exactly `{ $inc: { lastSequence: 1 } }` on a filter with `year: <number>` and
 * `lastSequence: { $lt: 99 }`, or `{ $max: { lastSequence: n } }` (n from 1 to 99, with
 * `year: <number>` in the filter when it is an upsert), plus timestamp and creator fields.
 *
 * The bound is in the filter because Mongoose's update validators don't run on `$inc`, so the
 * schema's `max` can't stop a 100th number. With it, a full year's counter doesn't match, and the
 * upsert's attempt to insert a second counter for that year fails on the unique index.
 */
function isCounterUpdate(update: UpdateQuery<unknown>, query: Query<unknown, unknown>): boolean {
  const { $inc, $max, $set = {}, $setOnInsert = {}, ...rest } = update as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return false;
  if (!hasOnlyKeys($set, ALLOWED_SET) || !hasOnlyKeys($setOnInsert, ALLOWED_SET_ON_INSERT)) {
    return false;
  }
  const increment = $inc as Record<string, unknown> | undefined;
  const raise = $max as Record<string, unknown> | undefined;
  if (increment !== undefined && raise === undefined) {
    return (
      hasOnlyKeys(increment, new Set(['lastSequence'])) &&
      increment.lastSequence === 1 &&
      pinsYear(query) &&
      isBelowMaximum(query)
    );
  }
  if (raise !== undefined && increment === undefined) {
    return (
      hasOnlyKeys(raise, new Set(['lastSequence'])) &&
      isValidSequence(raise.lastSequence) &&
      (!query.getOptions().upsert || pinsYear(query))
    );
  }
  return false;
}

const counterSchema = new Schema<EmployeeNumberCounterRecord>({
  year: { type: Number, required: true, immutable: true, min: 1000, max: 9999 },
  lastSequence: { type: Number, required: true, default: 0, min: 0, max: EMPLOYEE_SEQUENCE_MAX },
});
counterSchema.index({ year: 1 }, { unique: true });
// Counters are never deleted: a removed counter would issue its numbers again.
counterSchema.plugin(baseSchemaPlugin, { softDelete: false });
guardWrites(counterSchema, {
  message: 'Employee number counters only change through the employee number service.',
  allowUpdate: isCounterUpdate,
});

export const EmployeeNumberCounterModel = defineModel(
  'EmployeeNumberCounter',
  counterSchema,
  'employeeNumberCounters',
);
