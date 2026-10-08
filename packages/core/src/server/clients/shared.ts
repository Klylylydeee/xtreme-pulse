import type { ClientSession, Types } from 'mongoose';
import { ActionError } from '../../actions';
import { claimLiveClient } from '../master-data-claims';

// Helpers shared by the client, site and contact services (service.ts, sites.ts, contacts.ts).

const CLIENT_NOT_LIVE =
  'This client is retired or no longer exists. Restore the client first, or reload the page.';

/**
 * Writes to the client in the transaction (so an overlapping retire conflicts and is retried) and
 * returns its name, or refuses when it is retired or unknown. Every site and contact change
 * calls it.
 */
export async function claimClientOrRefuse(
  clientId: Types.ObjectId,
  session: ClientSession,
): Promise<{ name: string }> {
  const client = await claimLiveClient(clientId, session);
  if (!client) throw new ActionError(CLIENT_NOT_LIVE, { field: 'clientId' });
  return client;
}
