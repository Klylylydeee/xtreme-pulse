'use server';

import { z } from 'zod';
import {
  ActionError,
  clientContactInputSchema,
  clientContactUpdateSchema,
  clientInputSchema,
  clientSiteInputSchema,
  clientSiteUpdateSchema,
  clientUpdateSchema,
  defineAction,
  OBJECT_ID_PATTERN,
} from '@pulse/core';
import {
  addClientContact,
  addClientSite,
  createClient,
  findClientsNamed,
  getClient,
  removeClientContact,
  removeClientSite,
  restoreClient,
  restoreClientContact,
  restoreClientSite,
  retireClient,
  searchEligibleAccountManagers,
  updateClient,
  updateClientContact,
  updateClientSite,
} from '@pulse/core/server';
import { adminOnly, signedInUser } from '@/lib/auth';

// Spec: docs/modules/core.md#managing-master-data and docs/modules/engage.md#clients-sites-and-contacts
// — clients with their sites and contacts on /admin/clients, for the System Administrator only.
// Each action checks the role first (`adminOnly('systemAdministrator')`); each service checks
// Engage access again (the System Administrator always passes) and writes its change and audit
// entry in one transaction. Sites and contacts are saved one row at a time, each by its own action.

const STALE_CLIENT = 'This client no longer exists. Reload the page.';
const STALE_SITE = 'This site no longer exists. Reload the page.';
const STALE_CONTACT = 'This contact no longer exists. Reload the page.';

function recordId(message: string) {
  return z.string({ error: message }).regex(OBJECT_ID_PATTERN, message);
}

const clientId = recordId(STALE_CLIENT);
const byClientId = z.object({ id: clientId });
const bySiteId = z.object({ id: recordId(STALE_SITE) });
const byContactId = z.object({ id: recordId(STALE_CONTACT) });

// --- Clients ----------------------------------------------------------------------------------

/** One client with its sites and contacts (removed ones too when asked), for the sheet. */
export const getClientDetailAction = defineAction({
  access: adminOnly('systemAdministrator'),
  schema: z.object({ id: clientId, includeRemoved: z.boolean().default(false) }),
  handler: async ({ id, includeRemoved }) => {
    const client = await getClient(await signedInUser(), id, { includeRemoved });
    if (!client) throw new ActionError(STALE_CLIENT);
    return client;
  },
});

/** Other clients with this name (ignoring case, retired ones included), for the name warning. */
export const findClientsNamedAction = defineAction({
  access: adminOnly('systemAdministrator'),
  schema: z.object({
    name: z.string().max(200).default(''),
    exceptId: clientId.nullable().default(null),
  }),
  handler: async ({ name, exceptId }) => findClientsNamed(await signedInUser(), name, exceptId),
});

/** Employees who can be picked as a client's Account Manager, matched on name or number. */
export const searchAccountManagersAction = defineAction({
  access: adminOnly('systemAdministrator'),
  schema: z.object({ search: z.string().trim().max(100).default('') }),
  handler: async ({ search }) => searchEligibleAccountManagers(await signedInUser(), search),
});

export const createClientAction = defineAction({
  access: adminOnly('systemAdministrator'),
  schema: clientInputSchema,
  handler: async (input) => createClient(await signedInUser(), input),
});

export const updateClientAction = defineAction({
  access: adminOnly('systemAdministrator'),
  schema: clientUpdateSchema.extend({ id: clientId }),
  handler: async ({ id, ...input }) => updateClient(await signedInUser(), id, input),
});

export const retireClientAction = defineAction({
  access: adminOnly('systemAdministrator'),
  schema: byClientId,
  handler: async ({ id }) => retireClient(await signedInUser(), id),
});

export const restoreClientAction = defineAction({
  access: adminOnly('systemAdministrator'),
  schema: byClientId,
  handler: async ({ id }) => restoreClient(await signedInUser(), id),
});

// --- Sites ------------------------------------------------------------------------------------

export const addClientSiteAction = defineAction({
  access: adminOnly('systemAdministrator'),
  schema: clientSiteInputSchema,
  handler: async (input) => addClientSite(await signedInUser(), input),
});

export const updateClientSiteAction = defineAction({
  access: adminOnly('systemAdministrator'),
  schema: clientSiteUpdateSchema.extend({ id: recordId(STALE_SITE) }),
  handler: async ({ id, ...input }) => updateClientSite(await signedInUser(), id, input),
});

export const removeClientSiteAction = defineAction({
  access: adminOnly('systemAdministrator'),
  schema: bySiteId,
  handler: async ({ id }) => removeClientSite(await signedInUser(), id),
});

export const restoreClientSiteAction = defineAction({
  access: adminOnly('systemAdministrator'),
  schema: bySiteId,
  handler: async ({ id }) => restoreClientSite(await signedInUser(), id),
});

// --- Contacts ---------------------------------------------------------------------------------

export const addClientContactAction = defineAction({
  access: adminOnly('systemAdministrator'),
  schema: clientContactInputSchema,
  handler: async (input) => addClientContact(await signedInUser(), input),
});

export const updateClientContactAction = defineAction({
  access: adminOnly('systemAdministrator'),
  schema: clientContactUpdateSchema.extend({ id: recordId(STALE_CONTACT) }),
  handler: async ({ id, ...input }) => updateClientContact(await signedInUser(), id, input),
});

export const removeClientContactAction = defineAction({
  access: adminOnly('systemAdministrator'),
  schema: byContactId,
  handler: async ({ id }) => removeClientContact(await signedInUser(), id),
});

export const restoreClientContactAction = defineAction({
  access: adminOnly('systemAdministrator'),
  schema: byContactId,
  handler: async ({ id }) => restoreClientContact(await signedInUser(), id),
});
