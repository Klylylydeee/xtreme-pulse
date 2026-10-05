'use server';

import { z } from 'zod';
import {
  defineAction,
  departmentInputSchema,
  departmentUpdateSchema,
  OBJECT_ID_PATTERN,
  positionInputSchema,
  positionUpdateSchema,
} from '@pulse/core';
import {
  createDepartment,
  createPosition,
  listEligibleDepartmentHeads,
  restoreDepartment,
  restorePosition,
  retireDepartment,
  retirePosition,
  updateDepartment,
  updatePosition,
} from '@pulse/core/server';
import { adminOnly, signedInUser } from '@/lib/auth';

// Spec: docs/modules/core.md#managing-departments-and-positions — adding, editing, retiring and
// restoring departments and positions, for HR and the System Administrator (an admin area role, not
// module access: SECURITY.md#resolving-and-enforcing-build-step-16). Each action checks the role
// first (`adminOnly('hrOrSystemAdministrator')`); each service checks it again and writes
// its change and audit entry in one transaction. A department's code and a position's department
// are fixed once created, so the update schemas don't take them.

const STALE_RECORD = 'This record no longer exists. Reload the page.';

/** The record an edit, retire or restore acts on. */
const recordId = z.string({ error: STALE_RECORD }).regex(OBJECT_ID_PATTERN, STALE_RECORD);
const byId = z.object({ id: recordId });

// --- Departments ------------------------------------------------------------------------------

export const createDepartmentAction = defineAction({
  access: adminOnly('hrOrSystemAdministrator'),
  schema: departmentInputSchema,
  handler: async (input) => createDepartment(await signedInUser(), input),
});

export const updateDepartmentAction = defineAction({
  access: adminOnly('hrOrSystemAdministrator'),
  schema: departmentUpdateSchema.extend({ id: recordId }),
  handler: async ({ id, ...input }) => updateDepartment(await signedInUser(), id, input),
});

export const retireDepartmentAction = defineAction({
  access: adminOnly('hrOrSystemAdministrator'),
  schema: byId,
  handler: async ({ id }) => retireDepartment(await signedInUser(), id),
});

export const restoreDepartmentAction = defineAction({
  access: adminOnly('hrOrSystemAdministrator'),
  schema: byId,
  handler: async ({ id }) => restoreDepartment(await signedInUser(), id),
});

/** Employees who can be picked as a department head, matched on name or employee number. */
export const searchDepartmentHeadsAction = defineAction({
  access: adminOnly('hrOrSystemAdministrator'),
  schema: z.object({ search: z.string().trim().max(100).default('') }),
  handler: async ({ search }) => listEligibleDepartmentHeads(await signedInUser(), search),
});

// --- Positions --------------------------------------------------------------------------------

export const createPositionAction = defineAction({
  access: adminOnly('hrOrSystemAdministrator'),
  schema: positionInputSchema,
  handler: async (input) => createPosition(await signedInUser(), input),
});

export const updatePositionAction = defineAction({
  access: adminOnly('hrOrSystemAdministrator'),
  schema: positionUpdateSchema.extend({ id: recordId }),
  handler: async ({ id, ...input }) => updatePosition(await signedInUser(), id, input),
});

export const retirePositionAction = defineAction({
  access: adminOnly('hrOrSystemAdministrator'),
  schema: byId,
  handler: async ({ id }) => retirePosition(await signedInUser(), id),
});

export const restorePositionAction = defineAction({
  access: adminOnly('hrOrSystemAdministrator'),
  schema: byId,
  handler: async ({ id }) => restorePosition(await signedInUser(), id),
});
