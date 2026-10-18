import { z } from 'zod';
import { DOCUMENT_201_TYPES, type Document201Type } from '../fixed-sets';

// Spec: docs/DATA_MODEL.md#versioned-configuration (`talent.onboardingSettings`) and
// docs/modules/talent.md#onboarding-checklist-and-change-requests-build-step-26 ("Required
// documents", "201 documents"; decisions 259 and 268 in docs/BUILD_PLAN.md) — the onboarding
// setting's value and its Settings sheet, and which 201 document types an employee may upload.
// Pure code, safe in the browser.

/** The 201 document types HR issues, which an employee never uploads or is asked for. */
export const HR_ISSUED_DOCUMENT_TYPES = [
  'employmentContract',
  'regularizationEvaluation',
] as const satisfies readonly Document201Type[];

/** The 201 document types an employee uploads on their own record. */
export const EMPLOYEE_UPLOAD_DOCUMENT_TYPES: readonly Document201Type[] = DOCUMENT_201_TYPES.filter(
  (type) => !(HR_ISSUED_DOCUMENT_TYPES as readonly string[]).includes(type),
);

export function canEmployeeUploadDocumentType(type: Document201Type): boolean {
  return EMPLOYEE_UPLOAD_DOCUMENT_TYPES.includes(type);
}

/**
 * The types `requiredDocumentTypes` may name: every 201 type but the ones HR issues and "other",
 * which names nothing.
 */
export const ONBOARDING_DOCUMENT_TYPES: readonly Document201Type[] =
  EMPLOYEE_UPLOAD_DOCUMENT_TYPES.filter((type) => type !== 'other');

export const ONBOARDING_DOCUMENT_TYPE_REFUSED =
  'Choose documents the employee can upload: not the employment contract, the regularization evaluation or “Other document”.';

/** Checkboxes send one value or several; none sends nothing. */
function toList(value: unknown): unknown {
  if (value === undefined || value === null || value === '') return [];
  return Array.isArray(value) ? value : [value];
}

/** The `talent.onboardingSettings` setting's value, and its Settings sheet. */
export const onboardingSettingsSchema = z.object({
  /** One unarchived, unexpired 201 document of each type marks the 201 documents item done. */
  requiredDocumentTypes: z.preprocess(
    toList,
    z
      .array(
        z
          .enum(DOCUMENT_201_TYPES, { error: 'Choose a document type from the list.' })
          .refine((type) => ONBOARDING_DOCUMENT_TYPES.includes(type), {
            message: ONBOARDING_DOCUMENT_TYPE_REFUSED,
          }),
      )
      .refine((types) => new Set(types).size === types.length, {
        message: 'Each document type can appear only once.',
      }),
  ),
});
export type OnboardingSettings = z.output<typeof onboardingSettingsSchema>;
export type OnboardingSettingsInput = z.input<typeof onboardingSettingsSchema>;

/**
 * The seeded value (effective 2000-01-01, source "Company policy (spec)"): a government ID copy
 * and an NBI clearance. *Assumption, to be confirmed by HR* (HANDOFF item 85).
 */
export const SEED_ONBOARDING_SETTINGS: Readonly<OnboardingSettings> = Object.freeze({
  requiredDocumentTypes: ['governmentIdCopy', 'nbiClearance'],
});
