import type { ClientSession, Types } from 'mongoose';
import { connectDb, withTransaction } from '@pulse/db';
import { ActionError } from '../../actions';
import { now } from '../../dates';
import {
  type ClientSiteInput,
  clientSiteInputSchema,
  type ClientSiteUpdateInput,
  clientSiteUpdateSchema,
} from '../../master-data';
import { recordAudit } from '../audit/service';
import { snapshotForAudit, snapshotsForAudit } from '../audit/snapshot';
import { inputError } from '../departments/service';
import { assertEngageWrite, type MasterDataActor } from '../master-data-access';
import { MASTER_DATA_COLLATION } from '../master-data-collation';
import { toObjectId } from '../paging';
import { isDuplicateKeyError } from '../seed/duplicate-key';
import { ClientModel } from './model';
import type { MasterDataOption } from '../master-data-access';
import { auditActor, auditLabel } from '../master-data-audit';
import { claimClientOrRefuse } from './shared';
import { type ClientSiteRecord, ClientSiteModel } from './site-model';

// Spec: docs/modules/core.md#managing-master-data and docs/modules/engage.md#clients-sites-and-contacts
// — a client's sites. Adding, editing, removing (a soft delete) and restoring need Engage Write,
// and each writes its audit entry (`core.clientSite`, labelled `<client> · <site>`) in the same
// transaction. Every change claims the live client first (claimLiveClient), so nothing changes
// on a retired client and an overlapping retire is retried. A site name is unique within its
// client ignoring case, removed sites included.

const RECORD_TYPE = 'core.clientSite';

const SITE_GONE = 'This site no longer exists. Reload the page.';
const NAME_TAKEN = 'This client already has a site with this name. Choose another name.';
const NAME_TAKEN_BY_REMOVED =
  'A removed site of this client has this name. Restore that site instead, or choose another name.';

function rethrowDuplicateName(error: unknown): never {
  if (isDuplicateKeyError(error, 'name')) {
    throw new ActionError(
      'This client already has a site with this name (removed sites keep theirs). Choose another name, or restore the removed site.',
      { field: 'name' },
    );
  }
  throw error;
}

/** Refuses a name another site of the client has, ignoring case, removed ones included. */
async function assertNameFree(
  clientId: Types.ObjectId,
  name: string,
  exceptId: Types.ObjectId | null,
  session: ClientSession,
): Promise<void> {
  const filter: Record<string, unknown> = { clientId, name };
  if (exceptId) filter._id = { $ne: exceptId };
  const taken = await ClientSiteModel.findOne(filter, { deletedAt: 1 })
    .setOptions({ withDeleted: true })
    .collation(MASTER_DATA_COLLATION)
    .session(session)
    .lean();
  if (taken) {
    throw new ActionError(taken.deletedAt ? NAME_TAKEN_BY_REMOVED : NAME_TAKEN, { field: 'name' });
  }
}

/** Loads a site in the transaction, removed ones included, or refuses. */
async function loadSite(id: string, session: ClientSession) {
  const siteId = toObjectId(id);
  if (!siteId) throw new ActionError(SITE_GONE);
  const site = await ClientSiteModel.findById(siteId, null, { withDeleted: true })
    .session(session)
    .lean();
  if (!site) throw new ActionError(SITE_GONE);
  return site;
}

// --- Reading ---------------------------------------------------------------------------------

/** One of a client's sites. */
export interface ClientSiteView {
  id: string;
  clientId: string;
  name: string;
  address: string | null;
  city: string | null;
  siteContact: string | null;
  /** When it was removed; null while it is live. */
  removedAt: Date | null;
  updatedAt: Date;
}

export function siteView(site: ClientSiteRecord): ClientSiteView {
  return {
    id: site._id.toHexString(),
    clientId: site.clientId.toHexString(),
    name: site.name,
    address: site.address,
    city: site.city,
    siteContact: site.siteContact,
    removedAt: site.deletedAt ?? null,
    updatedAt: site.updatedAt,
  };
}

/**
 * A client's live sites (id and name only), by name, for other modules' site pickers. Empty for
 * a retired or unknown client. Any signed-in user may read it; the caller checks the sign-in.
 */
export async function listClientSiteOptions(clientId: string): Promise<MasterDataOption[]> {
  const id = toObjectId(clientId);
  if (!id) return [];
  await connectDb();

  if (!(await ClientModel.exists({ _id: id }))) return [];
  const sites = await ClientSiteModel.find({ clientId: id }, { name: 1 })
    .collation(MASTER_DATA_COLLATION)
    .sort({ name: 1, _id: 1 })
    .lean();
  return sites.map((site) => ({ id: site._id.toHexString(), name: site.name }));
}

// --- Changing --------------------------------------------------------------------------------

/** Adds a site to a live client. Its client is fixed from then on. Engage Write. */
export async function addClientSite(
  actor: MasterDataActor,
  input: ClientSiteInput,
): Promise<{ id: string }> {
  assertEngageWrite(actor);
  const parsed = clientSiteInputSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const { clientId: clientHex, ...fields } = parsed.data;
  const clientId = toObjectId(clientHex);
  if (!clientId) throw new ActionError('Choose a client.', { field: 'clientId' });

  try {
    return await withTransaction(async (session) => {
      const client = await claimClientOrRefuse(clientId, session);
      await assertNameFree(clientId, fields.name, null, session);

      const [created] = await ClientSiteModel.create(
        [{ ...fields, clientId, createdBy: toObjectId(actor.id) }],
        { session },
      );
      if (!created) throw new Error('The site wasn’t created.');
      await recordAudit(
        {
          ...auditActor(actor),
          module: 'core',
          action: 'create',
          record: {
            type: RECORD_TYPE,
            id: created._id,
            label: auditLabel(client.name, created.name),
          },
          before: null,
          after: snapshotForAudit(ClientSiteModel, created),
        },
        { session },
      );
      return { id: created._id.toHexString() };
    });
  } catch (error) {
    rethrowDuplicateName(error);
  }
}

/**
 * Changes a live site of a live client. Its client can't be changed: an input carrying a
 * different client is refused. Engage Write.
 */
export async function updateClientSite(
  actor: MasterDataActor,
  id: string,
  input: ClientSiteUpdateInput,
): Promise<void> {
  assertEngageWrite(actor);
  const sentClient = (input as { clientId?: unknown }).clientId;
  const parsed = clientSiteUpdateSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const fields = parsed.data;

  try {
    await withTransaction(async (session) => {
      const before = await loadSite(id, session);
      if (sentClient !== undefined && String(sentClient) !== before.clientId.toHexString()) {
        throw new ActionError('A site’s client can’t be changed.', { field: 'clientId' });
      }
      if (before.deletedAt) {
        throw new ActionError('This site is removed. Restore it first to edit it.');
      }
      const client = await claimClientOrRefuse(before.clientId, session);
      await assertNameFree(before.clientId, fields.name, before._id, session);

      await ClientSiteModel.updateOne(
        { _id: before._id },
        { $set: { ...fields, updatedBy: toObjectId(actor.id) } },
        { session, runValidators: true },
      );
      const after = await ClientSiteModel.findById(before._id).session(session).lean().orFail();
      await recordAudit(
        {
          ...auditActor(actor),
          module: 'core',
          action: 'update',
          record: { type: RECORD_TYPE, id: before._id, label: auditLabel(client.name, after.name) },
          ...snapshotsForAudit(ClientSiteModel, before, after),
        },
        { session },
      );
    });
  } catch (error) {
    rethrowDuplicateName(error);
  }
}

/** Removes (soft-deletes) a site of a live client. Engage Write. */
export async function removeClientSite(actor: MasterDataActor, id: string): Promise<void> {
  assertEngageWrite(actor);

  await withTransaction(async (session) => {
    const before = await loadSite(id, session);
    if (before.deletedAt) throw new ActionError('This site is already removed.');
    const client = await claimClientOrRefuse(before.clientId, session);

    await ClientSiteModel.updateOne(
      { _id: before._id },
      { $set: { deletedAt: now(), updatedBy: toObjectId(actor.id) } },
      { session },
    );
    await recordAudit(
      {
        ...auditActor(actor),
        module: 'core',
        action: 'delete',
        record: { type: RECORD_TYPE, id: before._id, label: auditLabel(client.name, before.name) },
        before: snapshotForAudit(ClientSiteModel, before),
        after: null,
      },
      { session },
    );
  });
}

/** Restores a removed site, unchanged. Its client must be live. Engage Write. */
export async function restoreClientSite(actor: MasterDataActor, id: string): Promise<void> {
  assertEngageWrite(actor);

  await withTransaction(async (session) => {
    const before = await loadSite(id, session);
    if (!before.deletedAt) throw new ActionError('This site isn’t removed.');
    const client = await claimClientOrRefuse(before.clientId, session);

    await ClientSiteModel.updateOne(
      { _id: before._id, deletedAt: { $ne: null } },
      { $set: { deletedAt: null, updatedBy: toObjectId(actor.id) } },
      { session },
    );
    const after = await ClientSiteModel.findById(before._id).session(session).lean().orFail();
    await recordAudit(
      {
        ...auditActor(actor),
        module: 'core',
        action: 'restore',
        record: { type: RECORD_TYPE, id: before._id, label: auditLabel(client.name, after.name) },
        ...snapshotsForAudit(ClientSiteModel, before, after),
      },
      { session },
    );
  });
}
