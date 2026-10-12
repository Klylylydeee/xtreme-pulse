import type { Types } from 'mongoose';
import { AccessDeniedError } from '../../actions';
import type { AuditModule } from '../../audit';
import { recordAudit } from '../audit/service';
import type { CurrentUser } from '../auth/session-user';
import {
  findStoredFile,
  openStoredFile,
  type StoredFile,
  StoredFileMissingError,
} from './stored-files';

// The access check for the file route (docs/ARCHITECTURE.md#file-storage, build step 1.6): a file
// opens only for someone who may see the record it belongs to (`ownerType` + `ownerId`). That
// check replaces signed URLs, so a copied link is useless to anyone who couldn't open the record.
//
// The module that owns a record type registers its check with `registerFileAccess`. An owner type
// nobody registered is refused (fail closed). Registrations are per process and explicit, not
// import side effects: `registerCoreFileAccess()` in `./registrations.ts` registers Core's, and
// the file route calls it before it checks a file. A missed call refuses files; it never opens one.
//
// Sensitive file views are audit-logged (build step 2.2, decision 181 in docs/BUILD_PLAN.md): a
// registration that passes `auditView` names the record for the entry, and `openAccessibleFile`
// writes and commits a `reveal` entry with `fields: ['file']` before any content is read. If the
// entry can't be written, the error propagates and nothing is opened. `findAccessibleFile` returns
// metadata only, so it refuses such owner types: their content opens through `openAccessibleFile`
// alone.

/**
 * Whether `user` may open `file`. Runs after the route has checked that `user` is signed in and
 * active, and before any content is read. Return false to refuse; a thrown error is a server error.
 */
export type FileAccessCheck = (user: CurrentUser, file: StoredFile) => boolean | Promise<boolean>;

/** The record a file view's `reveal` entry names (SECURITY.md#audit-logging). */
export interface FileAuditRecord {
  /** `<module>.<record>`, for example `talent.employeeDocument`. */
  type: string;
  id: Types.ObjectId | string | null;
  /** Something to show for the record, such as `<employee number> · <type label>`. */
  label?: string | null;
}

/** How a view of a file of this owner type is audit-logged. */
export interface FileAuditView {
  /** The module that owns the record, for the entry. */
  module: AuditModule;
  /** The record the entry names, for this file. Runs after the access check passed. */
  record: (file: StoredFile) => FileAuditRecord | Promise<FileAuditRecord>;
}

export interface FileAccessOptions {
  /**
   * Audit-log every view (the owner's own included): `openAccessibleFile` writes and commits a
   * `reveal` entry with `fields: ['file']` before any content is read, and opens nothing if it
   * can't.
   */
  auditView?: FileAuditView;
}

interface FileAccessRegistration {
  check: FileAccessCheck;
  auditView: FileAuditView | null;
}

// Per process (and per bundle, since Next evaluates server modules once per bundle).
const registry = new Map<string, FileAccessRegistration>();

const OWNER_TYPE = /^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*$/;

/**
 * Lets the file route open files owned by records of `ownerType` (`<module>.<record>`, for example
 * `talent.employeeDocument`) for whoever `check` allows. Pass `auditView` to audit-log every view.
 * Only the module that owns a record type registers it. Registering the same type again replaces
 * its check outside production, where a hot reload evaluates the registering code again; in
 * production it throws, so nothing can quietly swap in a different check for a type that is
 * already registered.
 */
export function registerFileAccess(
  ownerType: string,
  check: FileAccessCheck,
  { auditView }: FileAccessOptions = {},
): void {
  if (!OWNER_TYPE.test(ownerType)) {
    throw new Error(`"${ownerType}" isn't a record type. Use <module>.<record>, like core.user.`);
  }
  if (registry.has(ownerType) && process.env.NODE_ENV === 'production') {
    throw new Error(`File access for "${ownerType}" is already registered.`);
  }
  registry.set(ownerType, { check, auditView: auditView ?? null });
}

/** The registration that lets `user` open `file`, or {@link AccessDeniedError}. */
async function authorize(user: CurrentUser, file: StoredFile): Promise<FileAccessRegistration> {
  const registration = registry.get(file.ownerType);
  if (user.mustChangePassword || !registration || (await registration.check(user, file)) !== true) {
    throw new AccessDeniedError();
  }
  return registration;
}

/**
 * Throws {@link AccessDeniedError} when `user` may not open `file`: its owner type isn't
 * registered, its check refuses, or the user still has a temporary password. It writes no audit
 * entry: to send a file's content, use {@link openAccessibleFile}.
 */
export async function authorizeFileAccess(user: CurrentUser, file: StoredFile): Promise<void> {
  await authorize(user, file);
}

/** The file and its registration when `user` may open it, else null (missing or refused alike). */
async function findAuthorized(
  user: CurrentUser,
  fileId: string,
): Promise<{ file: StoredFile; registration: FileAccessRegistration } | null> {
  const file = await findStoredFile(fileId);
  if (!file) return null;
  try {
    return { file, registration: await authorize(user, file) };
  } catch (error) {
    if (error instanceof AccessDeniedError) return null;
    throw error;
  }
}

/**
 * The file's metadata with this id when `user` may open it, or null when it doesn't exist or is
 * refused, so both get the same answer and ids can't be probed. A file whose owner type
 * audit-logs views (`auditView`) is refused here too: its content opens only through
 * {@link openAccessibleFile}, which writes the entry first.
 */
export async function findAccessibleFile(
  user: CurrentUser,
  fileId: string,
): Promise<StoredFile | null> {
  const found = await findAuthorized(user, fileId);
  if (!found || found.registration.auditView) return null;
  return found.file;
}

/** A file opened for the file route: its metadata and its content. */
export interface OpenedFile {
  file: StoredFile;
  stream: ReadableStream<Uint8Array>;
  sizeBytes: number;
}

/**
 * Opens the file with this id for `user`, for the file route: null when it doesn't exist, is
 * refused, or its content is missing from storage (the same answer, so ids can't be probed).
 *
 * When the owner type was registered with `auditView`, the `reveal` entry (`fields: ['file']`) is
 * written and committed after the access check and before any content is read. If it can't be
 * written, the error propagates and nothing is opened.
 */
export async function openAccessibleFile(
  user: CurrentUser,
  fileId: string,
): Promise<OpenedFile | null> {
  const found = await findAuthorized(user, fileId);
  if (!found) return null;
  const { file, registration } = found;

  if (registration.auditView) {
    const record = await registration.auditView.record(file);
    // No session: the entry commits on its own, before the content is read.
    await recordAudit({
      actorId: user.id,
      actorEmail: user.email,
      module: registration.auditView.module,
      action: 'reveal',
      record: { type: record.type, id: record.id, label: record.label ?? null },
      before: null,
      after: null,
      fields: ['file'],
    });
  }

  try {
    const content = await openStoredFile(file);
    return { file, stream: content.stream, sizeBytes: content.sizeBytes };
  } catch (error) {
    if (error instanceof StoredFileMissingError) return null;
    throw error;
  }
}
