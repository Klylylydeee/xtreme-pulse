'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  companyDetailsSchema,
  defineAction,
  emailDomainSchema,
  fileUploadSettingsInputSchema,
  OBJECT_ID_PATTERN,
} from '@pulse/core';
import {
  addAllowedEmailDomain,
  removeAllowedEmailDomain,
  removeCompanyLogo,
  setCompanyLogo,
  updateCompanyDetails,
  updateFileUploadSettings,
} from '@pulse/core/server';
import { signedInUser, systemAdministratorOnly } from '@/lib/auth';

// Spec: docs/modules/core.md#company-settings-page — the company details, the logo, the allowed
// email domains and the upload settings. The System Administrator only until module access arrives
// in step 1.6: each action checks the role first (`systemAdministratorOnly`), and each service
// checks it again and writes its audit entry in the same transaction as the change.

const SETTINGS_PATH = '/admin/settings';

/**
 * The details form posts the BIR fields under dotted names (`birRegistration.invoiceSeries`), so
 * field errors come back under the same names; `formDataToObject` doesn't nest them, so nest them
 * here before the schema reads them.
 */
const companyDetailsFormSchema = z.preprocess((raw) => {
  if (typeof raw !== 'object' || raw === null) return raw;
  const {
    'birRegistration.casPermitDetails': casPermitDetails,
    'birRegistration.invoiceSeries': invoiceSeries,
    ...rest
  } = raw as Record<string, unknown>;
  return { ...rest, birRegistration: { casPermitDetails, invoiceSeries } };
}, companyDetailsSchema);

/** Saves the company details. A detail may keep its placeholder; it then stays pending. */
export const updateCompanyDetailsAction = defineAction({
  access: systemAdministratorOnly(),
  schema: companyDetailsFormSchema,
  handler: async (input) => {
    await updateCompanyDetails(await signedInUser(), input);
    // Home and /admin show the reminder banner, so refresh every page.
    revalidatePath('/', 'layout');
  },
});

/** Uploads a new company logo (PNG, JPEG or WebP) and sets it. Errors come back on `logo`. */
export const setCompanyLogoAction = defineAction({
  access: systemAdministratorOnly(),
  schema: z.object({
    logo: z
      .instanceof(File, { message: 'Choose a PNG, JPEG or WebP image.' })
      .refine((file) => file.size > 0, 'Choose a PNG, JPEG or WebP image.'),
  }),
  handler: async ({ logo }) => {
    await setCompanyLogo(await signedInUser(), logo);
    // The sidebar on every page shows the logo.
    revalidatePath('/', 'layout');
  },
});

/** Removes the company logo; screens show the placeholder mark again. */
export const removeCompanyLogoAction = defineAction({
  access: systemAdministratorOnly(),
  schema: z.object({}),
  handler: async () => {
    await removeCompanyLogo(await signedInUser());
    revalidatePath('/', 'layout');
  },
});

/** Allows an email domain, restoring it when it was removed before. */
export const addAllowedEmailDomainAction = defineAction({
  access: systemAdministratorOnly(),
  schema: emailDomainSchema,
  handler: async (input) => {
    const added = await addAllowedEmailDomain(await signedInUser(), input);
    revalidatePath(SETTINGS_PATH);
    return { domain: added.domain };
  },
});

/**
 * Removes an allowed email domain (a soft delete). The service refuses the last remaining domain
 * and the acting System Administrator's own domain.
 */
export const removeAllowedEmailDomainAction = defineAction({
  access: systemAdministratorOnly(),
  schema: z.object({
    id: z.string().regex(OBJECT_ID_PATTERN, 'This domain was already removed. Reload the page.'),
  }),
  handler: async ({ id }) => {
    await removeAllowedEmailDomain(await signedInUser(), id);
    revalidatePath(SETTINGS_PATH);
  },
});

/** Adds a new upload settings version, effective today in Manila. One change per day. */
export const updateFileUploadSettingsAction = defineAction({
  access: systemAdministratorOnly(),
  schema: fileUploadSettingsInputSchema,
  handler: async (input) => {
    await updateFileUploadSettings(await signedInUser(), input);
    revalidatePath(SETTINGS_PATH);
  },
});
