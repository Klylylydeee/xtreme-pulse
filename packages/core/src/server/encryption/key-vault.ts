import { randomBytes } from 'node:crypto';
import { mongo, type Mongoose } from 'mongoose';
import { connectDb } from '@pulse/db';
import { AEAD_KEY_BYTES, aeadDecrypt, aeadEncrypt, DecryptionFailedError } from './aead';
import { readMasterKey } from './master-key';

// The key vault (docs/adr/0005-field-level-encryption.md): the data keys that encrypt sensitive
// fields, each stored encrypted ("wrapped") by the local master key. The documents follow MongoDB's
// key vault format exactly, so MongoDB's own ClientEncryption can use the same vault later:
//
//   { _id: UUID, keyMaterial: Binary, creationDate, updateDate, status: 0,
//     masterKey: { provider: 'local' }, keyAltNames?: [string] }
//
// For that reason the collection is not a Mongoose model and has none of the base fields
// (createdAt, createdBy…): MongoDB rejects key documents with fields it doesn't know. Only this
// file reads or writes it. Data keys are unwrapped for each use and wiped afterwards; they are
// never cached.

/** The key vault collection, in the app's own database, so backups include it. */
export const KEY_VAULT_COLLECTION = 'encryptionKeys';
/** The alternate name of the data key that encrypts every sensitive field today. */
export const DEFAULT_DATA_KEY_NAME = 'sensitiveFields';

interface KeyVaultDocument {
  _id: mongo.Binary;
  keyMaterial: mongo.Binary;
  creationDate: Date;
  updateDate: Date;
  status: number;
  masterKey: { provider: 'local' };
  keyAltNames?: string[];
}

/** Thrown when the master key can't unwrap a data key: FIELD_ENCRYPTION_LOCAL_KEY was changed. */
export class EncryptionKeyMismatchError extends Error {
  constructor() {
    super(
      'FIELD_ENCRYPTION_LOCAL_KEY is not the key that encrypted the data keys in the key vault, so sensitive fields can’t be read. Restore the original key from its safe copy (docs/RUNBOOK.md#encryption-key-lost-or-changed).',
    );
    this.name = 'EncryptionKeyMismatchError';
  }
}

/**
 * Thrown when a key vault document isn't a valid local data key (a field is missing or has the
 * wrong type, or it belongs to another key provider). Names no field value.
 */
export class DataKeyInvalidError extends Error {
  constructor() {
    super(
      `A data key in the ${KEY_VAULT_COLLECTION} collection is not a valid local data key, so the values it encrypts can’t be read. Restore the key vault from the backup taken with the data.`,
    );
    this.name = 'DataKeyInvalidError';
  }
}

/** The length of a wrapped 96-byte data key: IV (16) + 7 AES blocks (112) + tag (32). */
const WRAPPED_KEY_BYTES = 160;

/** Checks a key vault document's shape before its fields are used. */
function assertKeyDocument(doc: unknown): asserts doc is KeyVaultDocument {
  const d = doc as Partial<Record<keyof KeyVaultDocument, unknown>> | null;
  const valid =
    typeof d === 'object' &&
    d !== null &&
    d._id instanceof mongo.Binary &&
    d._id.sub_type === mongo.Binary.SUBTYPE_UUID &&
    d._id.length() === 16 &&
    d.keyMaterial instanceof mongo.Binary &&
    d.keyMaterial.length() === WRAPPED_KEY_BYTES &&
    typeof d.masterKey === 'object' &&
    d.masterKey !== null &&
    (d.masterKey as { provider?: unknown }).provider === 'local' &&
    typeof d.status === 'number' &&
    (d.keyAltNames === undefined ||
      (Array.isArray(d.keyAltNames) && d.keyAltNames.every((name) => typeof name === 'string')));
  if (!valid) throw new DataKeyInvalidError();
}

/** Thrown when an encrypted value names a data key that isn't in the key vault. */
export class DataKeyNotFoundError extends Error {
  constructor() {
    super(
      `The data key for an encrypted value is missing from the ${KEY_VAULT_COLLECTION} collection, so it can’t be read. Restore the key vault from the backup taken with the data.`,
    );
    this.name = 'DataKeyNotFoundError';
  }
}

async function keyVault(): Promise<mongo.Collection<KeyVaultDocument>> {
  const conn: Mongoose = await connectDb();
  const db = conn.connection.db;
  if (!db) throw new Error('The database connection has no database handle.');
  return db.collection<KeyVaultDocument>(KEY_VAULT_COLLECTION);
}

// The unique index on keyAltNames (the one MongoDB recommends for a key vault), built once per
// process before the first key is created, so two requests can never create two default keys.
const globalForVault = globalThis as typeof globalThis & { __pulseKeyVaultIndex?: Promise<void> };

function ensureKeyVaultIndex(vault: mongo.Collection<KeyVaultDocument>): Promise<void> {
  globalForVault.__pulseKeyVaultIndex ??= vault
    .createIndex(
      { keyAltNames: 1 },
      { unique: true, partialFilterExpression: { keyAltNames: { $exists: true } } },
    )
    .then(() => undefined)
    .catch((error: unknown) => {
      globalForVault.__pulseKeyVaultIndex = undefined;
      throw error;
    });
  return globalForVault.__pulseKeyVaultIndex;
}

/** Unwraps a key document's material with the master key. The caller wipes the result. */
function unwrap(doc: unknown): Buffer {
  assertKeyDocument(doc);
  const masterKey = readMasterKey();
  try {
    const dataKey = aeadDecrypt(masterKey, Buffer.from(doc.keyMaterial.value()), Buffer.alloc(0));
    if (dataKey.length !== AEAD_KEY_BYTES) {
      dataKey.fill(0);
      throw new DataKeyInvalidError();
    }
    return dataKey;
  } catch (error) {
    if (error instanceof DecryptionFailedError) throw new EncryptionKeyMismatchError();
    throw error;
  } finally {
    masterKey.fill(0);
  }
}

/**
 * Runs `use` with the unwrapped data key `keyId` (16-byte UUID) and wipes the key afterwards.
 * Throws {@link DataKeyNotFoundError} or {@link EncryptionKeyMismatchError}.
 */
export async function withDataKey<T>(keyId: Buffer, use: (dataKey: Buffer) => T): Promise<T> {
  const vault = await keyVault();
  const doc = await vault.findOne({ _id: new mongo.Binary(keyId, mongo.Binary.SUBTYPE_UUID) });
  if (!doc) throw new DataKeyNotFoundError();
  const dataKey = unwrap(doc);
  try {
    return use(dataKey);
  } finally {
    dataKey.fill(0);
  }
}

/**
 * Runs `use` with the default data key and its id, creating the key the first time. Wipes the key
 * afterwards. A master key that can't unwrap the existing default key throws
 * {@link EncryptionKeyMismatchError}: a new key is never created over an unreadable one.
 */
export async function withDefaultDataKey<T>(
  use: (dataKey: Buffer, keyId: Buffer) => T,
): Promise<T> {
  const vault = await keyVault();
  let doc = await vault.findOne({ keyAltNames: DEFAULT_DATA_KEY_NAME });
  if (!doc) doc = await createDataKey(vault, DEFAULT_DATA_KEY_NAME);
  const dataKey = unwrap(doc);
  try {
    return use(dataKey, Buffer.from(doc._id.value()));
  } finally {
    dataKey.fill(0);
  }
}

async function createDataKey(
  vault: mongo.Collection<KeyVaultDocument>,
  name: string,
): Promise<KeyVaultDocument> {
  await ensureKeyVaultIndex(vault);
  const masterKey = readMasterKey();
  const dataKey = randomBytes(AEAD_KEY_BYTES);
  let keyMaterial: Buffer;
  try {
    keyMaterial = aeadEncrypt(masterKey, dataKey, Buffer.alloc(0));
  } finally {
    dataKey.fill(0);
    masterKey.fill(0);
  }
  const now = new Date();
  const doc: KeyVaultDocument = {
    _id: new mongo.UUID().toBinary(),
    keyMaterial: new mongo.Binary(keyMaterial),
    creationDate: now,
    updateDate: now,
    status: 0,
    masterKey: { provider: 'local' },
    keyAltNames: [name],
  };
  try {
    await vault.insertOne(doc);
    return doc;
  } catch (error) {
    // Another request created it first: use that one.
    if ((error as { code?: unknown }).code !== 11000) throw error;
    const existing = await vault.findOne({ keyAltNames: name });
    if (!existing) throw error;
    return existing;
  }
}

/** For `/dev/health`: how many data keys the vault holds, and whether the default one unwraps. */
export async function inspectKeyVault(): Promise<{ dataKeys: number; defaultKeyUnwraps: boolean }> {
  // Creates the default key first when the vault is empty.
  const defaultKeyUnwraps = await withDefaultDataKey(() => true);
  const dataKeys = await (await keyVault()).countDocuments();
  return { dataKeys, defaultKeyUnwraps };
}

/**
 * For `/dev/health`: proves a different master key can't unwrap the default data key, without
 * touching FIELD_ENCRYPTION_LOCAL_KEY. Returns true when the wrong key is refused.
 */
export async function wrongMasterKeyIsRefused(): Promise<boolean> {
  const vault = await keyVault();
  const doc = await vault.findOne({ keyAltNames: DEFAULT_DATA_KEY_NAME });
  if (!doc) return false;
  assertKeyDocument(doc);
  const wrongKey = randomBytes(AEAD_KEY_BYTES);
  try {
    aeadDecrypt(wrongKey, Buffer.from(doc.keyMaterial.value()), Buffer.alloc(0)).fill(0);
    return false;
  } catch (error) {
    return error instanceof DecryptionFailedError;
  } finally {
    wrongKey.fill(0);
  }
}
