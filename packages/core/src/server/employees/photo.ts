import type { Types } from 'mongoose';
import { connectDb, withTransaction } from '@pulse/db';
import { AccessDeniedError, ActionError } from '../../actions';
import { recordAudit } from '../audit/service';
import { snapshotsForAudit } from '../audit/snapshot';
import { reloadActorAccess } from '../auth/administrators';
import { type DepartmentRole, isHR, isSystemAdministrator } from '../auth/roles';
import { registerFileAccess } from '../files/access';
import { saveUpload } from '../files/stored-files';
import { TRANSFORMABLE_TYPES } from '../files/image-transform';
import { toObjectId } from '../paging';
import { UserModel } from '../users/model';
import { employeeName } from './active-employees';
import { type EmployeeRecord, EmployeeModel } from './model';

// Spec: docs/modules/core.md#people-data-ownership (decision 173 in docs/BUILD_PLAN.md) — the
// profile photo is Core data, `employees.photoFileId`, because Core's directory, org chart, access
// page, approvals and command bar show it.
//
// - Who sets it: the employee themself, HR and the System Administrator, through
//   `setEmployeePhoto` and `removeEmployeePhoto`. Never the bootstrap system account: it has no
//   employee, so it has no photo, and as an actor it is refused too. The actor is checked from the
//   session and again inside the transaction.
// - Each change is one `update` entry on `core.employee`, module `core`.
// - The image is re-encoded on upload (`transform: 'photo'`: WebP, at most 1024 px, metadata
//   stripped). A replaced or removed photo's file is kept, but it no longer opens.
// - Who opens it: any signed-in active user (the file route checks both), the current photo only
//   (owner type `core.employee`). The photo isn't sensitive (SECURITY.md#sensitive-data).

/** The owner type of profile photo files, and the audit record type of a photo change. */
export const EMPLOYEE_PHOTO_OWNER_TYPE = 'core.employee';
const EMPLOYEE_RECORD_TYPE = 'core.employee';

const NOT_ALLOWED = 'Only the employee, HR and the System Administrator can change this photo.';
const PERSON_GONE = 'This person no longer exists. Reload the page.';

/** Who changes a photo: the signed-in user (a `CurrentUser` fits). */
export interface EmployeePhotoActor {
  id: string;
  email: string;
  isSystemAdministrator: boolean;
  /** The bootstrap system account is refused. */
  isSystemAccount?: boolean;
  roles: readonly DepartmentRole[];
  /** Null for the bootstrap system account. */
  employee: { id: string } | null;
}

/**
 * The URL a profile photo opens at (`/files/<id>?inline=1`), or null when there is no photo. Only
 * the current photo opens there, for signed-in active users.
 */
export function employeePhotoUrl(
  photoFileId: Types.ObjectId | string | null | undefined,
): string | null {
  const id = toObjectId(photoFileId);
  return id ? `/files/${id.toHexString()}?inline=1` : null;
}

/**
 * True when `actor` may change or remove `employeeId`'s photo: the employee themself, HR or the
 * System Administrator, never the bootstrap system account. For showing the controls; the services
 * check again.
 */
export function canChangeEmployeePhoto(actor: EmployeePhotoActor, employeeId: string): boolean {
  if (actor.isSystemAccount === true || !actor.employee) return false;
  return actor.employee.id === employeeId || isHR(actor) || isSystemAdministrator(actor);
}

function assertCanChange(actor: EmployeePhotoActor, employeeId: string): void {
  if (!canChangeEmployeePhoto(actor, employeeId)) throw new AccessDeniedError(NOT_ALLOWED);
}

/** `<employee number> · <first last>`, the `core.employee` audit label. */
function auditLabelOf(employee: Pick<EmployeeRecord, 'employeeNumber' | 'firstName' | 'lastName'>) {
  return `${employee.employeeNumber} · ${employeeName(employee)}`;
}

/**
 * Sets `photoFileId` in a transaction, re-checking the actor as they are now, and audits it.
 * Writes nothing when the stored value is already `photoFileId`.
 */
async function writePhoto(
  actor: EmployeePhotoActor,
  employeeId: Types.ObjectId,
  photoFileId: Types.ObjectId | null,
): Promise<{ photoUrl: string | null }> {
  return withTransaction(async (session) => {
    const reloaded = await reloadActorAccess(actor, session);
    // The system account has no employee: the reloaded actor never passes.
    assertCanChange(
      { ...reloaded, isSystemAccount: reloaded.employee === null },
      employeeId.toHexString(),
    );

    const before = await EmployeeModel.findById(employeeId).session(session).lean();
    if (!before) throw new ActionError(PERSON_GONE);
    // An employee linked to the system account (which the user model forbids) never gets a photo.
    const systemAccount = await UserModel.exists({ employeeId, isSystemAccount: true }).session(
      session,
    );
    if (systemAccount) throw new AccessDeniedError(NOT_ALLOWED);

    const current = before.photoFileId ?? null;
    if (
      current === null ? photoFileId === null : photoFileId !== null && current.equals(photoFileId)
    ) {
      return { photoUrl: employeePhotoUrl(current) };
    }

    await EmployeeModel.updateOne(
      { _id: employeeId },
      { $set: { photoFileId, updatedBy: toObjectId(reloaded.id) } },
      { session, runValidators: true },
    );
    const after = await EmployeeModel.findById(employeeId).session(session).lean().orFail();
    await recordAudit(
      {
        actorId: reloaded.id,
        actorEmail: reloaded.email,
        module: 'core',
        action: 'update',
        record: { type: EMPLOYEE_RECORD_TYPE, id: employeeId, label: auditLabelOf(after) },
        ...snapshotsForAudit(EmployeeModel, before, after),
      },
      { session },
    );
    return { photoUrl: employeePhotoUrl(after.photoFileId) };
  });
}

/**
 * Sets `employeeId`'s profile photo from an uploaded JPEG, PNG or WebP image, re-encoded as WebP
 * of at most 1024 px with its metadata stripped. Allowed for the employee themself, HR and the
 * System Administrator ({@link AccessDeniedError} otherwise), never the system account. One
 * `update` entry on `core.employee`. The previous photo's file is kept but no longer opens.
 *
 * The file is saved before the transaction (a side effect); if the transaction then fails, the
 * saved file is left unused, as with the company logo. Refusals of the image come back as
 * {@link ActionError} on the field `photo`.
 */
export async function setEmployeePhoto(
  actor: EmployeePhotoActor,
  employeeId: string,
  file: File,
): Promise<{ photoUrl: string | null }> {
  assertCanChange(actor, employeeId);
  const id = toObjectId(employeeId);
  if (!id) throw new ActionError(PERSON_GONE);
  await connectDb();
  if (!(await EmployeeModel.exists({ _id: id }))) throw new ActionError(PERSON_GONE);

  const stored = await saveUpload({
    file,
    owner: { type: EMPLOYEE_PHOTO_OWNER_TYPE, id },
    actorId: toObjectId(actor.id),
    accept: TRANSFORMABLE_TYPES,
    field: 'photo',
    transform: 'photo',
  });
  const fileId = toObjectId(stored.id);
  if (!fileId) throw new Error('The stored photo has no valid id.');
  return writePhoto(actor, id, fileId);
}

/**
 * Removes `employeeId`'s profile photo: avatars show initials again. Same rules as
 * {@link setEmployeePhoto}. Nothing is written (or audit-logged) when there is no photo. The
 * file is kept but no longer opens.
 */
export async function removeEmployeePhoto(
  actor: EmployeePhotoActor,
  employeeId: string,
): Promise<{ photoUrl: null }> {
  assertCanChange(actor, employeeId);
  const id = toObjectId(employeeId);
  if (!id) throw new ActionError(PERSON_GONE);
  await connectDb();
  await writePhoto(actor, id, null);
  return { photoUrl: null };
}

/**
 * Registers the `core.employee` file access check: only the employee's current photo opens (the
 * file whose id equals `employees.photoFileId` of its owner), for any signed-in active user; the
 * file route has checked both before this runs. Called by `registerCoreFileAccess`.
 */
export function registerEmployeePhotoFileAccess(): void {
  registerFileAccess(EMPLOYEE_PHOTO_OWNER_TYPE, async (_user, file) => {
    const ownerId = toObjectId(file.ownerId);
    const fileId = toObjectId(file.id);
    if (!ownerId || !fileId) return false;
    await connectDb();
    return (await EmployeeModel.exists({ _id: ownerId, photoFileId: fileId })) !== null;
  });
}
