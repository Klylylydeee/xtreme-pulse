import { mongo } from 'mongoose';
import { redactConnectionString } from '@pulse/db';
import { lastFourOf } from '../../sensitive';
import type { HelperCheck } from '../dev-health';
import { devSampleModel, DEV_SAMPLE_PLAINTEXT, loadDevEncryptionSample } from './dev-sample';
import {
  decryptSensitive,
  encryptSensitive,
  EncryptedValueFormatError,
  isEncryptedValue,
} from './fields';
import { DecryptionFailedError } from './aead';
import { inspectKeyVault, KEY_VAULT_COLLECTION, wrongMasterKeyIsRefused } from './key-vault';
import {
  EncryptionKeyInvalidError,
  EncryptionNotConfiguredError,
  MASTER_KEY_BYTES,
  readMasterKey,
} from './master-key';

// The field encryption checks for the development `/dev/health` page (build step 0.8). They use
// the development sample only, and never show the master key, a data key or the sample in full.

export interface EncryptionCheck extends HelperCheck {
  /** The value is one long word (ciphertext) that may break anywhere. */
  breakAnywhere?: boolean;
}

export type EncryptionHealth =
  | { status: 'not-configured' }
  | { status: 'invalid-key' }
  | { status: 'checked'; checks: EncryptionCheck[]; error: string | null };

function describe(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown error';
  return redactConnectionString(message);
}

/** Runs the encryption checks. Never throws. Needs a working database. */
export async function checkEncryption(): Promise<EncryptionHealth> {
  try {
    readMasterKey().fill(0);
  } catch (error) {
    if (error instanceof EncryptionNotConfiguredError) return { status: 'not-configured' };
    if (error instanceof EncryptionKeyInvalidError) return { status: 'invalid-key' };
    return { status: 'checked', checks: [], error: describe(error) };
  }

  const checks: EncryptionCheck[] = [
    { label: 'Master key', value: `Loaded, ${MASTER_KEY_BYTES} bytes`, ok: true },
  ];
  try {
    const vault = await inspectKeyVault();
    checks.push({
      label: 'Key vault',
      value: `${vault.dataKeys} data ${vault.dataKeys === 1 ? 'key' : 'keys'} in ${KEY_VAULT_COLLECTION}, unwrapped`,
      ok: vault.defaultKeyUnwraps,
    });
    const wrongKeyRefused = await wrongMasterKeyIsRefused();
    checks.push({
      label: 'Wrong master key',
      value: wrongKeyRefused ? 'Refused' : 'Not refused',
      ok: wrongKeyRefused,
    });

    // What is actually in the database, read past Mongoose.
    const sample = await loadDevEncryptionSample();
    const raw = await devSampleModel().collection.findOne({ _id: new mongo.ObjectId(sample.id) });
    const stored: unknown = raw?.value;
    const rawBytes = raw ? Buffer.from(mongo.BSON.serialize(raw)) : Buffer.alloc(0);
    const plaintextAbsent =
      raw !== null &&
      !rawBytes.includes(Buffer.from(DEV_SAMPLE_PLAINTEXT, 'utf8')) &&
      !rawBytes.includes(Buffer.from(DEV_SAMPLE_PLAINTEXT.replace(/\D/g, ''), 'utf8'));
    const isCiphertext =
      stored instanceof mongo.Binary &&
      stored.sub_type === mongo.Binary.SUBTYPE_ENCRYPTED &&
      isEncryptedValue(stored);
    checks.push({
      label: 'Sample stored as',
      value: isCiphertext
        ? `Ciphertext, binary subtype 6, ${stored.length()} bytes`
        : 'Not ciphertext',
      ok: isCiphertext,
    });
    checks.push({
      label: 'Plaintext in the database',
      value: plaintextAbsent ? 'None' : 'Found',
      ok: plaintextAbsent,
    });
    if (isCiphertext) {
      checks.push({
        label: 'Stored value',
        value: Buffer.from(stored.value()).toString('base64'),
        ok: null,
        breakAnywhere: true,
      });
    }

    const decrypted = await decryptSensitive(sample.value);
    checks.push({
      label: 'Decrypts back',
      value:
        decrypted === DEV_SAMPLE_PLAINTEXT
          ? `Matches the sample (ends in ${lastFourOf(decrypted)})`
          : 'Doesn’t match the sample',
      ok: decrypted === DEV_SAMPLE_PLAINTEXT,
    });

    const again = await encryptSensitive(DEV_SAMPLE_PLAINTEXT);
    const differs = !Buffer.from(again.value()).equals(Buffer.from(sample.value.value()));
    checks.push({
      label: 'Same value encrypted again',
      value: differs ? 'Different ciphertext' : 'Same ciphertext',
      ok: differs,
    });

    const tampered = Buffer.from(sample.value.value());
    tampered[tampered.length - 40] = (tampered[tampered.length - 40] ?? 0) ^ 0x01;
    let tamperRefused = false;
    try {
      await decryptSensitive(new mongo.Binary(tampered, mongo.Binary.SUBTYPE_ENCRYPTED));
    } catch (error) {
      tamperRefused = error instanceof DecryptionFailedError;
    }
    checks.push({
      label: 'Altered ciphertext',
      value: tamperRefused ? 'Refused' : 'Not refused',
      ok: tamperRefused,
    });

    // A plaintext value assigned to a sensitive field never validates.
    const plain = new (devSampleModel())({ key: 'plaintext-probe', value: DEV_SAMPLE_PLAINTEXT });
    const plainRefused = (await plain.validate().then(
      () => false,
      () => true,
    )) as boolean;
    let notEncryptedRefused = false;
    try {
      await decryptSensitive(Buffer.from(DEV_SAMPLE_PLAINTEXT));
    } catch (error) {
      notEncryptedRefused = error instanceof EncryptedValueFormatError;
    }
    checks.push({
      label: 'Plaintext in a sensitive field',
      value: plainRefused && notEncryptedRefused ? 'Refused' : 'Not refused',
      ok: plainRefused && notEncryptedRefused,
    });
    return { status: 'checked', checks, error: null };
  } catch (error) {
    return { status: 'checked', checks, error: describe(error) };
  }
}
