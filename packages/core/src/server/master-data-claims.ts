import type { ClientSession, Types } from 'mongoose';
import { type BrandRecord, BrandModel } from './brands/model';
import { type ClientRecord, ClientModel } from './clients/model';

// Spec: docs/modules/core.md#managing-master-data ("Overlapping changes") — like the department
// and position claims (org-claims.ts), a master data change writes the records it depends on
// inside its transaction, so an overlapping retire conflicts and `withTransaction` retries it:
//
// - adding or restoring a catalog item writes its product (`claimLiveBrand`), against
//   `retireBrand` counting live items and then writing the product;
// - adding or restoring a site or contact, and marking a primary contact, writes its client
//   (`claimLiveClient`), against `retireClient`, and against another primary mark on the same
//   client;
// - saving a supplier writes each newly picked product (`claimLiveBrands`).
//
// Each write only bumps the version key, with timestamps off, so `updatedAt` and `updatedBy` keep
// saying who last edited the record, and no audit entry is due (`__v` isn't snapshotted). A
// retired record matches nothing, so the caller refuses it.

/**
 * Writes to the client in the transaction and returns its name (for audit labels), or null when
 * it is retired or unknown.
 */
export async function claimLiveClient(
  clientId: Types.ObjectId,
  session: ClientSession,
): Promise<Pick<ClientRecord, '_id' | 'name'> | null> {
  const result = await ClientModel.updateOne(
    { _id: clientId, deletedAt: null },
    { $inc: { __v: 1 } },
    { session, timestamps: false },
  );
  if (result.matchedCount !== 1) return null;
  return ClientModel.findById(clientId, { name: 1 }).session(session).lean().orFail();
}

/**
 * Writes to the product in the transaction and returns its name (for audit labels), or null when
 * it is retired or unknown.
 */
export async function claimLiveBrand(
  brandId: Types.ObjectId,
  session: ClientSession,
): Promise<Pick<BrandRecord, '_id' | 'name'> | null> {
  const result = await BrandModel.updateOne(
    { _id: brandId, deletedAt: null },
    { $inc: { __v: 1 } },
    { session, timestamps: false },
  );
  if (result.matchedCount !== 1) return null;
  return BrandModel.findById(brandId, { name: 1 }).session(session).lean().orFail();
}

/**
 * Writes to each product in the transaction and returns true when every one is live. False when
 * any is retired or unknown; the caller then refuses the change, which rolls back the writes.
 * Repeated ids count once.
 */
export async function claimLiveBrands(
  brandIds: readonly Types.ObjectId[],
  session: ClientSession,
): Promise<boolean> {
  const unique = [...new Map(brandIds.map((id) => [id.toHexString(), id])).values()];
  if (unique.length === 0) return true;
  const result = await BrandModel.updateMany(
    { _id: { $in: unique }, deletedAt: null },
    { $inc: { __v: 1 } },
    { session, timestamps: false },
  );
  return result.matchedCount === unique.length;
}
