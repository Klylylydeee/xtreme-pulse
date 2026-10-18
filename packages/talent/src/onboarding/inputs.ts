import { z } from 'zod';
import { OBJECT_ID_PATTERN } from '@pulse/core';
import {
  bankAccountSectionSchema,
  employeeIdField,
  governmentIdsSectionSchema,
  personalSectionSchema,
  recordVersionField,
  skillsSectionSchema,
} from '../validation';
import { CHANGE_REQUEST_NOTE_MAX_LENGTH } from './change-requests';

// Spec: docs/modules/talent.md#onboarding-checklist-and-change-requests-build-step-26 ("What the
// employee changes themselves", "Change requests", "Verification", "No supervisor"; decisions 260,
// 265–267 and 272 in docs/BUILD_PLAN.md) — the inputs of the own Edit sheets, the change request
// actions, "Mark verified" and "Confirm no supervisor", as the services take them. Pure code, safe
// in the browser: the forms parse with the same schemas, and the services parse again.
//
// The own sheets take no employee id: the services act on the signed-in user's own employee. They
// are the record's section schemas without `employeeId`, plus the optional note that goes with any
// change request the save makes. The 201 document upload and "Add certification" reuse step 2.2's
// schemas the same way (`employeeDocumentAddSchema` and `certificationCreateSchema` without
// `employeeId`, and with no `replacesDocumentId`).

const RELOAD = 'Reload the page and try again.';

/** The employee's optional note on a change request: up to 500 characters, empty is null. */
export const changeRequestNoteField = z.preprocess(
  (value) => {
    if (typeof value !== 'string') return value ?? null;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  },
  z
    .string()
    .max(
      CHANGE_REQUEST_NOTE_MAX_LENGTH,
      `Keep the note to ${CHANGE_REQUEST_NOTE_MAX_LENGTH} characters or fewer.`,
    )
    .nullable(),
);

const noteShape = { note: changeRequestNoteField.optional() };

/** The own Personal sheet (Contact details and Personal details, split by the service). */
export const ownPersonalSectionSchema = personalSectionSchema
  .omit({ employeeId: true })
  .extend(noteShape);
export type OwnPersonalSectionInput = z.output<typeof ownPersonalSectionSchema>;

/** The own Government IDs sheet. An empty ID keeps the stored one (a stored ID can't be cleared). */
export const ownGovernmentIdsSectionSchema = governmentIdsSectionSchema
  .omit({ employeeId: true })
  .extend(noteShape);
export type OwnGovernmentIdsSectionInput = z.output<typeof ownGovernmentIdsSectionSchema>;

/** The own Payroll bank account sheet. An empty account number keeps the stored one. */
export const ownBankAccountSectionSchema = bankAccountSectionSchema
  .omit({ employeeId: true })
  .extend(noteShape);
export type OwnBankAccountSectionInput = z.output<typeof ownBankAccountSectionSchema>;

/** The own Skills sheet. */
export const ownSkillsSectionSchema = skillsSectionSchema
  .omit({ employeeId: true })
  .extend(noteShape);
export type OwnSkillsSectionInput = z.output<typeof ownSkillsSectionSchema>;

/** The on-screen sections the employee edits, and their schemas. */
export const OWN_SECTION_SCHEMAS = {
  personal: ownPersonalSectionSchema,
  governmentIds: ownGovernmentIdsSectionSchema,
  bankAccount: ownBankAccountSectionSchema,
  skills: ownSkillsSectionSchema,
} as const;
export type OwnSection = keyof typeof OWN_SECTION_SCHEMAS;

export const changeRequestIdField = z
  .string({ error: 'This change request can’t be found. Reload to see it.' })
  .regex(OBJECT_ID_PATTERN, 'This change request can’t be found. Reload to see it.');

/**
 * "Edit and send again" on a returned request: its id, the note, and the section's form values,
 * which the service parses with the on-screen section's schema above.
 */
export const resendChangeRequestSchema = z.object({
  changeRequestId: changeRequestIdField,
  note: changeRequestNoteField.optional(),
  values: z.record(z.string(), z.unknown(), { error: RELOAD }),
});
export type ResendChangeRequestInput = z.output<typeof resendChangeRequestSchema>;

/** "Cancel request" on a returned request. */
export const cancelChangeRequestSchema = z.object({ changeRequestId: changeRequestIdField });
export type CancelChangeRequestInput = z.output<typeof cancelChangeRequestSchema>;

/** The two groups HR verifies. */
export const VERIFICATION_GROUPS = ['governmentIds', 'bankAccount'] as const;
export type VerificationGroup = (typeof VERIFICATION_GROUPS)[number];

/** "Mark verified" on the inspector's Government IDs or Payroll bank account section. */
export const markVerifiedSchema = z.object({
  employeeId: employeeIdField,
  version: recordVersionField,
  group: z.enum(VERIFICATION_GROUPS, { error: RELOAD }),
});
export type MarkVerifiedInput = z.output<typeof markVerifiedSchema>;

/** "Confirm no supervisor" (`confirmed: true`) or "Withdraw" (`false`) on the inspector. */
export const noSupervisorConfirmationSchema = z.object({
  employeeId: employeeIdField,
  version: recordVersionField,
  confirmed: z.boolean({ error: RELOAD }),
});
export type NoSupervisorConfirmationInput = z.output<typeof noSupervisorConfirmationSchema>;
