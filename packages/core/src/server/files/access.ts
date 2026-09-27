import { AccessDeniedError } from '../../actions';
import type { StoredFile } from './stored-files';

// The access check for the file route (docs/ARCHITECTURE.md#file-storage): a file opens only for
// someone who may see the record it belongs to (`ownerType` + `ownerId`). That check replaces
// signed URLs, so a copied link is useless to anyone who couldn't open the record.
//
// STEP 1.6 EXTENSION POINT. There is no sign-in or module access yet, so nothing is checked. Until
// step 1.6 replaces these functions, they let development files through and refuse EVERY file in
// production, the same as `noAccessCheckYet` for Server Actions. They never pretend to check.
//
// Step 1.6 must: read the signed-in user (refuse when signed out), look up the owning record's
// module from `ownerType`, check module access and record-level rules (including the Sensitive
// data rules in SECURITY.md#sensitive-data for 201 files, medical certificates and payslips), and
// audit-log the view of a sensitive file. It must also remove `assertFileRouteOpen` (and its call
// in the file route) together with the production refusal below.

const FILE_ROUTE_OFF = 'Files have no access check yet, so the file route is turned off.';

/**
 * Throws {@link AccessDeniedError} in production, before the file route looks anything up, so every
 * file id gets the same answer and the route never reveals which ids exist. Temporary: step 1.6
 * removes it.
 */
export function assertFileRouteOpen(): void {
  if (process.env.NODE_ENV === 'production') throw new AccessDeniedError(FILE_ROUTE_OFF);
}

/** Throws {@link AccessDeniedError} when the viewer may not open `file`. */
export async function authorizeFileAccess(file: StoredFile): Promise<void> {
  if (process.env.NODE_ENV === 'production') throw new AccessDeniedError(FILE_ROUTE_OFF);
  // Development only: everything opens. `file` is unused until step 1.6.
  void file;
}
