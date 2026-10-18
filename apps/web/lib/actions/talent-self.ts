'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { ActionError, defineAction } from '@pulse/core';
import { removeEmployeePhoto, setEmployeePhoto } from '@pulse/core/server';
import {
  ownBankAccountSectionSchema,
  ownGovernmentIdsSectionSchema,
  ownPersonalSectionSchema,
  ownSkillsSectionSchema,
  type OwnSaveResult,
} from '@pulse/talent';
import {
  addOwnCertification,
  addOwnEmployeeDocument,
  getOwnOnboardingReminder,
  type OwnCertificationInput,
  type OwnDocumentUploadInput,
  saveOwnBankAccount,
  saveOwnGovernmentIds,
  saveOwnPersonal,
  saveOwnSkills,
  uploadESignature,
} from '@pulse/talent/server';
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
const CHOOSE_FILE = 'Choose the file to upload.';

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

// ---------------------------------------------------------------------------------------------
// Step 2.6 (docs/modules/talent.md#onboarding-checklist-and-change-requests-build-step-26,
// decisions 261, 266–268 in docs/BUILD_PLAN.md) — the own onboarding progress, the own Edit sheets
// on /talent/me and the checklist, and the employee's own 201 upload and certification.
// Self-service as above: a signed-in user, no employee id taken; the services act on the
// signed-in user's own employee, reloaded in their transaction, and write the audit entries.
//
// - Each own save fills blanks straight away and sends changes to filled-in values as change
//   requests. It answers which fields were saved and which requests were sent, never a value.
// - The own upload and certification forms are checked by the services (step 2.2's schemas,
//   without the employee); the first problem comes back next to its field.

/**
 * The toolbar pill's and Home card's state: the own employee progress and whether to remind.
 * Null for the system account. Read-only: not audit-logged.
 */
export const ownOnboardingReminderAction = defineAction({
  access: requireSignedIn(),
  schema: z.object({}),
  handler: async () => getOwnOnboardingReminder(await signedInUser()),
});

/** After an own change: the record, the checklist and the reminder show it. */
function revalidateOwn() {
  revalidatePath('/talent/me');
  revalidatePath('/talent/onboarding');
  revalidatePath('/');
}

/** The own Personal sheet (Contact details and Personal details). */
export const saveOwnPersonalAction = defineAction({
  access: requireSignedIn(),
  schema: ownPersonalSectionSchema,
  handler: async (input): Promise<OwnSaveResult> => {
    const result = await saveOwnPersonal(await signedInUser(), input);
    revalidateOwn();
    return result;
  },
});

/** The own Government IDs sheet. An empty ID keeps the stored one. */
export const saveOwnGovernmentIdsAction = defineAction({
  access: requireSignedIn(),
  schema: ownGovernmentIdsSectionSchema,
  handler: async (input): Promise<OwnSaveResult> => {
    const result = await saveOwnGovernmentIds(await signedInUser(), input);
    revalidateOwn();
    return result;
  },
});

/** The own Payroll bank account sheet. An empty account number keeps the stored one. */
export const saveOwnBankAccountAction = defineAction({
  access: requireSignedIn(),
  schema: ownBankAccountSectionSchema,
  handler: async (input): Promise<OwnSaveResult> => {
    const result = await saveOwnBankAccount(await signedInUser(), input);
    revalidateOwn();
    return result;
  },
});

/** The own Skills sheet. */
export const saveOwnSkillsAction = defineAction({
  access: requireSignedIn(),
  schema: ownSkillsSectionSchema,
  handler: async (input): Promise<OwnSaveResult> => {
    const result = await saveOwnSkills(await signedInUser(), input);
    revalidateOwn();
    return result;
  },
});

const formText = (max: number) => z.string().max(max).optional();

/**
 * Uploads a 201 document to your own record (field `file`): any type but the employment contract
 * and the regularization evaluation. HR is notified, naming the type only.
 */
export const addOwnDocumentAction = defineAction({
  access: requireSignedIn(),
  schema: z.object({
    file: z.instanceof(File, { message: CHOOSE_FILE }).refine((file) => file.size > 0, CHOOSE_FILE),
    type: z.string({ error: 'Choose a document type from the list.' }).max(64),
    title: formText(1000),
    issueDate: formText(32),
    expiryDate: formText(32),
  }),
  handler: async ({ file, ...input }) => {
    const result = await addOwnEmployeeDocument(
      await signedInUser(),
      input as OwnDocumentUploadInput,
      file,
    );
    revalidateOwn();
    return { documentId: result.documentId };
  },
});

/** Adds a certification to your own record, with an optional attachment (field `attachment`). */
export const addOwnCertificationAction = defineAction({
  access: requireSignedIn(),
  schema: z.object({
    attachment: z
      .union([z.instanceof(File), z.literal('')])
      .optional()
      .transform((value) => (value instanceof File && value.size > 0 ? value : null)),
    name: formText(1000),
    issuer: formText(1000),
    brandId: formText(64),
    licenseNumber: formText(1000),
    issueDate: formText(32),
    expiryDate: formText(32),
  }),
  handler: async ({ attachment, ...input }) => {
    const result = await addOwnCertification(
      await signedInUser(),
      input as OwnCertificationInput,
      attachment,
    );
    revalidateOwn();
    return { certificationId: result.certificationId };
  },
});
