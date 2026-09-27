import { mongo, Schema } from 'mongoose';
import { baseSchemaPlugin, connectDb, defineModel } from '@pulse/db';
import { type EncryptedValue, encryptSensitive, sensitiveField } from './fields';
import { revealSensitive, sensitiveLastFour } from './reveal';

// A development sample for `/dev/health` and `/dev/ui` (build step 0.8): one made-up bank account
// number, stored encrypted like any sensitive field. It is not a business record.

/** The made-up sample value. Development data only; never a real account number. */
export const DEV_SAMPLE_PLAINTEXT = '0012-3456-7890';
const SAMPLE_KEY = 'bankAccountNumber';
const SAMPLE_OWNER_TYPE = 'dev.encryptionSample';

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

/** Reveals the sample in full, through the same path as any sensitive field. */
export async function revealDevEncryptionSample(): Promise<string> {
  const sample = await loadDevEncryptionSample();
  return revealSensitive({
    value: sample.value,
    field: 'value',
    owner: { type: SAMPLE_OWNER_TYPE, id: sample.id },
    actorId: null,
  });
}
