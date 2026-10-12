import type { ClientSession } from 'mongoose';
import { toObjectId } from '../paging';
import type { ApprovalRequestSnapshot } from './registry';

// Spec: docs/modules/core.md#approvals ("E-signatures on decisions") and
// docs/ARCHITECTURE.md#cross-module-integration (decision 177 in docs/BUILD_PLAN.md) — an approve
// decision applies the approver's own current e-signature. Core can't import Pulse Talent, so
// Talent registers the one signer here (`registerTalentApprovalSigner()`, an explicit call made by
// the approvals Server Action beside `registerCoreApprovalTypes()`).
//
// - One slot. Registering again replaces the signer outside production (a hot reload runs the
//   registration again, and tests swap in fakes); in production a second, different signer throws.
// - Fail closed: with no signer registered, an approve is refused. A signer that throws rolls back
//   the decision, its audit entry and its notifications.
// - The signer returns a stamp `{ applicationId, signatureId, version }`, or null when the approver
//   has no signature on file (the decision is then stored with `signature: null`, "Approved
//   without an e-signature", until step 2.6 adds the gate).

/** Which e-signature version an approve decision was signed with. Plain values only. */
export interface ApprovalSignatureStamp {
  /** The `signatureApplications` row that records this use. */
  applicationId: string;
  /** The `eSignatures` version that was applied. */
  signatureId: string;
  /** Its version number (1, 2, 3…). */
  version: number;
}

/** What the signer is given: the approver, what they are signing, and the decision's session. */
export interface ApprovalSignerContext {
  /** The approver deciding now: the signed-in user. The signer signs as this user only. */
  actor: { id: string; email: string };
  /** The record being signed: the approval request. */
  target: { type: string; id: string; label: string };
  /** What was signed, for the application's audit label, for example "Approval: <title>". */
  purpose: string;
  /** The request before the decision. */
  request: ApprovalRequestSnapshot;
  /** The step being approved. */
  stepIndex: number;
  stepLabel: string;
  /** The decision's transaction: every write must use it. */
  session: ClientSession;
}

/**
 * Applies the approver's current e-signature in the decision's transaction and returns the stamp,
 * or null when they have none. Throwing rolls back the decision.
 */
export type ApprovalSigner = (
  context: ApprovalSignerContext,
) => Promise<ApprovalSignatureStamp | null>;

/** Thrown when an approve is attempted with no signer registered. A programming error. */
export class ApprovalSignerNotRegisteredError extends Error {
  constructor() {
    super('No e-signature signer is registered, so the approval was refused.');
    this.name = 'ApprovalSignerNotRegisteredError';
  }
}

// Per process (and per bundle, since Next evaluates server modules once per bundle).
let signer: ApprovalSigner | null = null;

/**
 * Registers the one approval signer (Pulse Talent's). Registering again replaces it outside
 * production; in production registering a different signer throws, so nothing can quietly swap
 * the signer once it is set. Registering the same function again does nothing.
 */
export function registerApprovalSigner(next: ApprovalSigner): void {
  if (typeof next !== 'function') throw new Error('The approval signer must be a function.');
  if (signer === next) return;
  if (signer && process.env.NODE_ENV === 'production') {
    throw new Error('An approval signer is already registered.');
  }
  signer = next;
}

/** True when a signer is registered in this process. */
export function hasApprovalSigner(): boolean {
  return signer !== null;
}

/** Removes the signer, so approves are refused again. For tests only. */
export function unregisterApprovalSigner(): void {
  signer = null;
}

/** The registered signer, or {@link ApprovalSignerNotRegisteredError}. */
export function requireApprovalSigner(): ApprovalSigner {
  if (!signer) throw new ApprovalSignerNotRegisteredError();
  return signer;
}

/** Checks a signer's answer: a stamp with two valid ids and a positive whole version, or null. */
export function checkSignatureStamp(stamp: unknown): ApprovalSignatureStamp | null {
  if (stamp === null) return null;
  if (typeof stamp !== 'object') {
    throw new Error('The approval signer returned something other than a stamp or null.');
  }
  const { applicationId, signatureId, version } = stamp as Record<string, unknown>;
  const application = toObjectId(applicationId);
  const signature = toObjectId(signatureId);
  if (
    !application ||
    !signature ||
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    version < 1
  ) {
    throw new Error('The approval signer returned an invalid stamp.');
  }
  return {
    applicationId: application.toHexString(),
    signatureId: signature.toHexString(),
    version,
  };
}
