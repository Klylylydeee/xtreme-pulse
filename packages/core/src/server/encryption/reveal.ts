import { lastFourOf } from '../../sensitive';
import type { RevealActor } from '../sensitive/policy';
import { revealSensitiveField } from '../sensitive/service';
import { decryptSensitive } from './fields';

// Showing sensitive values (SECURITY.md#sensitive-data): masked by default, and revealing the full
// value is access-checked and audit-logged. From build step 1.3 the reveal goes through
// `revealSensitiveField` (sensitive/service.ts): the record type and field must be registered, the
// reveal rules must allow it for this user, and the audit entry is written before the value is
// decrypted. Phase 0's blanket refusal in production is gone because of those checks.

/** Which record a sensitive value belongs to, for the access check and the audit log entry. */
export interface SensitiveOwner {
  /** The record type as registered (`registerSensitiveReveal`), like `talent.employeeRecord`. */
  type: string;
  id: string;
}

export interface RevealSensitiveInput {
  /** The signed-in user who pressed Reveal. Required: there is no anonymous reveal. */
  actor: RevealActor;
  owner: SensitiveOwner;
  /** The field's name as registered, logged in the audit entry (never its value). */
  field: string;
}

/**
 * Decrypts one sensitive value for a signed-in user who asked to see it in full. The masked field
 * component calls it (through a Server Action) only when the user presses Reveal. Hands off to
 * `revealSensitiveField`, which checks access and writes the audit entry first.
 */
export async function revealSensitive({
  actor,
  owner,
  field,
}: RevealSensitiveInput): Promise<string> {
  return revealSensitiveField({ actor, ownerType: owner.type, ownerId: owner.id, field });
}

/**
 * The last 4 letters or digits of a stored encrypted value, for its masked display. Decrypts on
 * the server and returns only those characters, so the full value never reaches the browser.
 */
export async function sensitiveLastFour(value: unknown): Promise<string> {
  return lastFourOf(await decryptSensitive(value));
}
