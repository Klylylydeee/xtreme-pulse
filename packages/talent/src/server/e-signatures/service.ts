import { type ClientSession, Types } from 'mongoose';
import { connectDb, withTransaction } from '@pulse/db';
import { AccessDeniedError, ActionError, now } from '@pulse/core';
import {
  type ApprovalSignatureStamp,
  type ApprovalSigner,
  employeeAuditLabel,
  recordAudit,
  registerApprovalSigner,
  reloadActorAccess,
  saveUpload,
  snapshotForAudit,
  TRANSFORMABLE_TYPES,
} from '@pulse/core/server';
import type { SignaturePurpose } from '../../fixed-sets';
import { assertOnboardingGate } from '../../onboarding/gates';
import { eSignatureItemState } from '../../onboarding/status';
import {
  E_SIGNATURE_TYPE,
  type ESignatureStatusView,
  type OwnESignatureVersionView,
  SIGNATURE_APPLICATION_TYPE,
} from '../../views';
import { canSeeESignatureImage, NO_EMPLOYEE_SIGNATURE, type TalentActor } from '../policy';
import { auditLabelOf, inlineFileUrlOf, isDuplicateKey, objectIdOf } from '../shared';
import { type ESignatureRecord, ESignatureModel, SignatureApplicationModel } from './model';

// Spec: docs/modules/talent.md#documents-photo-e-signature-and-certifications-build-step-22,
// SECURITY.md#sensitive-data and docs/ARCHITECTURE.md#cross-module-integration ("E-signatures on
// approvals"), decisions 175–177 in docs/BUILD_PLAN.md.
//
// - Upload: only the employee uploads their own signature; the service takes no employee id. Each
//   upload is version n + 1, re-encoded as PNG of at most 1200 px with its metadata stripped, and
//   one `create` entry on `talent.eSignature` (`<employee number> · version <n>`). Nothing removes
//   a signature: it is replaced, never cleared. The system account has no employee, so no
//   signature.
// - Apply: `applyESignature` signs as the actor only, in the caller's transaction. It reads the
//   actor's employee from the database (never from the request), pins the current version and its
//   file in a `signatureApplications` row, audits a `create` on `talent.signatureApplication`
//   (`<employee number> · <what was signed>`), and returns the stamp, or null for the system
//   account (no employee). From step 2.6 an employee with no signature is refused by the onboarding
//   gate (OnboardingGateError), which rolls back the caller's transaction. Applications,
//   signatures and their files are never changed or deleted, so a signed record keeps its version
//   after a replacement.
// - The image opens for the owner (every version) and the System Administrator only.

const UPLOAD_CHANGED =
  'Another signature was uploaded at the same time. Reload the page and try again.';

/** The audit label of a signature version. */
function versionLabel(employeeNumber: string, version: number): string {
  return `${employeeNumber} · version ${version}`;
}

async function employeeNumberOf(
  employeeId: Types.ObjectId,
  session: ClientSession | null,
): Promise<string> {
  const employee = await employeeAuditLabel(employeeId, { session });
  if (!employee) throw new ActionError('Your employee record no longer exists.');
  return employee.employeeNumber;
}

/** The latest (current) signature of an employee, or null. */
async function currentSignature(
  employeeId: Types.ObjectId,
  session: ClientSession | null = null,
): Promise<ESignatureRecord | null> {
  return ESignatureModel.findOne({ employeeId })
    .sort({ version: -1 })
    .session(session)
    .lean<ESignatureRecord>();
}

/**
 * Uploads a new version of the signed-in user's own e-signature (form field `signature`: a JPEG,
 * PNG or WebP image, re-encoded as PNG). Takes no employee id: it is always the actor's. Refused
 * for the system account. One `create` entry on `talent.eSignature`.
 *
 * The file is saved before the transaction (a side effect); if the transaction then fails, the
 * saved file is left unused and never opens.
 */
export async function uploadESignature(
  actor: TalentActor,
  file: File,
): Promise<{ signatureId: string; version: number }> {
  if (!actor.employee) throw new AccessDeniedError(NO_EMPLOYEE_SIGNATURE);
  const ownEmployeeId = actor.employee.id;
  await connectDb();

  const signatureId = new Types.ObjectId();
  const stored = await saveUpload({
    file,
    owner: { type: E_SIGNATURE_TYPE, id: signatureId },
    actorId: objectIdOf(actor.id),
    accept: TRANSFORMABLE_TYPES,
    field: 'signature',
    transform: 'signature',
  });
  const fileId = objectIdOf(stored.id);
  if (!fileId) throw new Error('The stored signature has no valid id.');

  try {
    return await withTransaction(async (session) => {
      const current = await reloadActorAccess({ id: actor.id }, session);
      // The employee is the actor's own, as stored now; the session's is only cross-checked.
      if (!current.employee || current.employee.id !== ownEmployeeId) {
        throw new AccessDeniedError(NO_EMPLOYEE_SIGNATURE);
      }
      const employeeId = new Types.ObjectId(current.employee.id);
      const latest = await currentSignature(employeeId, session);
      const version = (latest?.version ?? 0) + 1;
      const actorId = new Types.ObjectId(current.id);
      const signature = new ESignatureModel({
        _id: signatureId,
        employeeId,
        version,
        fileId,
        createdBy: actorId,
        updatedBy: actorId,
      });
      await signature.save({ session });
      await recordAudit(
        {
          actorId: current.id,
          actorEmail: current.email,
          module: 'talent',
          action: 'create',
          record: {
            type: E_SIGNATURE_TYPE,
            id: signatureId,
            label: versionLabel(await employeeNumberOf(employeeId, session), version),
          },
          before: null,
          after: snapshotForAudit(ESignatureModel, signature),
        },
        { session },
      );
      return { signatureId: signatureId.toHexString(), version };
    });
  } catch (error) {
    // Two uploads at once: the unique { employeeId, version } index refused the second.
    if (isDuplicateKey(error)) throw new ActionError(UPLOAD_CHANGED, { field: 'signature' });
    throw error;
  }
}

/**
 * Every version of the signed-in user's own e-signature, newest first, with how often each was
 * applied (/talent/me's version history). Empty for the system account. Takes no employee id.
 */
export async function listOwnESignatures(actor: TalentActor): Promise<OwnESignatureVersionView[]> {
  if (!actor.employee) return [];
  const employeeId = objectIdOf(actor.employee.id);
  if (!employeeId) return [];
  await connectDb();
  const [versions, counts] = await Promise.all([
    ESignatureModel.find({ employeeId }).sort({ version: -1 }).lean<ESignatureRecord[]>(),
    SignatureApplicationModel.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { employeeId } },
      { $group: { _id: '$signatureId', count: { $sum: 1 } } },
    ]),
  ]);
  const countById = new Map(counts.map((row) => [row._id.toHexString(), row.count]));
  return versions.map((signature, index) => ({
    id: signature._id.toHexString(),
    version: signature.version,
    imageUrl: inlineFileUrlOf(signature.fileId),
    uploadedAt: signature.createdAt,
    applicationCount: countById.get(signature._id.toHexString()) ?? 0,
    current: index === 0,
  }));
}

/**
 * The e-signature status of `employeeId`'s record for `viewer`: the current version for everyone
 * ("E-signature on file, version N" or "Not uploaded"), and its image only for the owner and the
 * System Administrator.
 */
export async function getESignatureStatus(
  viewer: TalentActor,
  employeeId: string,
): Promise<ESignatureStatusView> {
  const id = objectIdOf(employeeId);
  const latest = id ? await currentSignature(id) : null;
  const status: ESignatureStatusView = { version: latest?.version ?? null };
  if (canSeeESignatureImage(viewer, employeeId)) {
    status.imageUrl = latest ? inlineFileUrlOf(latest.fileId) : null;
  }
  return status;
}

export interface ApplyESignatureInput {
  /** The signed-in user signing: the signature applied is always theirs. */
  actor: { id: string };
  /** What is being signed, for example `{ type: 'core.approvalRequest', id, label }`. */
  target: { type: string; id: string; label: string };
  purpose: SignaturePurpose;
  /** What was signed, for the audit label (for example "Approval: <title>"). Default: the target's label. */
  description?: string;
  /** The caller's transaction: the application and its audit entry commit with the signed record. */
  session: ClientSession;
}

/**
 * Applies the actor's own current e-signature to `target`, in the caller's transaction, and
 * returns the stamp `{ applicationId, signatureId, version }`, or null when the actor has no
 * employee (the system account, exempt from the gate). An employee with no signature on file is
 * refused with `OnboardingGateError` ("Complete this onboarding item first: E-signature…"),
 * which rolls back the caller's transaction. Takes no employee id: the actor's employee is read
 * from the database. One `create` entry on `talent.signatureApplication`.
 */
export async function applyESignature({
  actor,
  target,
  purpose,
  description,
  session,
}: ApplyESignatureInput): Promise<ApprovalSignatureStamp | null> {
  const targetId = objectIdOf(target.id);
  if (!targetId) throw new Error('The record being signed has no valid id.');
  const current = await reloadActorAccess({ id: actor.id }, session);
  if (!current.employee) return null;
  const employeeId = new Types.ObjectId(current.employee.id);
  const signature = await currentSignature(employeeId, session);
  // The onboarding gate (step 2.6, decision 264): an employee with no signature is refused, naming
  // the item. It throws in the caller's transaction, so the signed decision rolls back; it writes
  // nothing. Only the system account (no employee, above) still signs nothing.
  assertOnboardingGate('applyESignature', {
    states: { eSignature: eSignatureItemState(signature !== null) },
  });
  if (!signature) return null;

  const actorId = new Types.ObjectId(current.id);
  const application = new SignatureApplicationModel({
    employeeId,
    userId: actorId,
    signatureId: signature._id,
    signatureVersion: signature.version,
    fileId: signature.fileId,
    target: { type: target.type, id: targetId, label: target.label },
    purpose,
    appliedAt: now(),
    createdBy: actorId,
    updatedBy: actorId,
  });
  await application.save({ session });
  const employeeNumber = await employeeNumberOf(employeeId, session);
  await recordAudit(
    {
      actorId: current.id,
      actorEmail: current.email,
      module: 'talent',
      action: 'create',
      record: {
        type: SIGNATURE_APPLICATION_TYPE,
        id: application._id,
        label: auditLabelOf(employeeNumber, description ?? target.label),
      },
      before: null,
      after: snapshotForAudit(SignatureApplicationModel, application),
    },
    { session },
  );
  return {
    applicationId: application._id.toHexString(),
    signatureId: signature._id.toHexString(),
    version: signature.version,
  };
}

/** The signer Core's approvals engine calls on an approve decision (one function, so registering again is a no-op). */
const talentApprovalSigner: ApprovalSigner = (context) =>
  applyESignature({
    actor: context.actor,
    target: context.target,
    purpose: 'approval',
    description: context.purpose,
    session: context.session,
  });

/**
 * Registers Talent's e-signature signer with Core's approvals engine (`registerApprovalSigner`).
 * The approvals Server Action calls it beside `registerCoreApprovalTypes()`, before deciding. Safe
 * to call on every request.
 */
export function registerTalentApprovalSigner(): void {
  registerApprovalSigner(talentApprovalSigner);
}
