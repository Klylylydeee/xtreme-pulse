import type { Model, Schema } from 'mongoose';

// The database backstop for sensitive fields (SECURITY.md#sensitive-data, ADR 0012). Every
// collection with sensitive paths gets a `$jsonSchema` validator, generated from the schema, that
// MongoDB applies to every write, whatever path it took (raw driver calls, `$merge`, `$out`, update
// pipelines…):
//
// - a sensitive path, when present, must hold an encrypted value: `{ encrypt: {} }`, which MongoDB
//   (Community too, checked on 8.3) accepts only for BSON binary subtype 6. `null` is refused; an
//   absent field is allowed (clear a value with `$unset`), so no sensitive path is `required`.
// - each container on the way to a sensitive path is pinned to its type (an object for a nested
//   object or a subdocument, an array of objects for an array of subdocuments) or null, so a value
//   can't be stored in a shape the validator doesn't look into (an object where an array belongs,
//   or the reverse).
//
// Only sensitive paths are covered; any other field is unconstrained. The validator is installed
// with the model's indexes (indexes.ts), and installing it again changes nothing.
//
// This package can't import `@pulse/core`, so the schema type option that marks a path as
// sensitive is defined here; `sensitiveField()` in core sets it.

/** The schema type option that marks a path as sensitive. Set by `sensitiveField()` in core. */
export const SENSITIVE_OPTION = 'pulseSensitive';

/** A `$jsonSchema` node, as built here. */
export type JsonSchemaRule = Record<string, unknown>;

/** The validator of a collection with sensitive paths. */
export interface SensitiveValidator {
  $jsonSchema: JsonSchemaRule;
}

interface SchemaTypeLike {
  options?: Record<string, unknown>;
  schema?: Schema;
  instance?: string;
  $isSingleNested?: boolean;
  $isMongooseDocumentArray?: boolean;
}

/** The rule for a sensitive value: BSON binary subtype 6 (MongoDB's encrypted-field format). */
const ENCRYPTED_RULE: JsonSchemaRule = { encrypt: {} };

interface ObjectNode {
  properties: Record<string, JsonSchemaRule | ObjectNode>;
}

function isObjectNode(value: JsonSchemaRule | ObjectNode | undefined): value is ObjectNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    !('bsonType' in value) &&
    !('encrypt' in value) &&
    'properties' in value
  );
}

/** The `properties` of an object's rule, for the sensitive paths of `schema`, or null for none. */
function propertiesOf(schema: Schema): Record<string, JsonSchemaRule> | null {
  const root: ObjectNode = { properties: {} };
  let found = false;
  schema.eachPath((path, schemaType) => {
    const type = schemaType as unknown as SchemaTypeLike;
    // Map paths (`m` and its values, `m.$*`) are never sensitive: the guard refuses a sensitive
    // field in a Map when the model is defined.
    if (type.instance === 'Map' || path.split('.').includes('$*')) return;
    let rule: JsonSchemaRule | null = null;
    if (type.options?.[SENSITIVE_OPTION] === true) {
      rule = ENCRYPTED_RULE;
    } else if (type.schema && type.$isMongooseDocumentArray) {
      const child = propertiesOf(type.schema);
      if (child) {
        rule = {
          bsonType: ['array', 'null'],
          items: { bsonType: 'object', properties: child },
        };
      }
    } else if (type.schema && type.$isSingleNested) {
      const child = propertiesOf(type.schema);
      if (child) rule = { bsonType: ['object', 'null'], properties: child };
    }
    if (!rule) return;
    found = true;
    // A dotted path is a nested object: each part on the way becomes an object rule.
    const parts = path.split('.');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      const existing = node.properties[part];
      if (isObjectNode(existing)) {
        node = existing;
      } else {
        const next: ObjectNode = { properties: {} };
        node.properties[part] = next;
        node = next;
      }
    }
    node.properties[parts[parts.length - 1] as string] = rule;
  });
  return found ? render(root) : null;
}

/** Turns the tree of nested objects into `$jsonSchema` rules. */
function render(node: ObjectNode): Record<string, JsonSchemaRule> {
  return Object.fromEntries(
    Object.entries(node.properties).map(([key, value]) => [
      key,
      isObjectNode(value) ? { bsonType: ['object', 'null'], properties: render(value) } : value,
    ]),
  );
}

/**
 * The `$jsonSchema` validator for a schema's sensitive paths, or null when it has none. Covers
 * top-level fields, nested objects (through `properties`), subdocuments and arrays of
 * subdocuments (through `items`), at any depth.
 */
export function buildSensitiveValidator(schema: Schema): SensitiveValidator | null {
  const properties = propertiesOf(schema);
  if (!properties) return null;
  return { $jsonSchema: { bsonType: 'object', properties } };
}

/** JSON with object keys sorted, so two equal validators compare equal whatever their key order. */
function stableStringify(value: unknown): string {
  const sort = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(sort);
    if (current === null || typeof current !== 'object') return current;
    return Object.fromEntries(
      Object.keys(current)
        .sort()
        .map((key) => [key, sort((current as Record<string, unknown>)[key])]),
    );
  };
  return JSON.stringify(sort(value));
}

const VALIDATION_LEVEL = 'strict';
const VALIDATION_ACTION = 'error';
const NAMESPACE_EXISTS = 48;

/**
 * Installs the model's sensitive-field validator on its collection, or does nothing when the
 * schema has no sensitive paths. Creates the collection with it when missing, and otherwise runs
 * `collMod` only when the validator, its level or its action differ from what is installed, so
 * running it again changes nothing. Errors are the driver's (indexes.ts decides whether to retry).
 */
export async function ensureSensitiveValidator(model: Model<unknown>): Promise<void> {
  const validator = buildSensitiveValidator(model.schema);
  if (!validator) return;
  const db = model.db.db;
  if (!db) throw new Error('The database connection has no database handle.');
  const name = model.collection.collectionName;

  const [info] = await db.listCollections({ name }, { nameOnly: false }).toArray();
  if (!info) {
    try {
      await db.createCollection(name, {
        validator,
        validationLevel: VALIDATION_LEVEL,
        validationAction: VALIDATION_ACTION,
      });
      return;
    } catch (error) {
      // Created meanwhile (by Mongoose or another process): update it below instead.
      if ((error as { code?: unknown }).code !== NAMESPACE_EXISTS) throw error;
    }
  }
  const options = ((info as { options?: Record<string, unknown> } | undefined)?.options ??
    (await db.listCollections({ name }, { nameOnly: false }).toArray())[0]?.options ??
    {}) as Record<string, unknown>;
  const unchanged =
    stableStringify(options.validator) === stableStringify(validator) &&
    (options.validationLevel ?? 'strict') === VALIDATION_LEVEL &&
    (options.validationAction ?? 'error') === VALIDATION_ACTION;
  if (unchanged) return;
  await db.command({
    collMod: name,
    validator,
    validationLevel: VALIDATION_LEVEL,
    validationAction: VALIDATION_ACTION,
  });
}
