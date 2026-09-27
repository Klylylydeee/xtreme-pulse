import type { Types } from 'mongoose';
import { AccessDeniedError } from '../../actions';
import { lastFourOf } from '../../sensitive';
import { decryptSensitive } from './fields';

// Showing sensitive values (SECURITY.md#sensitive-data): masked by default, and revealing the full
// value is access-checked and audit-logged.
//
// PHASE 1 EXTENSION POINT. There is no sign-in, access check or audit log yet, so a reveal can't
// be checked or logged. Until Phase 1 fills in `revealSensitive`, it works in development only and
// refuses EVERY reveal in production, like `noAccessCheckYet`. Phase 1 must:
//   - check that the signed-in user may see this field of this record (the Sensitive data rules:
//     HR, Accounting, the System Administrator, the employee's own record, and the exceptions),
//   - write the audit log entry: the field name, the record (`owner`) and the actor, never the
//     value (SECURITY.md#audit-logging),
//   - and only then remove the production refusal below.

/** Which record a sensitive value belongs to, for the access check and the audit log entry. */
export interface SensitiveOwner {
  /** The record type, for example `talent.employeeRecord`. */
  type: string;
  id: string | null;
}

export interface RevealSensitiveInput {
  /** The stored encrypted value. */
  value: unknown;
  /** The field's name, logged in the audit entry (never its value), for example `bankAccountNumber`. */
  field: string;
  owner: SensitiveOwner;
  /** The user revealing it; null only for development pages until sign-in exists (step 1.x). */
  actorId: Types.ObjectId | null;
}

/**
 * Decrypts one sensitive value for a user who asked to see it in full. The masked field component
 * calls it (through a Server Action) only when the user presses Reveal.
 */
export async function revealSensitive(input: RevealSensitiveInput): Promise<string> {
  if (process.env.NODE_ENV === 'production') {
    throw new AccessDeniedError(
      'Revealing sensitive data has no access check or audit log yet, so it is turned off.',
    );
  }
  return String(await decryptSensitive(input.value));
}

/**
 * The last 4 letters or digits of a stored encrypted value, for its masked display. Decrypts on
 * the server and returns only those characters, so the full value never reaches the browser.
 */
export async function sensitiveLastFour(value: unknown): Promise<string> {
  return lastFourOf(await decryptSensitive(value));
}
