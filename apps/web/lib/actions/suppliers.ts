'use server';

import { z } from 'zod';
import {
  defineAction,
  OBJECT_ID_PATTERN,
  supplierInputSchema,
  supplierUpdateSchema,
} from '@pulse/core';
import {
  createSupplier,
  restoreSupplier,
  retireSupplier,
  updateSupplier,
} from '@pulse/core/server';
import { adminOnly, signedInUser } from '@/lib/auth';

// Spec: docs/modules/core.md#managing-master-data and docs/modules/supply.md#suppliers — adding,
// editing, retiring and restoring suppliers on /admin/suppliers, for the System Administrator only.
// Each action checks the role first (`adminOnly('systemAdministrator')`); each service checks Supply
// Owner again (the System Administrator always passes) and writes its change and audit entry in one
// transaction. The sheet sends a plain object (contacts are a list of rows), so the schemas see the
// same shape the services take.

const STALE_RECORD = 'This supplier no longer exists. Reload the page.';

/** The supplier an edit, retire or restore acts on. */
const recordId = z.string({ error: STALE_RECORD }).regex(OBJECT_ID_PATTERN, STALE_RECORD);
const byId = z.object({ id: recordId });

export const createSupplierAction = defineAction({
  access: adminOnly('systemAdministrator'),
  schema: supplierInputSchema,
  handler: async (input) => createSupplier(await signedInUser(), input),
});

export const updateSupplierAction = defineAction({
  access: adminOnly('systemAdministrator'),
  schema: supplierUpdateSchema.extend({ id: recordId }),
  handler: async ({ id, ...input }) => updateSupplier(await signedInUser(), id, input),
});

export const retireSupplierAction = defineAction({
  access: adminOnly('systemAdministrator'),
  schema: byId,
  handler: async ({ id }) => retireSupplier(await signedInUser(), id),
});

export const restoreSupplierAction = defineAction({
  access: adminOnly('systemAdministrator'),
  schema: byId,
  handler: async ({ id }) => restoreSupplier(await signedInUser(), id),
});
