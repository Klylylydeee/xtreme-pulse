import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Schema, Types } from 'mongoose';
import { baseSchemaPlugin, connectDb, defineModel } from '@pulse/db';
import { ActionError } from '../../actions';
import {
  detectUploadType,
  GENERATED_TYPES,
  type GeneratedType,
  looksLikeZip,
  UPLOAD_TYPES,
  type UploadType,
} from './file-types';
import { storageRoot } from './root';
import { currentFileUploadSettings } from './settings';

// Spec: docs/ARCHITECTURE.md#file-storage — the one storage service. Modules save and read files
// only through these functions, so moving to S3 or a network drive later changes this file alone.
//
// - Files are saved under generated names (`YYYY/MM/<uuid>`), never the uploaded name or a path
//   from the user. The original name, type, size and owning record are kept in `storedFiles`.
// - An upload's type is read from its content and checked, with its size, against the
//   `core.fileUploads` setting.
// - Files open only through the file route (`/files/<id>`), which runs `authorizeFileAccess`.
//
// Saving a file is a side effect: call these outside `withTransaction` (the callback can run more
// than once), then store the returned id on the record inside the transaction. To link a file to
// a record that doesn't exist yet, create its ObjectId first and pass it as `owner.id`.

/** The record a file belongs to. The file route's access check (step 1.6) is based on it. */
export interface FileOwner {
  /** `<module>.<record>`, for example `talent.document201` or `fiscal.supplierBill`. */
  type: string;
  /** The owning record's id, or null for a file not tied to one record (development samples). */
  id: Types.ObjectId | null;
}

export type FileSource = 'upload' | 'generated';

/** A stored file's metadata. Never send `storageKey` to the browser; link with `url`. */
export interface StoredFile {
  id: string;
  storageKey: string;
  originalName: string;
  contentType: string;
  sizeBytes: number;
  source: FileSource;
  ownerType: string;
  ownerId: string | null;
  createdAt: Date;
  /** The file route URL, the only way to open the file. */
  url: string;
}

interface StoredFileRecord {
  _id: Types.ObjectId;
  storageKey: string;
  originalName: string;
  contentType: string;
  sizeBytes: number;
  source: FileSource;
  ownerType: string;
  ownerId: Types.ObjectId | null;
  /** Set on generated files so a job that runs twice saves the file once. */
  idempotencyKey: string | null;
  createdAt: Date;
  createdBy: Types.ObjectId | null;
}

const OWNER_TYPE = /^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*$/;
// `YYYY/MM/<uuid v4>`: the only shape a storage key can have.
const STORAGE_KEY =
  /^\d{4}\/(?:0[1-9]|1[0-2])\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OBJECT_ID = /^[0-9a-f]{24}$/;
const MAX_NAME_LENGTH = 200;
const TEMP_DIR = '.tmp';

const storedFileSchema = new Schema<StoredFileRecord>({
  storageKey: { type: String, required: true, immutable: true, match: STORAGE_KEY },
  originalName: { type: String, required: true, immutable: true, maxlength: MAX_NAME_LENGTH },
  contentType: { type: String, required: true, immutable: true },
  sizeBytes: { type: Number, required: true, immutable: true, min: 0 },
  source: { type: String, required: true, immutable: true, enum: ['upload', 'generated'] },
  ownerType: { type: String, required: true, immutable: true, match: OWNER_TYPE },
  ownerId: { type: Schema.Types.ObjectId, default: null, immutable: true },
  idempotencyKey: {
    type: String,
    default: null,
    immutable: true,
    // null for none; never an empty or blank key (see assertIdempotencyKey).
    validate: {
      validator: (value: string | null) => value === null || value.trim() !== '',
      message: 'An idempotency key cannot be empty.',
    },
  },
});
storedFileSchema.index({ storageKey: 1 }, { unique: true });
storedFileSchema.index({ ownerType: 1, ownerId: 1 });
// One live file per idempotency key. A soft-deleted file frees its key. No write runs before
// this index exists (see indexes.ts in `@pulse/db`), so concurrent saves with one key can't slip
// in duplicates; the loser gets E11000, and `saveGeneratedFile` returns the winner's file.
storedFileSchema.index(
  { idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: 'string' }, deletedAt: null },
  },
);
// A file belongs to a business record and is removed with it, so it is soft-deleted; the content
// stays on disk (no hard deletes outside admin tooling, docs/DATA_MODEL.md#general).
storedFileSchema.plugin(baseSchemaPlugin, { softDelete: true });

const StoredFileModel = defineModel('StoredFile', storedFileSchema, 'storedFiles');

/** Thrown when a stored record points at a missing or unexpected file on disk. */
export class StoredFileMissingError extends Error {
  constructor(id: string) {
    super(`The content of stored file ${id} is missing from the storage folder.`);
    this.name = 'StoredFileMissingError';
  }
}

function toStoredFile(record: StoredFileRecord): StoredFile {
  const id = record._id.toHexString();
  return {
    id,
    storageKey: record.storageKey,
    originalName: record.originalName,
    contentType: record.contentType,
    sizeBytes: record.sizeBytes,
    source: record.source,
    ownerType: record.ownerType,
    ownerId: record.ownerId ? record.ownerId.toHexString() : null,
    createdAt: record.createdAt,
    url: `/files/${id}`,
  };
}

function assertOwner(owner: FileOwner): void {
  if (!OWNER_TYPE.test(owner.type)) {
    throw new Error(`"${owner.type}" is not a file owner type. Use "<module>.<record>".`);
  }
}

/**
 * A display name from an uploaded name: the last path part only, no control characters, at most
 * 200 characters (keeping the extension). It is shown and used as the download name, never as a
 * path.
 */
export function sanitizeFileName(name: string, fallback = 'file'): string {
  const base = name.split(/[/\\]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!clean || clean === '.' || clean === '..') return fallback;
  if (clean.length <= MAX_NAME_LENGTH) return clean;
  const dot = clean.lastIndexOf('.');
  const extension = dot > 0 && clean.length - dot <= 10 ? clean.slice(dot) : '';
  return clean.slice(0, MAX_NAME_LENGTH - extension.length) + extension;
}

/** The absolute path for a storage key, refusing anything that isn't a generated key. */
function pathForKey(storageKey: string): string {
  if (!STORAGE_KEY.test(storageKey)) throw new Error('Not a storage key.');
  const root = storageRoot();
  const resolved = path.resolve(/*turbopackIgnore: true*/ root, ...storageKey.split('/'));
  if (!resolved.startsWith(root + path.sep)) throw new Error('Not a storage key.');
  return resolved;
}

function newStorageKey(at: Date): string {
  const year = String(at.getUTCFullYear());
  const month = String(at.getUTCMonth() + 1).padStart(2, '0');
  return `${year}/${month}/${randomUUID()}`;
}

/** Writes `bytes` under a new generated key: to a temporary file first, then moved into place. */
async function writeContent(bytes: Uint8Array): Promise<string> {
  const root = storageRoot();
  const storageKey = newStorageKey(new Date());
  const target = pathForKey(storageKey);
  const tempDir = path.join(/*turbopackIgnore: true*/ root, TEMP_DIR);
  const temp = path.join(/*turbopackIgnore: true*/ tempDir, randomUUID());
  await mkdir(tempDir, { recursive: true });
  try {
    await writeFile(temp, bytes, { flag: 'wx' });
    await mkdir(path.dirname(target), { recursive: true });
    await rename(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  return storageKey;
}

async function removeContent(storageKey: string): Promise<void> {
  await unlink(pathForKey(storageKey)).catch(() => undefined);
}

/** A size for messages, rounded up so a file just over the limit never reads as the limit. */
function describeSize(bytes: number): string {
  const megabytes = bytes / (1024 * 1024);
  return megabytes >= 1
    ? `${String(Math.ceil(megabytes * 10) / 10)} MB`
    : `${Math.ceil(bytes / 1024)} KB`;
}

function listTypes(types: readonly UploadType[]): string {
  const labels = types.map((type) => UPLOAD_TYPES[type].extension.toUpperCase());
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}`;
}

export interface SaveUploadInput {
  /** The uploaded file, as a Server Action receives it from FormData. */
  file: File;
  owner: FileOwner;
  /** The user uploading, or null for the system. */
  actorId: Types.ObjectId | null;
  /** Narrows the allowed types for this field (for example images only for a photo). */
  accept?: readonly UploadType[];
  /** The form field, so a refusal shows next to it. Default `file`. */
  field?: string;
}

/**
 * Checks and saves an uploaded file. Throws {@link ActionError} (shown next to `field`) when the
 * file is empty, too large, or not an allowed type. The type is read from the content; the name
 * and type the browser sent are never trusted.
 *
 * The caller checks access first (step 1.6) and audit-logs the record change the file is part of.
 */
export async function saveUpload({
  file,
  owner,
  actorId,
  accept,
  field = 'file',
}: SaveUploadInput): Promise<StoredFile> {
  assertOwner(owner);
  await connectDb();
  const settings = await currentFileUploadSettings();
  const allowed = accept
    ? settings.allowedTypes.filter((type) => accept.includes(type))
    : settings.allowedTypes;

  if (file.size === 0) throw new ActionError('Choose a file to upload.', { field });
  if (file.size > settings.maxSizeBytes) {
    throw new ActionError(
      `This file is ${describeSize(file.size)}. Upload a file of ${describeSize(settings.maxSizeBytes)} or less.`,
      { field },
    );
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  // file.size comes from the request; check the bytes actually received too.
  if (bytes.byteLength > settings.maxSizeBytes) {
    throw new ActionError(
      `This file is too large. Upload a file of ${describeSize(settings.maxSizeBytes)} or less.`,
      { field },
    );
  }
  const type = detectUploadType(bytes);
  if (!type || !allowed.includes(type)) {
    throw new ActionError(
      allowed.length ? `Upload a ${listTypes(allowed)} file.` : 'This field takes no uploads.',
      { field },
    );
  }

  const originalName = sanitizeFileName(file.name, `file.${UPLOAD_TYPES[type].extension}`);
  const storageKey = await writeContent(bytes);
  try {
    const record = await StoredFileModel.create({
      storageKey,
      originalName,
      contentType: type,
      sizeBytes: bytes.byteLength,
      source: 'upload',
      ownerType: owner.type,
      ownerId: owner.id,
      idempotencyKey: null,
      createdBy: actorId,
    });
    return toStoredFile(record.toObject());
  } catch (error) {
    await removeContent(storageKey);
    throw error;
  }
}

export interface SaveGeneratedFileInput {
  bytes: Uint8Array;
  contentType: GeneratedType;
  /** The download name, for example `Payslip 2026-09-15.pdf`. */
  fileName: string;
  owner: FileOwner;
  actorId: Types.ObjectId | null;
  /**
   * Makes the save idempotent: while a live file with this key exists, it is returned and nothing
   * new is written. Use one per output, for example `talent.payslip:<payslipId>`, so a job that
   * runs twice leaves one file. An empty or blank key is refused.
   */
  idempotencyKey?: string;
}

/**
 * The filter for the live file with this idempotency key. It repeats the unique index's partial
 * filter (`$type: 'string'` and `deletedAt: null`), so MongoDB can use that index; with the key
 * alone the planner can't tell the index covers the query and scans every stored file. No hint is
 * needed, so the query still works (by a scan) if the index is ever missing.
 */
function byIdempotencyKey(idempotencyKey: string) {
  return { idempotencyKey: { $eq: idempotencyKey, $type: 'string' as const }, deletedAt: null };
}

/**
 * Refuses an empty or whitespace-only idempotency key. It would be stored as a real key, so every
 * later save without a meaningful key would collide with it.
 */
function assertIdempotencyKey(idempotencyKey: string | undefined): void {
  if (idempotencyKey !== undefined && idempotencyKey.trim() === '') {
    throw new Error(
      'The idempotency key is empty. Pass a key that names the output, for example "talent.payslip:<payslipId>", or leave it out.',
    );
  }
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000
  );
}

/** Saves a file the app generated (a PDF or Excel export). */
export async function saveGeneratedFile({
  bytes,
  contentType,
  fileName,
  owner,
  actorId,
  idempotencyKey,
}: SaveGeneratedFileInput): Promise<StoredFile> {
  assertOwner(owner);
  assertIdempotencyKey(idempotencyKey);
  if (!(contentType in GENERATED_TYPES)) throw new Error(`Unknown generated type ${contentType}.`);
  const matches =
    contentType in UPLOAD_TYPES ? detectUploadType(bytes) === contentType : looksLikeZip(bytes);
  if (!matches)
    throw new Error(`The generated content is not ${GENERATED_TYPES[contentType].label}.`);
  await connectDb();

  if (idempotencyKey !== undefined) {
    const existing = await StoredFileModel.findOne(byIdempotencyKey(idempotencyKey)).lean();
    if (existing) return toStoredFile(existing);
  }

  const storageKey = await writeContent(bytes);
  try {
    const record = await StoredFileModel.create({
      storageKey,
      originalName: sanitizeFileName(fileName, `file.${GENERATED_TYPES[contentType].extension}`),
      contentType,
      sizeBytes: bytes.byteLength,
      source: 'generated',
      ownerType: owner.type,
      ownerId: owner.id,
      idempotencyKey: idempotencyKey ?? null,
      createdBy: actorId,
    });
    return toStoredFile(record.toObject());
  } catch (error) {
    await removeContent(storageKey);
    // Another run saved the same output first: return that one.
    if (idempotencyKey !== undefined && isDuplicateKey(error)) {
      const existing = await StoredFileModel.findOne(byIdempotencyKey(idempotencyKey)).lean();
      if (existing) return toStoredFile(existing);
    }
    throw error;
  }
}

/** A stored file by id, or null when the id is malformed, unknown or soft-deleted. */
export async function findStoredFile(id: string): Promise<StoredFile | null> {
  if (!OBJECT_ID.test(id)) return null;
  await connectDb();
  const record = await StoredFileModel.findById(new Types.ObjectId(id)).lean();
  return record ? toStoredFile(record) : null;
}

/** Live files saved with this idempotency key (at most one). */
export async function findGeneratedFile(idempotencyKey: string): Promise<StoredFile | null> {
  assertIdempotencyKey(idempotencyKey);
  await connectDb();
  const record = await StoredFileModel.findOne(byIdempotencyKey(idempotencyKey)).lean();
  return record ? toStoredFile(record) : null;
}

/**
 * Opens a stored file's content as a web stream, for the file route. Only call it after
 * `authorizeFileAccess`. Throws {@link StoredFileMissingError} when the content is gone.
 */
export async function openStoredFile(
  file: StoredFile,
): Promise<{ stream: ReadableStream<Uint8Array>; sizeBytes: number }> {
  const filePath = pathForKey(file.storageKey);
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) throw new StoredFileMissingError(file.id);
  const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>;
  return { stream, sizeBytes: info.size };
}

/**
 * A `Content-Disposition` value with a safe download name: an ASCII fallback plus the UTF-8 name
 * (RFC 6266). Quotes, backslashes and control characters never reach the header.
 */
export function contentDisposition(
  file: Pick<StoredFile, 'originalName'>,
  disposition: 'attachment' | 'inline' = 'attachment',
): string {
  const name = sanitizeFileName(file.originalName);
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
