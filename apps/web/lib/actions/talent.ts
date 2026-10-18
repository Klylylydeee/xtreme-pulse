'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { defineAction, OBJECT_ID_PATTERN } from '@pulse/core';
import { removeEmployeePhoto, setEmployeePhoto } from '@pulse/core/server';
import {
  allowanceAssignmentFormSchema,
  bankAccountSectionSchema,
  certificationCreateSchema,
  certificationRemoveSchema,
  certificationUpdateSchema,
  compensationEntryFormSchema,
  employeeDocumentAddSchema,
  employeeDocumentArchiveSchema,
  employeeDocumentUpdateSchema,
  employmentSectionSchema,
  expiryAlertSettingsSchema,
  governmentIdsSectionSchema,
  markVerifiedSchema,
  noSupervisorConfirmationSchema,
  onboardingSettingsSchema,
  personalSectionSchema,
  setWorkScheduleSchema,
  skillsSectionSchema,
} from '@pulse/talent';
import {
  addCompensationEntry,
  addEmployeeDocument,
  addOnboardingSettingsVersion,
  archiveEmployeeDocument,
  assignAllowance,
  createCertification,
  getEmployeeOnboarding,
  getEmployeeRecordView,
  getWorkScheduleSection,
  markVerified,
  removeCertification,
  setBankAccount,
  setGovernmentIds,
  setNoSupervisorConfirmation,
  setSkills,
  setWorkSchedule,
  updateCertification,
  updateEmployeeDocument,
  updateEmployment,
  updateExpiryAlertSettings,
  updatePersonal,
} from '@pulse/talent/server';
import { requireModuleAccess, signedInUser } from '@/lib/auth';

// Spec: docs/modules/talent.md#the-employee-record-build-step-21 and SECURITY.md#sensitive-data
// (build step 2.1, decisions 158–170 in docs/BUILD_PLAN.md) — the Server Actions behind the
// `/talent` inspector. Reading a record needs Talent Read and every save Talent Write, checked
// here first (`requireModuleAccess`); each service then checks again in its transaction who may
// change which section (the sensitive sections, the date of birth and civil status, never one's
// own record), refuses a stale form (`version`) and writes the audit entry.
//
// - What comes back holds no plaintext sensitive value: a save answers only the record's new
//   `version` (or the new entry's id), and the record view has the masked values the service
//   built for this viewer (the last 4 digits, or "••••" for a salary), or none of a section the
//   viewer may not see. Full values come only from the reveal action, which is audit-logged.
// - Nothing here is logged or cached. A save refreshes `/talent`, whose list shows the
//   "Not filled in" badge.
//
// Step 2.2 (docs/modules/talent.md#documents-photo-e-signature-and-certifications-build-step-22,
// decisions 173–188): the 201 file (add, edit, archive), certifications (add, edit; remove needs
// Talent Owner), skills, the profile photo in the inspector (Core's rule: HR, the System
// Administrator or the employee, checked by Core's service; the inspector itself needs Talent
// Read) and the expiry alert lead days (Talent Owner). Uploads come as FormData fields `file`,
// `attachment` and `photo`; nothing returns file contents, only ids, versions and URLs of the
// access-checked file route. The employee's own photo and e-signature are in `talent-self.ts`.
//
// Step 2.3 (docs/modules/talent.md#payroll-settings-and-allowances-build-step-23, decisions 203–
// 205): "Add salary change" answers the minimum wage warning instead of saving (the sheet's "Save
// anyway" sends the form again to confirm it), and "Assign allowance" adds an allowance assignment.
//
// Step 2.4 (docs/modules/talent.md#work-schedules-and-daily-time-entries-build-step-24, decision
// 215): the inspector's Work schedule section loads with Talent Read, and "Set schedule" needs
// Talent Write; the service checks again HR or the System Administrator, never one's own record,
// and the effective date range, and writes the audit entry. A schedule isn't sensitive.

const TALENT_READ = 'You don’t have access to Pulse Talent. Ask HR or the System Administrator.';
const TALENT_WRITE =
  'You don’t have access to change employee records. Ask HR or the System Administrator.';

const TALENT_OWNER = 'Only a Pulse Talent Owner can do this. Ask HR or the System Administrator.';

const talentReaders = requireModuleAccess('talent', 'read', TALENT_READ);
const talentWriters = requireModuleAccess('talent', 'write', TALENT_WRITE);
const talentOwners = requireModuleAccess('talent', 'owner', TALENT_OWNER);

const RELOAD = 'Reload the page and try again.';

/** A file the form must send: a non-empty File. */
function requiredFile(message: string) {
  return z.instanceof(File, { message }).refine((file) => file.size > 0, message);
}

/** A file the form may send: an empty file input (size 0) counts as none. */
const optionalFile = z
  .union([z.instanceof(File), z.literal('')])
  .optional()
  .transform((value) => (value instanceof File && value.size > 0 ? value : null));

/**
 * One employee's record for the inspector, built for the viewer, or null when there is no such
 * employee (or they are separated and `separated` isn't set). Any string: the id may come from a
 * hand-edited `?employee=` link, and the service returns null for a bad one.
 */
export const getEmployeeRecordAction = defineAction({
  access: talentReaders,
  schema: z.object({
    employeeId: z.string().max(100),
    separated: z.boolean().optional(),
  }),
  handler: async ({ employeeId, separated }) =>
    getEmployeeRecordView(await signedInUser(), employeeId, { separated: separated === true }),
});

/** Saves the Personal section. The date of birth and civil status are sent only by HR and the System Administrator. */
export const updatePersonalAction = defineAction({
  access: talentWriters,
  schema: personalSectionSchema,
  handler: async (input) => {
    const result = await updatePersonal(await signedInUser(), input);
    revalidatePath('/talent');
    return { version: result.version };
  },
});

/** Saves Talent's Employment fields (Core's stay in Users). */
export const updateEmploymentAction = defineAction({
  access: talentWriters,
  schema: employmentSectionSchema,
  handler: async (input) => {
    const result = await updateEmployment(await signedInUser(), input);
    revalidatePath('/talent');
    return { version: result.version };
  },
});

/** Saves the Government IDs. An empty ID keeps the stored one. */
export const setGovernmentIdsAction = defineAction({
  access: talentWriters,
  schema: governmentIdsSectionSchema,
  handler: async (input) => {
    const result = await setGovernmentIds(await signedInUser(), input);
    revalidatePath('/talent');
    return { version: result.version };
  },
});

/** Saves the Payroll bank account. An empty account number keeps the stored one. */
export const setBankAccountAction = defineAction({
  access: talentWriters,
  schema: bankAccountSectionSchema,
  handler: async (input) => {
    const result = await setBankAccount(await signedInUser(), input);
    revalidatePath('/talent');
    return { version: result.version };
  },
});

/**
 * What "Add salary change" answers (step 2.3, decision 205): the new entry's id, the note or the
 * warning's sentence, never the stored amount.
 *
 * - `saved`: the entry was added.
 * - `savedWithNote`: added, with `note` to show ("No minimum wage on file for <region>. …").
 * - `belowMinimumWage`: nothing was saved. `warning` is the spec's sentence for under the amount
 *   ("The daily rate ₱650.00 is below the NCR minimum wage …"), which repeats only the rate the
 *   user just typed; the button becomes "Save anyway", which sends the form again with
 *   `allowBelowMinimumWage`.
 */
export type CompensationSaveResult =
  | { status: 'saved'; id: string }
  | { status: 'savedWithNote'; id: string; note: string }
  | { status: 'belowMinimumWage'; warning: string };

/** "Add salary change": a new compensation entry, the amount typed in pesos. */
export const addCompensationEntryAction = defineAction({
  access: talentWriters,
  schema: compensationEntryFormSchema,
  handler: async (input): Promise<CompensationSaveResult> => {
    const result = await addCompensationEntry(await signedInUser(), input);
    // Nothing was saved, so there is nothing to refresh.
    if (result.status === 'belowMinimumWage') {
      return { status: 'belowMinimumWage', warning: result.warning.message };
    }
    revalidatePath('/talent');
    return result.status === 'savedWithNote'
      ? { status: 'savedWithNote', id: result.id, note: result.note }
      : { status: 'saved', id: result.id };
  },
});

// --- Step 2.3: allowances -----------------------------------------------------------------------

/**
 * "Assign allowance": a new allowance assignment (set an amount, typed in pesos, or end) from its
 * effective date. Talent Write here; the service checks the salary rule again in its transaction
 * (HR or the System Administrator; for the HR department the System Administrator or a Board
 * member; never one's own record) and writes the audit entry with the amount hidden. Answers only
 * the new entry's id.
 */
export const assignAllowanceAction = defineAction({
  access: talentWriters,
  schema: allowanceAssignmentFormSchema,
  handler: async (input) => {
    const result = await assignAllowance(await signedInUser(), input);
    revalidatePath('/talent');
    return { id: result.id };
  },
});

// --- Step 2.2: the 201 file ---------------------------------------------------------------------

/**
 * Uploads a 201 document (field `file`, stored byte for byte). With `replacesDocumentId` and
 * `replacesVersion` it archives the document this renewal replaces, in the same save. Talent Write
 * here; the service also needs HR or the System Administrator, never on one's own record.
 */
export const addEmployeeDocumentAction = defineAction({
  access: talentWriters,
  schema: z
    .object({ file: requiredFile('Choose the file to upload.') })
    .and(employeeDocumentAddSchema),
  handler: async ({ file, ...input }) => {
    const result = await addEmployeeDocument(await signedInUser(), input, file);
    revalidatePath('/talent');
    return { documentId: result.documentId };
  },
});

/** Edits a 201 document's details (never its file), with the `version` check. */
export const updateEmployeeDocumentAction = defineAction({
  access: talentWriters,
  schema: employeeDocumentUpdateSchema,
  handler: async (input) => {
    const result = await updateEmployeeDocument(await signedInUser(), input);
    revalidatePath('/talent');
    return { version: result.version };
  },
});

/** Archives a 201 document with a reason. Nothing is ever deleted. */
export const archiveEmployeeDocumentAction = defineAction({
  access: talentWriters,
  schema: employeeDocumentArchiveSchema,
  handler: async (input) => {
    const result = await archiveEmployeeDocument(await signedInUser(), input);
    revalidatePath('/talent');
    return { version: result.version };
  },
});

// --- Step 2.2: certifications and skills --------------------------------------------------------

/** Adds a certification, with an optional attachment (field `attachment`). Talent Write. */
export const createCertificationAction = defineAction({
  access: talentWriters,
  schema: z.object({ attachment: optionalFile }).and(certificationCreateSchema),
  handler: async ({ attachment, ...input }) => {
    const result = await createCertification(await signedInUser(), input, attachment);
    revalidatePath('/talent');
    return { certificationId: result.certificationId };
  },
});

/** Edits a certification: a new attachment replaces the old one, `removeAttachment` clears it. */
export const updateCertificationAction = defineAction({
  access: talentWriters,
  schema: z.object({ attachment: optionalFile }).and(certificationUpdateSchema),
  handler: async ({ attachment, ...input }) => {
    await updateCertification(await signedInUser(), input, attachment);
    revalidatePath('/talent');
    return null;
  },
});

/** Removes a certification (a soft delete). Talent Owner, never on one's own record. */
export const removeCertificationAction = defineAction({
  access: talentOwners,
  schema: certificationRemoveSchema,
  handler: async (input) => {
    await removeCertification(await signedInUser(), input);
    revalidatePath('/talent');
    return null;
  },
});

/** Saves the skills tags, like a section, with the record's `version`. */
export const setSkillsAction = defineAction({
  access: talentWriters,
  schema: skillsSectionSchema,
  handler: async (input) => {
    const result = await setSkills(await signedInUser(), input);
    revalidatePath('/talent');
    return { version: result.version };
  },
});

// --- Step 2.2: the profile photo in the inspector -----------------------------------------------

const employeeIdOf = z.string({ error: RELOAD }).regex(OBJECT_ID_PATTERN, RELOAD);

/**
 * Sets an employee's profile photo (field `photo`, re-encoded as WebP). The inspector needs
 * Talent Read; Core's service allows only HR, the System Administrator and the employee.
 */
export const setEmployeePhotoAction = defineAction({
  access: talentReaders,
  schema: z.object({
    employeeId: employeeIdOf,
    photo: requiredFile('Choose a JPEG, PNG or WebP image.'),
  }),
  handler: async ({ employeeId, photo }) => {
    const result = await setEmployeePhoto(await signedInUser(), employeeId, photo);
    // Avatars on every page show the photo.
    revalidatePath('/', 'layout');
    return { photoUrl: result.photoUrl };
  },
});

/** Removes an employee's profile photo: avatars show initials again. Same rule as above. */
export const removeEmployeePhotoAction = defineAction({
  access: talentReaders,
  schema: z.object({ employeeId: employeeIdOf }),
  handler: async ({ employeeId }) => {
    await removeEmployeePhoto(await signedInUser(), employeeId);
    revalidatePath('/', 'layout');
    return null;
  },
});

// --- Step 2.2: the expiry alert lead days -------------------------------------------------------

/** Changes the expiry alert lead days, effective today in Manila. Talent Owner, once per day. */
export const updateExpiryAlertSettingsAction = defineAction({
  access: talentOwners,
  schema: expiryAlertSettingsSchema,
  handler: async (input) => {
    const result = await updateExpiryAlertSettings(await signedInUser(), input);
    revalidatePath('/talent');
    return result;
  },
});

// --- Step 2.4: work schedules -------------------------------------------------------------------

/**
 * The Work schedule section of the inspector: the schedule in effect, the scheduled ones and the
 * history, with `canSet` and the "Set schedule" date range. Talent Read here; the service checks
 * again who may see it. Null when there is no such employee. Any string, as for the record.
 */
export const getWorkScheduleSectionAction = defineAction({
  access: talentReaders,
  schema: z.object({ employeeId: z.string().max(100) }),
  handler: async ({ employeeId }) => {
    if (!OBJECT_ID_PATTERN.test(employeeId)) return null;
    return getWorkScheduleSection(await signedInUser(), employeeId);
  },
});

/**
 * "Set schedule": the employee's own schedule, or null to go back to the company default, from
 * its effective date, with a reason. Talent Write here; the service checks HR or the System
 * Administrator, never one's own record, and the date range again in its transaction. Answers
 * only the new entry's id.
 */
export const setWorkScheduleAction = defineAction({
  access: talentWriters,
  schema: setWorkScheduleSchema,
  handler: async (input) => {
    const result = await setWorkSchedule(await signedInUser(), input);
    revalidatePath('/talent');
    return { id: result.id };
  },
});

// --- Step 2.6: onboarding, verification and "No supervisor" --------------------------------------
//
// docs/modules/talent.md#onboarding-checklist-and-change-requests-build-step-26 (decisions 259,
// 260, 265 and 274). Nothing here returns or logs a sensitive value: the checklist holds states
// only (an item about a section the viewer can't see comes back hidden, with any count that
// includes it), and the saves answer only the record's new `version`.

/**
 * The inspector's Onboarding section: both lists with their states and progress, and "Confirm no
 * supervisor" or "Withdraw" for those who may. Talent Read here; the service checks again and
 * hides what the viewer can't see. Null when there is no such employee. Any string, as for the
 * record.
 */
export const getEmployeeOnboardingAction = defineAction({
  access: talentReaders,
  schema: z.object({
    employeeId: z.string().max(100),
    separated: z.boolean().optional(),
  }),
  handler: async ({ employeeId, separated }) => {
    if (!OBJECT_ID_PATTERN.test(employeeId)) return null;
    return getEmployeeOnboarding(await signedInUser(), employeeId, {
      separated: separated === true,
    });
  },
});

/**
 * "Mark verified" on Government IDs or Payroll bank account. Talent Write here; the service checks
 * again who may verify (HR or the System Administrator; for an HR employee, the System
 * Administrator or a Board member; never one's own record), that the group is complete, and the
 * record's `version`, and writes the audit entry.
 */
export const markVerifiedAction = defineAction({
  access: talentWriters,
  schema: markVerifiedSchema,
  handler: async (input) => {
    const result = await markVerified(await signedInUser(), input);
    revalidatePath('/talent');
    return { version: result.version };
  },
});

/**
 * "Confirm no supervisor" (`confirmed: true`) or "Withdraw" (`false`). Talent Read here, which the
 * inspector needs; the service checks HR, a Board member or the System Administrator, never one's
 * own record, that no supervisor is active, and the record's `version`, and writes the audit entry.
 */
export const setNoSupervisorConfirmationAction = defineAction({
  access: talentReaders,
  schema: noSupervisorConfirmationSchema,
  handler: async (input) => {
    const result = await setNoSupervisorConfirmation(await signedInUser(), input);
    revalidatePath('/talent');
    return { version: result.version };
  },
});

/**
 * "Required onboarding documents" in Settings: a new `talent.onboardingSettings` version effective
 * today in Manila, at most one a day. Talent Owner here and again in the service's transaction,
 * which writes the `create` entry on `core.configVersion`.
 */
export const addOnboardingSettingsVersionAction = defineAction({
  access: talentOwners,
  schema: onboardingSettingsSchema,
  handler: async (input) => {
    const result = await addOnboardingSettingsVersion(await signedInUser(), input);
    revalidatePath('/talent');
    return result;
  },
});
