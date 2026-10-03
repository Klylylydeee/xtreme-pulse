import { AccessDeniedError, ActionError } from '../../actions';
import { recordAudit } from '../audit/service';
import { decryptSensitive, isEncryptedValue } from '../encryption/fields';
import { toObjectId } from '../paging';
import { canRevealSensitive, type RevealActor } from './policy';
import { findSensitiveReveal } from './registry';

// Spec: SECURITY.md#sensitive-data and docs/adr/0005-field-level-encryption.md — revealing one
// sensitive value in full. The order matters:
//
//   1. the record type and field must be registered (registry.ts), else refused;
//   2. the reveal rules (policy.ts) for this user and this record's employee, else refused;
//   3. load the stored (encrypted) value;
//   4. write the `reveal` audit entry (field name only, never the value or its last 4) and wait
//      for it to be written;
//   5. only then decrypt and return the value.
//
// If the entry can't be written, step 5 never runs and nothing is returned.

const DENIED = 'You don’t have access to see this value.';

export interface RevealSensitiveFieldInput {
  /** The signed-in user (a `CurrentUser`). */
  actor: RevealActor;
  /** The record type, as registered (`talent.employeeRecord`). */
  ownerType: string;
  /** The record's id. */
  ownerId: string;
  /** The field's name, as registered. */
  field: string;
}

/**
 * Reveals one sensitive value for the signed-in user who pressed Reveal. Throws
 * {@link AccessDeniedError} when the field isn't registered or the user may not see it, and
 * {@link ActionError} when there is no value. Audit-logged before the value is returned.
 */
export async function revealSensitiveField({
  actor,
  ownerType,
  ownerId,
  field,
}: RevealSensitiveFieldInput): Promise<string> {
  const found = findSensitiveReveal(ownerType, field);
  const recordId = toObjectId(ownerId);
  if (!found || !recordId) throw new AccessDeniedError(DENIED);
  const { definition, category } = found;

  const subject = await definition.subject(ownerId);
  if (!canRevealSensitive(actor, category, subject)) throw new AccessDeniedError(DENIED);

  const value = await definition.loadValue(ownerId, field);
  if (value === null || value === undefined) {
    throw new ActionError('There’s no value to show. Reload the page.');
  }
  if (!isEncryptedValue(value)) {
    // Never show a stored value that isn't ciphertext, and never put it in the message.
    throw new Error(`The stored value of ${ownerType}.${field} isn't encrypted.`);
  }

  const label = definition.label ? await definition.label(ownerId) : null;
  await recordAudit({
    actorId: actor.id,
    actorEmail: actor.email,
    module: definition.module,
    action: 'reveal',
    record: { type: ownerType, id: recordId, label },
    before: null,
    after: null,
    fields: [field],
  });

  return String(await decryptSensitive(value));
}
