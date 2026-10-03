import { isValidObjectId, mongo, Schema } from 'mongoose';
import { baseSchemaPlugin, connectDb, defineModel } from '@pulse/db';
import type { RevealActor } from '../sensitive/policy';
import { registerSensitiveReveal } from '../sensitive/registry';
import { type EncryptedValue, encryptSensitive, sensitiveField } from './fields';
import { revealSensitive, sensitiveLastFour } from './reveal';

// A development sample for `/dev/health` and `/dev/ui` (build step 0.8): one made-up bank account
// number, stored encrypted like any sensitive field. It is not a business record.
//
// From build step 1.3 it is revealed through the same access-checked, audit-logged path as any
// sensitive field. It is registered in development only (in production its reveal is refused as
// unregistered), as a bank account that belongs to no employee: so only the System Administrator,
// HR and Accounting may reveal it, signed in (SECURITY.md#sensitive-data).

/** The made-up sample value. Development data only; never a real account number. */
export const DEV_SAMPLE_PLAINTEXT = '0012-3456-7890';
const SAMPLE_KEY = 'bankAccountNumber';
/** The sample's record type, for the reveal and its audit entry. */
export const DEV_SAMPLE_OWNER_TYPE = 'dev.encryptionSample';
/** The field the masked field reveals. */
export const DEV_SAMPLE_FIELD = 'value';

interface DevEncryptionSample {
  /** Which sample this is; one record per key. */
  key: string;
  value: Buffer;
}

function createModel() {
  const schema = new Schema<DevEncryptionSample>({
    key: { type: String, required: true, immutable: true },
    value: sensitiveField({ required: true }),
  });
  schema.index({ key: 1 }, { unique: true });
  schema.plugin(baseSchemaPlugin, { softDelete: false });
  return defineModel('DevEncryptionSample', schema, 'devEncryptionSamples');
}

// Defined on first use, not on import, so production never creates the collection.
let model: ReturnType<typeof createModel> | null = null;

export function devSampleModel(): ReturnType<typeof createModel> {
  model ??= createModel();
  return model;
}

/** The sample's id and stored (encrypted) value, created the first time. */
export async function loadDevEncryptionSample(): Promise<{ id: string; value: EncryptedValue }> {
  // Connect first: a fresh process (for example /dev/ui opened before any other page) would
  // otherwise leave the query buffering until Mongoose times out.
  await connectDb();
  const Sample = devSampleModel();
  let doc = await Sample.findOne({ key: SAMPLE_KEY }).select('+value');
  if (!doc) {
    try {
      doc = await Sample.create({
        key: SAMPLE_KEY,
        value: await encryptSensitive(DEV_SAMPLE_PLAINTEXT),
      });
    } catch (error) {
      // Another request created it first.
      if ((error as { code?: unknown }).code !== 11000) throw error;
      doc = await Sample.findOne({ key: SAMPLE_KEY }).select('+value').orFail();
    }
  }
  return {
    id: String(doc._id),
    value: new mongo.Binary(doc.value, mongo.Binary.SUBTYPE_ENCRYPTED),
  };
}

/** The sample's last 4 characters, for its masked display on `/dev/ui`. */
export async function devEncryptionSampleLastFour(): Promise<string> {
  return sensitiveLastFour((await loadDevEncryptionSample()).value);
}

/**
 * What `/dev/ui`'s masked field needs: the last 4 characters, and the identifiers its Reveal
 * button sends to the reveal Server Action.
 */
export async function devEncryptionSampleForDisplay(): Promise<{
  lastFour: string;
  ownerType: string;
  ownerId: string;
  field: string;
}> {
  const sample = await loadDevEncryptionSample();
  return {
    lastFour: await sensitiveLastFour(sample.value),
    ownerType: DEV_SAMPLE_OWNER_TYPE,
    ownerId: sample.id,
    field: DEV_SAMPLE_FIELD,
  };
}

/** Reveals the sample in full for a signed-in user, through the same path as any sensitive field. */
export async function revealDevEncryptionSample(actor: RevealActor): Promise<string> {
  const sample = await loadDevEncryptionSample();
  return revealSensitive({
    actor,
    owner: { type: DEV_SAMPLE_OWNER_TYPE, id: sample.id },
    field: DEV_SAMPLE_FIELD,
  });
}

if (process.env.NODE_ENV !== 'production') {
  registerSensitiveReveal(DEV_SAMPLE_OWNER_TYPE, {
    module: 'core',
    fields: { [DEV_SAMPLE_FIELD]: 'bankAccount' },
    async loadValue(ownerId) {
      if (!isValidObjectId(ownerId)) return null;
      await connectDb();
      const doc = await devSampleModel().findById(ownerId).select('+value');
      return doc ? new mongo.Binary(doc.value, mongo.Binary.SUBTYPE_ENCRYPTED) : null;
    },
    // Development data: no employee, so the own-record and Board rules never apply.
    subject: async () => null,
  });
}
