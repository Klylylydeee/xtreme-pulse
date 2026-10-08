import type { ClientSession, Types } from 'mongoose';
import { connectDb, withTransaction } from '@pulse/db';
import { ActionError } from '../../actions';
import { now } from '../../dates';
import {
  type ClientContactInput,
  clientContactInputSchema,
  type ClientContactUpdateInput,
  clientContactUpdateSchema,
} from '../../master-data';
import { recordAudit } from '../audit/service';
import { snapshotForAudit, snapshotsForAudit } from '../audit/snapshot';
import { inputError } from '../departments/service';
import { assertEngageWrite, type MasterDataActor } from '../master-data-access';
import { MASTER_DATA_COLLATION } from '../master-data-collation';
import { toObjectId } from '../paging';
import { isDuplicateKeyError } from '../seed/duplicate-key';
import { type ClientContactRecord, ClientContactModel } from './contact-model';
import { ClientModel } from './model';
import type { MasterDataOption } from '../master-data-access';
import { auditActor, auditLabel } from '../master-data-audit';
import { claimClientOrRefuse } from './shared';

// Spec: docs/modules/core.md#managing-master-data and docs/modules/engage.md#clients-sites-and-contacts
// — a client's contacts. Adding, editing, removing (a soft delete) and restoring need Engage
// Write, and each writes its audit entry (`core.clientContact`, labelled `<client> · <contact>`)
// in the same transaction. Every change claims the live client first (claimLiveClient), so
// nothing changes on a retired client, and two overlapping primary marks conflict and are retried.
//
// - At most one primary contact per client (a partial unique index). Marking one primary clears
//   the old one, with its own `update` entry, in the same transaction.
// - Removing a contact clears its primary flag in the same update, so a removed contact never
//   holds the index's slot and a restored one comes back not primary.

const RECORD_TYPE = 'core.clientContact';

const CONTACT_GONE = 'This contact no longer exists. Reload the page.';

function rethrowDuplicatePrimary(error: unknown): never {
  if (isDuplicateKeyError(error, 'clientId')) {
    throw new ActionError(
      'Another contact was just marked primary. Reload the page and try again.',
      {
        field: 'isPrimary',
      },
    );
  }
  throw error;
}

/**
 * Clears the client's current primary contact (other than `exceptId`), with its audit entry.
 * The caller has claimed the client.
 */
async function clearPrimary(
  actor: MasterDataActor,
  client: { name: string },
  clientId: Types.ObjectId,
  exceptId: Types.ObjectId | null,
  session: ClientSession,
): Promise<void> {
  const filter: Record<string, unknown> = { clientId, isPrimary: true };
  if (exceptId) filter._id = { $ne: exceptId };
  // Removed contacts are never primary, but look at them too so the index can't refuse the mark.
  const current = await ClientContactModel.findOne(filter, null, { withDeleted: true })
    .session(session)
    .lean();
  if (!current) return;

  await ClientContactModel.updateOne(
    // Filtering on deletedAt (its own value) reaches a removed contact too.
    { _id: current._id, deletedAt: current.deletedAt },
    { $set: { isPrimary: false, updatedBy: toObjectId(actor.id) } },
    { session },
  );
  const after = await ClientContactModel.findById(current._id, null, { withDeleted: true })
    .session(session)
    .lean()
    .orFail();
  await recordAudit(
    {
      ...auditActor(actor),
      module: 'core',
      action: 'update',
      record: { type: RECORD_TYPE, id: current._id, label: auditLabel(client.name, after.name) },
      ...snapshotsForAudit(ClientContactModel, current, after),
    },
    { session },
  );
}

/** Loads a contact in the transaction, removed ones included, or refuses. */
async function loadContact(id: string, session: ClientSession) {
  const contactId = toObjectId(id);
  if (!contactId) throw new ActionError(CONTACT_GONE);
  const contact = await ClientContactModel.findById(contactId, null, { withDeleted: true })
    .session(session)
    .lean();
  if (!contact) throw new ActionError(CONTACT_GONE);
  return contact;
}

// --- Reading ---------------------------------------------------------------------------------

/** One of a client's contacts. */
export interface ClientContactView {
  id: string;
  clientId: string;
  name: string;
  position: string | null;
  email: string | null;
  /** As typed. */
  mobile: string | null;
  isPrimary: boolean;
  /** When it was removed; null while it is live. */
  removedAt: Date | null;
  updatedAt: Date;
}

export function contactView(contact: ClientContactRecord): ClientContactView {
  return {
    id: contact._id.toHexString(),
    clientId: contact.clientId.toHexString(),
    name: contact.name,
    position: contact.position,
    email: contact.email,
    mobile: contact.mobile,
    isPrimary: contact.isPrimary,
    removedAt: contact.deletedAt ?? null,
    updatedAt: contact.updatedAt,
  };
}

/**
 * A client's live contacts (id and name only), the primary first and then by name, for other
 * modules' contact pickers. Empty for a retired or unknown client. Any signed-in user may read
 * it; the caller checks the sign-in.
 */
export async function listClientContactOptions(clientId: string): Promise<MasterDataOption[]> {
  const id = toObjectId(clientId);
  if (!id) return [];
  await connectDb();
  if (!(await ClientModel.exists({ _id: id }))) return [];
  const contacts = await ClientContactModel.find({ clientId: id }, { name: 1 })
    .collation(MASTER_DATA_COLLATION)
    .sort({ isPrimary: -1, name: 1, _id: 1 })
    .lean();
  return contacts.map((contact) => ({ id: contact._id.toHexString(), name: contact.name }));
}

// --- Changing --------------------------------------------------------------------------------

/**
 * Adds a contact to a live client. Its client is fixed from then on. Marked primary, it takes
 * over from the current primary contact. Engage Write.
 */
export async function addClientContact(
  actor: MasterDataActor,
  input: ClientContactInput,
): Promise<{ id: string }> {
  assertEngageWrite(actor);
  const parsed = clientContactInputSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const { clientId: clientHex, ...fields } = parsed.data;
  const clientId = toObjectId(clientHex);
  if (!clientId) throw new ActionError('Choose a client.', { field: 'clientId' });

  try {
    return await withTransaction(async (session) => {
      const client = await claimClientOrRefuse(clientId, session);
      if (fields.isPrimary) await clearPrimary(actor, client, clientId, null, session);

      const [created] = await ClientContactModel.create(
        [{ ...fields, clientId, createdBy: toObjectId(actor.id) }],
        { session },
      );
      if (!created) throw new Error('The contact wasn’t created.');
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
          after: snapshotForAudit(ClientContactModel, created),
        },
        { session },
      );
      return { id: created._id.toHexString() };
    });
  } catch (error) {
    rethrowDuplicatePrimary(error);
  }
}

/**
 * Changes a live contact of a live client. Its client can't be changed: an input carrying a
 * different client is refused. Marked primary, it takes over from the current primary contact;
 * unmarked, the client is left with no primary contact. Engage Write.
 */
export async function updateClientContact(
  actor: MasterDataActor,
  id: string,
  input: ClientContactUpdateInput,
): Promise<void> {
  assertEngageWrite(actor);
  const sentClient = (input as { clientId?: unknown }).clientId;
  const parsed = clientContactUpdateSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const fields = parsed.data;

  try {
    await withTransaction(async (session) => {
      const before = await loadContact(id, session);
      if (sentClient !== undefined && String(sentClient) !== before.clientId.toHexString()) {
        throw new ActionError('A contact’s client can’t be changed.', { field: 'clientId' });
      }
      if (before.deletedAt) {
        throw new ActionError('This contact is removed. Restore it first to edit it.');
      }
      const client = await claimClientOrRefuse(before.clientId, session);
      if (fields.isPrimary && !before.isPrimary) {
        await clearPrimary(actor, client, before.clientId, before._id, session);
      }

      await ClientContactModel.updateOne(
        { _id: before._id },
        { $set: { ...fields, updatedBy: toObjectId(actor.id) } },
        { session, runValidators: true },
      );
      const after = await ClientContactModel.findById(before._id).session(session).lean().orFail();
      await recordAudit(
        {
          ...auditActor(actor),
          module: 'core',
          action: 'update',
          record: { type: RECORD_TYPE, id: before._id, label: auditLabel(client.name, after.name) },
          ...snapshotsForAudit(ClientContactModel, before, after),
        },
        { session },
      );
    });
  } catch (error) {
    rethrowDuplicatePrimary(error);
  }
}

/**
 * Removes (soft-deletes) a contact of a live client, clearing its primary flag in the same
 * update. Engage Write.
 */
export async function removeClientContact(actor: MasterDataActor, id: string): Promise<void> {
  assertEngageWrite(actor);

  await withTransaction(async (session) => {
    const before = await loadContact(id, session);
    if (before.deletedAt) throw new ActionError('This contact is already removed.');
    const client = await claimClientOrRefuse(before.clientId, session);

    await ClientContactModel.updateOne(
      { _id: before._id },
      { $set: { deletedAt: now(), isPrimary: false, updatedBy: toObjectId(actor.id) } },
      { session },
    );
    await recordAudit(
      {
        ...auditActor(actor),
        module: 'core',
        action: 'delete',
        record: { type: RECORD_TYPE, id: before._id, label: auditLabel(client.name, before.name) },
        before: snapshotForAudit(ClientContactModel, before),
        after: null,
      },
      { session },
    );
  });
}

/** Restores a removed contact, not primary. Its client must be live. Engage Write. */
export async function restoreClientContact(actor: MasterDataActor, id: string): Promise<void> {
  assertEngageWrite(actor);

  await withTransaction(async (session) => {
    const before = await loadContact(id, session);
    if (!before.deletedAt) throw new ActionError('This contact isn’t removed.');
    const client = await claimClientOrRefuse(before.clientId, session);

    await ClientContactModel.updateOne(
      { _id: before._id, deletedAt: { $ne: null } },
      { $set: { deletedAt: null, isPrimary: false, updatedBy: toObjectId(actor.id) } },
      { session },
    );
    const after = await ClientContactModel.findById(before._id).session(session).lean().orFail();
    await recordAudit(
      {
        ...auditActor(actor),
        module: 'core',
        action: 'restore',
        record: { type: RECORD_TYPE, id: before._id, label: auditLabel(client.name, after.name) },
        ...snapshotsForAudit(ClientContactModel, before, after),
      },
      { session },
    );
  });
}
