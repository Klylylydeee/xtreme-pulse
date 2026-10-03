import type { Schema } from 'mongoose';
import { bytesOf, isEncryptedValue } from '../encryption/format';
import { sensitivePathsOf } from '../encryption/guard';

// Redacted snapshots for the audit log (SECURITY.md#audit-logging, docs/modules/core.md#audit-log).
// An entry keeps the whole record before and after a change, so everything that must never be
// logged is taken out here, before the entry is written:
//
// - fields with `select: false` in the schema (`passwordHash` and the like) are left out;
// - sensitive paths (`sensitiveField()`, at any depth) become HIDDEN_SENSITIVE;
// - as a backstop, at any depth and with or without a schema: encrypted values, Buffers and
//   Binaries, and any key that looks like a secret (SECRET_KEY) become HIDDEN_REDACTED. A boolean
//   or null under such a key is kept, since it can't hold a secret (`mustChangePassword`).
//
// When both sides of an update are snapshotted together (`snapshotsForAudit`), a sensitive field
// whose stored encrypted value differs between before and after (or that is new) is marked
// HIDDEN_SENSITIVE_CHANGED in `after`. Only the stored bytes are compared, in memory; neither the
// ciphertext nor anything derived from it goes into the snapshot.
//
// ObjectIds become hex strings and dates ISO 8601 strings, so a snapshot is plain JSON. Sizes are
// capped (the limits below), with markers where something was cut, and every cap is idempotent:
// redacting a snapshot again changes nothing.

/** Marks a sensitive field in a snapshot. */
export const HIDDEN_SENSITIVE = Object.freeze({ $hidden: 'sensitive' as const });
/**
 * Marks a sensitive field whose stored value changed (in `after`, from `snapshotsForAudit`). The
 * value itself stays hidden.
 */
export const HIDDEN_SENSITIVE_CHANGED = Object.freeze({
  $hidden: 'sensitive' as const,
  changed: true as const,
});
/** Marks a value the backstop removed. */
export const HIDDEN_REDACTED = Object.freeze({ $hidden: 'redacted' as const });

/** Keys whose values are never logged. */
export const SECRET_KEY = /pass(word)?|hash|secret|token|apikey|otp/i;

/** Strings longer than this are cut (marker included). */
export const SNAPSHOT_STRING_MAX = 2000;
/** Arrays keep this many items at most (the last one a marker when items were cut). */
export const SNAPSHOT_ARRAY_MAX = 100;
/** Deeper nesting is replaced by a marker. */
export const SNAPSHOT_DEPTH_MAX = 20;
/** A whole snapshot larger than this, serialized as JSON (UTF-8 bytes), becomes a marker. */
export const SNAPSHOT_BYTES_MAX = 64 * 1024;

const STRING_CUT_MARKER = '… [truncated]';

/** A redacted snapshot: plain JSON values only. */
export type AuditSnapshot = Record<string, unknown>;

interface SchemaRules {
  /** Sensitive paths, dotted, without array positions. */
  sensitive: ReadonlySet<string>;
  /** Paths with `select: false` (not sensitive ones; those are marked instead). */
  omitted: ReadonlySet<string>;
}

const NO_RULES: SchemaRules = { sensitive: new Set(), omitted: new Set() };
const rulesCache = new WeakMap<Schema, SchemaRules>();

interface SchemaTypeLike {
  options?: { select?: unknown };
  schema?: Schema;
}

function collectSelectFalse(schema: Schema, prefix: string, out: Set<string>): void {
  schema.eachPath((path, schemaType) => {
    const type = schemaType as unknown as SchemaTypeLike;
    const full = prefix + path;
    if (type.options?.select === false) out.add(full);
    // Subdocuments and arrays of subdocuments: their own paths, under this one.
    if (type.schema) collectSelectFalse(type.schema, `${full}.`, out);
  });
}

function rulesFor(schema: Schema): SchemaRules {
  let rules = rulesCache.get(schema);
  if (!rules) {
    const sensitive = new Set(sensitivePathsOf(schema));
    const omitted = new Set<string>();
    collectSelectFalse(schema, '', omitted);
    for (const path of sensitive) omitted.delete(path);
    rules = { sensitive, omitted };
    rulesCache.set(schema, rules);
  }
  return rules;
}

const OMIT = Symbol('omit');
/** No other side to compare with: a single snapshot, or the `before` side. */
const NO_COMPARE = Symbol('no-compare');
/** The same place in the other side's record (undefined: absent there), or NO_COMPARE. */
type Counterpart = unknown;

/**
 * True when a sensitive value differs from the other side's (undefined or null there: the field is
 * new). Compares the stored bytes only; a value whose bytes can't be read counts as changed, which
 * reveals nothing. Encryption is randomized, so writing the same value again also counts.
 */
function sensitiveChanged(value: unknown, other: unknown): boolean {
  if (other === undefined || other === null) return true;
  const mine = bytesOf(value);
  const theirs = bytesOf(other);
  return !mine || !theirs || !mine.equals(theirs);
}

/** The child of `other` under `key`, for comparing; absent when `other` isn't an object. */
function childOf(other: Counterpart, key: string): Counterpart {
  if (other === NO_COMPARE) return NO_COMPARE;
  const parent = plain(other);
  if (parent instanceof Map) return parent.get(key) as unknown;
  if (isPlainObject(parent)) return parent[key];
  return undefined;
}

/** The item of `other` at `index`, for comparing; absent when `other` isn't an array. */
function itemOf(other: Counterpart, index: number): Counterpart {
  if (other === NO_COMPARE) return NO_COMPARE;
  const parent = plain(other);
  return Array.isArray(parent) ? (parent[index] as unknown) : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function bsonTypeOf(value: object): string | undefined {
  const type = (value as { _bsontype?: unknown })._bsontype;
  return typeof type === 'string' ? type : undefined;
}

function cutString(value: string): string {
  if (value.length <= SNAPSHOT_STRING_MAX) return value;
  return value.slice(0, SNAPSHOT_STRING_MAX - STRING_CUT_MARKER.length) + STRING_CUT_MARKER;
}

/** A Mongoose document or subdocument as a plain object; anything else unchanged. */
function plain(value: unknown): unknown {
  if (typeof value === 'object' && value !== null && '$__' in value) {
    return (value as unknown as { toObject(options: object): unknown }).toObject({
      depopulate: true,
      getters: false,
      virtuals: false,
      transform: false,
      flattenMaps: true,
    });
  }
  return value;
}

function redactObject(
  object: Record<string, unknown>,
  path: string,
  depth: number,
  rules: SchemaRules,
  other: Counterpart,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(object)) {
    if (child === undefined) continue;
    // Mongoose's version key says nothing about the change.
    if (depth === 0 && key === '__v') continue;
    const childPath = path ? `${path}.${key}` : key;
    if (rules.sensitive.has(childPath)) {
      const otherChild = childOf(other, key);
      const changed = otherChild !== NO_COMPARE && sensitiveChanged(child, otherChild);
      out[key] = changed ? { ...HIDDEN_SENSITIVE_CHANGED } : { ...HIDDEN_SENSITIVE };
      continue;
    }
    if (rules.omitted.has(childPath)) continue;
    if (SECRET_KEY.test(key) && typeof child !== 'boolean' && child !== null) {
      out[key] = { ...HIDDEN_REDACTED };
      continue;
    }
    const value = redactValue(child, childPath, depth + 1, rules, childOf(other, key));
    if (value !== OMIT) out[key] = value;
  }
  return out;
}

function redactValue(
  input: unknown,
  path: string,
  depth: number,
  rules: SchemaRules,
  other: Counterpart,
): unknown | typeof OMIT {
  const value = plain(input);
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return OMIT;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return cutString(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value !== 'object') return OMIT;

  // Bytes of any kind (encrypted values included) never reach the log.
  if (isEncryptedValue(value) || Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
    return { ...HIDDEN_REDACTED };
  }
  if (value instanceof ArrayBuffer) return { ...HIDDEN_REDACTED };
  const bsonType = bsonTypeOf(value);
  if (bsonType === 'ObjectId' || bsonType === 'ObjectID') {
    return (value as { toHexString(): string }).toHexString();
  }
  if (
    bsonType === 'Decimal128' ||
    bsonType === 'Long' ||
    bsonType === 'Int32' ||
    bsonType === 'Double'
  ) {
    return String(value);
  }
  // Binary, UUID, Code, BSONRegExp and anything else BSON: never shown.
  if (bsonType) return { ...HIDDEN_REDACTED };

  if (depth > SNAPSHOT_DEPTH_MAX) return { $truncated: 'depth' };

  if (Array.isArray(value)) {
    const items =
      value.length > SNAPSHOT_ARRAY_MAX ? value.slice(0, SNAPSHOT_ARRAY_MAX - 1) : value;
    const out = items.map((item, index) => {
      const redacted = redactValue(item, path, depth + 1, rules, itemOf(other, index));
      return redacted === OMIT ? null : redacted;
    });
    if (value.length > SNAPSHOT_ARRAY_MAX) {
      out.push({ $truncated: 'items', omitted: value.length - items.length });
    }
    return out;
  }
  if (value instanceof Map) {
    return redactObject(Object.fromEntries(value), path, depth, rules, other);
  }
  if (isPlainObject(value)) return redactObject(value, path, depth, rules, other);
  // Any other class instance: its fields aren't known, so it isn't shown.
  return { ...HIDDEN_REDACTED };
}

function capSize(snapshot: AuditSnapshot): AuditSnapshot {
  const bytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
  return bytes > SNAPSHOT_BYTES_MAX ? { $truncated: 'snapshot', bytes } : snapshot;
}

function snapshotWith(
  value: unknown,
  rules: SchemaRules,
  other: Counterpart = NO_COMPARE,
): AuditSnapshot | null {
  const current = plain(value);
  if (current === null || current === undefined) return null;
  const redacted = redactValue(current, '', 0, rules, other);
  if (redacted === OMIT || redacted === null) return null;
  // A snapshot is an object; a bare value (never expected) is wrapped so it stays one.
  const object = isPlainObject(redacted) ? redacted : { value: redacted };
  return capSize(object);
}

/**
 * A redacted snapshot of a record for an audit entry's `before` or `after`, using the record's
 * schema to leave out `select: false` fields and hide sensitive paths. Pass the model (or its
 * schema) and the document, loaded or lean. Returns null for null.
 *
 * ```ts
 * const before = snapshotForAudit(UserModel, user);
 * ```
 */
export function snapshotForAudit(
  model: { schema: Schema } | Schema,
  doc: unknown,
): AuditSnapshot | null {
  const schema = 'eachPath' in model ? model : model.schema;
  return snapshotWith(doc, rulesFor(schema));
}

/**
 * Redacted `before` and `after` snapshots of one record for an update: `snapshotForAudit` on each,
 * except that a sensitive field whose stored (encrypted) value differs from `before`, or that
 * `before` didn't have, is marked HIDDEN_SENSITIVE_CHANGED in `after`. The entry then shows that
 * the field changed without holding anything of it. Arrays are compared item by item, by position.
 *
 * `before` must still hold the old stored values: a lean read, or `doc.toObject()` taken before
 * the change. Sensitive fields have `select: false`, so select them (`+field`) when loading, or
 * they can't be compared.
 *
 * ```ts
 * const original = client.toObject();
 * client.set(changes);
 * await client.save({ session });
 * const { before, after } = snapshotsForAudit(ClientModel, original, client);
 * ```
 */
export function snapshotsForAudit(
  model: { schema: Schema } | Schema,
  before: unknown,
  after: unknown,
): { before: AuditSnapshot | null; after: AuditSnapshot | null } {
  const schema = 'eachPath' in model ? model : model.schema;
  const rules = rulesFor(schema);
  const old = plain(before);
  return {
    before: snapshotWith(old, rules),
    // With no `before` (a create), there is nothing to compare with.
    after: snapshotWith(after, rules, old === null || old === undefined ? NO_COMPARE : old),
  };
}

/**
 * The backstop alone, without a schema: what `recordAudit` runs on every `before` and `after` it
 * is given. Already-redacted snapshots pass through unchanged.
 */
export function redactForAudit(value: unknown): AuditSnapshot | null {
  return snapshotWith(value, NO_RULES);
}
