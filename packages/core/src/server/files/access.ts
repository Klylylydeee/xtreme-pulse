import { AccessDeniedError } from '../../actions';
import type { CurrentUser } from '../auth/session-user';
import { findStoredFile, type StoredFile } from './stored-files';

// The access check for the file route (docs/ARCHITECTURE.md#file-storage, build step 1.6): a file
// opens only for someone who may see the record it belongs to (`ownerType` + `ownerId`). That
// check replaces signed URLs, so a copied link is useless to anyone who couldn't open the record.
//
// The module that owns a record type registers its check with `registerFileAccess`. An owner type
// nobody registered is refused (fail closed). Registrations are per process and explicit, not
// import side effects: `registerCoreFileAccess()` in `./registrations.ts` registers Core's, and
// the file route calls it before it checks a file. A missed call refuses files; it never opens one.
//
// Audit-logging views of sensitive files (201 files, medical certificates, payslips) starts with
// the first sensitive owner type (Phase 2); no owner type registered so far holds sensitive data.

/**
 * Whether `user` may open `file`. Runs after the route has checked that `user` is signed in and
 * active, and before any content is read. Return false to refuse; a thrown error is a server error.
 */
export type FileAccessCheck = (user: CurrentUser, file: StoredFile) => boolean | Promise<boolean>;

// Per process (and per bundle, since Next evaluates server modules once per bundle).
const registry = new Map<string, FileAccessCheck>();

const OWNER_TYPE = /^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*$/;

/**
 * Lets the file route open files owned by records of `ownerType` (`<module>.<record>`, for example
 * `talent.document201`) for whoever `check` allows. Only the module that owns a record type
 * registers it. Registering the same type again replaces its check outside production, where a
 * hot reload evaluates the registering code again; in production it throws, so nothing can
 * quietly swap in a different check for a type that is already registered.
 */
export function registerFileAccess(ownerType: string, check: FileAccessCheck): void {
  if (!OWNER_TYPE.test(ownerType)) {
    throw new Error(`"${ownerType}" isn't a record type. Use <module>.<record>, like core.user.`);
  }
  if (registry.has(ownerType) && process.env.NODE_ENV === 'production') {
    throw new Error(`File access for "${ownerType}" is already registered.`);
  }
  registry.set(ownerType, check);
}

/**
 * Throws {@link AccessDeniedError} when `user` may not open `file`: its owner type isn't
 * registered, its check refuses, or the user still has a temporary password.
 */
export async function authorizeFileAccess(user: CurrentUser, file: StoredFile): Promise<void> {
  const check = registry.get(file.ownerType);
  if (user.mustChangePassword || !check || (await check(user, file)) !== true) {
    throw new AccessDeniedError();
  }
}

/**
 * The file with this id when `user` may open it, or null when it doesn't exist or is refused, so
 * the file route gives both the same answer and ids can't be probed.
 */
export async function findAccessibleFile(
  user: CurrentUser,
  fileId: string,
): Promise<StoredFile | null> {
  const file = await findStoredFile(fileId);
  if (!file) return null;
  try {
    await authorizeFileAccess(user, file);
  } catch (error) {
    if (error instanceof AccessDeniedError) return null;
    throw error;
  }
  return file;
}
