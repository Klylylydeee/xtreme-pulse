'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { defineAction, userAccessUpdateSchema } from '@pulse/core';
import { getUserAccess, saveUserAccess } from '@pulse/core/server';
import { adminOnly, signedInUser } from '@/lib/auth';

// Spec: docs/modules/core.md#user-access-page and SECURITY.md#module-access-rwo — the access sheet
// on `/admin/access`, for HR and the System Administrator (checked by role, decision 54). Each
// action checks the role first (`adminOnly('hrOrSystemAdministrator')`); the service checks it
// again inside its transaction, with the read-only rows, the System Administrator switch, the
// never-zero guard and the stale-sheet check, and writes one `accessChange` entry per change.

const STALE_RECORD = 'This user no longer exists. Reload the page.';

// Any string: the id may come from a hand-edited `?user=` link, and the service returns null for
// one that isn't an ObjectId, so the sheet shows "This user isn't active" rather than a retry that
// can't succeed.
const byId = z.object({
  id: z.string({ error: STALE_RECORD }),
});

/**
 * One active user's access for the sheet, or null when there is no such active user (or the id
 * isn't a valid one).
 */
export const getUserAccessAction = defineAction({
  access: adminOnly('hrOrSystemAdministrator'),
  schema: byId,
  handler: async ({ id }) => getUserAccess(await signedInUser(), id),
});

/**
 * Saves the sheet: every module's level and (System Administrator only) the switch, refused when
 * the sheet is stale. The sidebar badge and the `/admin` card count change with it, so the whole
 * administration area is refreshed.
 */
export const saveUserAccessAction = defineAction({
  access: adminOnly('hrOrSystemAdministrator'),
  schema: userAccessUpdateSchema,
  handler: async (input) => {
    const result = await saveUserAccess(await signedInUser(), input);
    if (result.changedModules.length > 0 || result.systemAdministratorChanged) {
      revalidatePath('/', 'layout');
    }
    return result;
  },
});
