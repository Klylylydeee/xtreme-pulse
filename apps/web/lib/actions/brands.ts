'use server';

import { z } from 'zod';
import { brandInputSchema, defineAction, OBJECT_ID_PATTERN } from '@pulse/core';
import { createBrand, restoreBrand, retireBrand, updateBrand } from '@pulse/core/server';
import { adminOnly, signedInUser } from '@/lib/auth';

// Spec: docs/modules/core.md#managing-master-data — adding, renaming, retiring and restoring
// products (`brands` in code, docs/modules/engage.md#deals-and-stages) on `/admin/products`, for the
// System Administrator only. Each action checks the role first (`adminOnly('systemAdministrator')`);
// each service checks Engage Owner itself (the System Administrator always passes) and writes its
// change and audit entry in one transaction.

const STALE_RECORD = 'This product no longer exists. Reload the page.';

/** The record an edit, retire or restore acts on. */
const recordId = z.string({ error: STALE_RECORD }).regex(OBJECT_ID_PATTERN, STALE_RECORD);
const byId = z.object({ id: recordId });

export const createBrandAction = defineAction({
  access: adminOnly('systemAdministrator'),
  schema: brandInputSchema,
  handler: async (input) => createBrand(await signedInUser(), input),
});

export const updateBrandAction = defineAction({
  access: adminOnly('systemAdministrator'),
  schema: brandInputSchema.extend({ id: recordId }),
  handler: async ({ id, ...input }) => updateBrand(await signedInUser(), id, input),
});

export const retireBrandAction = defineAction({
  access: adminOnly('systemAdministrator'),
  schema: byId,
  handler: async ({ id }) => retireBrand(await signedInUser(), id),
});

export const restoreBrandAction = defineAction({
  access: adminOnly('systemAdministrator'),
  schema: byId,
  handler: async ({ id }) => restoreBrand(await signedInUser(), id),
});
