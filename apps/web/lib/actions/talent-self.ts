'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { ActionError, defineAction } from '@pulse/core';
import { removeEmployeePhoto, setEmployeePhoto } from '@pulse/core/server';
import { uploadESignature } from '@pulse/talent/server';
import { requireSignedIn, signedInUser } from '@/lib/auth';

// Spec: docs/modules/talent.md#documents-photo-e-signature-and-certifications-build-step-22 and
// SECURITY.md#exceptions-to-module-access (build step 2.2, decisions 173 and 175) — the employee's
// own profile photo and e-signature on `/talent/me`. Self-service, outside module access: each
// action needs only a signed-in user (`requireSignedIn`) and acts on that user's own employee,
// never one named in the request. The services check again: Core's photo service allows the
// employee themself, and the e-signature service takes no employee id at all and refuses the
// bootstrap system account, which has no employee.
//
// Uploads come as FormData fields `photo` and `signature` (JPEG, PNG or WebP, re-encoded on the
// server with their metadata stripped). Nothing returns file contents: a photo answers its file
// route URL, a signature its new version number. Nothing here is logged or cached.

const NO_EMPLOYEE = 'This account isn’t linked to an employee, so it has no photo or e-signature.';
const CHOOSE_IMAGE = 'Choose a JPEG, PNG or WebP image.';

const imageFile = z
  .instanceof(File, { message: CHOOSE_IMAGE })
  .refine((file) => file.size > 0, CHOOSE_IMAGE);

/** The signed-in user's own employee id, or a refusal for the system account. */
async function ownEmployee() {
  const user = await signedInUser();
  if (!user.employee) throw new ActionError(NO_EMPLOYEE);
  return { user, employeeId: user.employee.id };
}

/** Sets your own profile photo (field `photo`, re-encoded as WebP of at most 1024 px). */
export const setOwnPhotoAction = defineAction({
  access: requireSignedIn(),
  schema: z.object({ photo: imageFile }),
  handler: async ({ photo }) => {
    const { user, employeeId } = await ownEmployee();
    const result = await setEmployeePhoto(user, employeeId, photo);
    // Avatars on every page show the photo.
    revalidatePath('/', 'layout');
    return { photoUrl: result.photoUrl };
  },
});

/** Removes your own profile photo: avatars show your initials again. */
export const removeOwnPhotoAction = defineAction({
  access: requireSignedIn(),
  schema: z.object({}),
  handler: async () => {
    const { user, employeeId } = await ownEmployee();
    await removeEmployeePhoto(user, employeeId);
    revalidatePath('/', 'layout');
    return null;
  },
});

/**
 * Uploads a new version of your own e-signature (field `signature`, re-encoded as PNG of at most
 * 1200 px, transparency kept). A signature is replaced, never removed; signed records keep the
 * version they were signed with.
 */
export const uploadOwnESignatureAction = defineAction({
  access: requireSignedIn(),
  schema: z.object({ signature: imageFile }),
  handler: async ({ signature }) => {
    const result = await uploadESignature(await signedInUser(), signature);
    revalidatePath('/talent/me');
    return { version: result.version };
  },
});
