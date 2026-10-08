'use server';

import { z } from 'zod';
import {
  catalogItemInputSchema,
  catalogItemUpdateSchema,
  defineAction,
  OBJECT_ID_PATTERN,
} from '@pulse/core';
import {
  createCatalogItem,
  restoreCatalogItem,
  retireCatalogItem,
  updateCatalogItem,
} from '@pulse/core/server';
import { adminOnly, signedInUser } from '@/lib/auth';

// Spec: docs/modules/core.md#managing-master-data — adding, editing, retiring and restoring catalog
// items (docs/modules/supply.md#stock) on `/admin/catalog-items`, for the System Administrator only.
// Each action checks the role first (`adminOnly('systemAdministrator')`); each service checks Supply
// Owner itself (the System Administrator always passes) and writes its change and audit entry in
// one transaction. A catalog item's product and item kind are fixed once created, so the update
// schema doesn't take them.

const STALE_RECORD = 'This catalog item no longer exists. Reload the page.';

/** The record an edit, retire or restore acts on. */
const recordId = z.string({ error: STALE_RECORD }).regex(OBJECT_ID_PATTERN, STALE_RECORD);
const byId = z.object({ id: recordId });

export const createCatalogItemAction = defineAction({
  access: adminOnly('systemAdministrator'),
  schema: catalogItemInputSchema,
  handler: async (input) => createCatalogItem(await signedInUser(), input),
});

export const updateCatalogItemAction = defineAction({
  access: adminOnly('systemAdministrator'),
  schema: catalogItemUpdateSchema.extend({ id: recordId }),
  handler: async ({ id, ...input }) => updateCatalogItem(await signedInUser(), id, input),
});

export const retireCatalogItemAction = defineAction({
  access: adminOnly('systemAdministrator'),
  schema: byId,
  handler: async ({ id }) => retireCatalogItem(await signedInUser(), id),
});

export const restoreCatalogItemAction = defineAction({
  access: adminOnly('systemAdministrator'),
  schema: byId,
  handler: async ({ id }) => restoreCatalogItem(await signedInUser(), id),
});
