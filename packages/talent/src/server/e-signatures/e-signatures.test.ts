import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { connectDb, withTransaction } from '@pulse/db';
import { AccessDeniedError } from '@pulse/core';
import {
  type ApprovalHookContext,
  decideApproval,
  openAccessibleFile,
  registerApprovalType,
  submitApproval,
} from '@pulse/core/server';
import { OnboardingGateError } from '../../onboarding/gates';
import { E_SIGNATURE_TYPE, SIGNATURE_APPLICATION_TYPE } from '../../views';
import { getEmployeeRecordView, getOwnRecordView } from '../employee-records/service';
import { registerTalentFileAccess } from '../files/registrations';
import {
  auditEntries,
  currentUser,
  database,
  type Department,
  department,
  pngFile,
  type Person,
  person,
  systemAccount,
} from '../testing/fixtures';
import { ESignatureModel, SignatureApplicationModel } from './model';
import {
  applyESignature,
  listOwnESignatures,
  registerTalentApprovalSigner,
  uploadESignature,
} from './service';

// The e-signature (build step 2.2, decisions 175–177 in docs/BUILD_PLAN.md,
// docs/TESTING.md#document-e-signature-and-certification-tests): owner-only versions, the signer
// on approve decisions (the step's "Done when": a signed record keeps its version after a
// replacement), the guards, the image access and the audit. Made-up people and images only.

const TYPE = 'talent.signatureTest';

let storageDir: string;
let NET: Department;
let HRD: Department;
let admin: Person;
let hr: Person;
let requester: Person;
const hookStamps: ApprovalHookContext['decision']['signature'][] = [];

beforeAll(async () => {
  storageDir = await mkdtemp(path.join(tmpdir(), 'pulse-test-storage-'));
  process.env.FILE_STORAGE_DIR = storageDir;
  await connectDb();
  await Promise.all([ESignatureModel.init(), SignatureApplicationModel.init()]);
  NET = await department('Network', 'NET');
  HRD = await department('Human Resource', 'HR');
  admin = await person('Ada', 'Admin', NET, { admin: true });
  hr = await person('Hana', 'Reyes', HRD, { talent: 'write' });
  requester = await person('Rico', 'Dela Cruz', NET);
  registerTalentFileAccess();
  registerTalentApprovalSigner();
  registerApprovalType(TYPE, {
    module: 'talent',
    label: 'Signature test',
    allowedDecisions: ['approve', 'return', 'reject'],
    onSettled: (context) => {
      hookStamps.push(context.decision.signature);
    },
  });
});

afterAll(async () => {
  await rm(storageDir, { recursive: true, force: true });
});

/** Submits a request that `approver` alone decides. */
async function submitFor(approver: Person, label: string): Promise<string> {
  const submitted = await withTransaction((session) =>
    submitApproval(
      {
        type: TYPE,
        record: { type: 'talent.testRecord', id: new Types.ObjectId(), label },
        title: `Request ${label}`,
        href: '/talent',
        requesterUserId: requester.userId,
        steps: [{ kind: 'anyOf', label: 'Approver', approvers: { userIds: [approver.userId] } }],
      },
      { session },
    ),
  );
  return submitted.id;
}

async function approve(approver: Person, requestId: string): Promise<void> {
  const stored = await database()
    .collection('approvalRequests')
    .findOne({ _id: new Types.ObjectId(requestId) });
  await decideApproval({ id: approver.userId, email: approver.actor.email }, requestId, {
    decision: 'approve',
    remarks: null,
    version: stored?.version as number,
  });
}

/** How many audit entries, signature applications and notifications are stored. */
async function countWrites() {
  return {
    audit: await database().collection('auditLogs').countDocuments(),
    applications: await SignatureApplicationModel.countDocuments(),
    notifications: await database().collection('notifications').countDocuments(),
  };
}

async function decisionOf(requestId: string) {
  const stored = await database()
    .collection('approvalRequests')
    .findOne({ _id: new Types.ObjectId(requestId) });
  return stored?.steps[0].decisions[0];
}

describe('uploading', () => {
  it('only the owner uploads, as versions 1, 2, 3', async () => {
    const owner = await person('Olive', 'Santos', NET);
    for (const expected of [1, 2, 3]) {
      const uploaded = await uploadESignature(owner.actor, pngFile());
      expect(uploaded.version).toBe(expected);
    }
    const versions = await listOwnESignatures(owner.actor);
    expect(versions.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(versions.map((v) => v.current)).toEqual([true, false, false]);
    // Someone else's upload is always their own: it never touches the owner's versions.
    await uploadESignature(hr.actor, pngFile());
    expect(
      await ESignatureModel.countDocuments({ employeeId: new Types.ObjectId(owner.employeeId) }),
    ).toBe(3);
  });

  it('refuses the system account, which has no employee', async () => {
    const system = await systemAccount();
    await expect(uploadESignature(system, pngFile())).rejects.toBeInstanceOf(AccessDeniedError);
    expect(await listOwnESignatures(system)).toEqual([]);
  });

  it('stores a PNG and writes one create entry per version', async () => {
    const owner = await person('Pablo', 'Reyes', NET);
    const { signatureId } = await uploadESignature(owner.actor, pngFile());
    const entries = (await auditEntries(E_SIGNATURE_TYPE)).filter(
      (e) => e.record.id.toHexString() === signatureId,
    );
    expect(entries.map((e) => e.action)).toEqual(['create']);
    expect(entries[0]?.record.label).toBe(`${owner.employeeNumber} · version 1`);
    const signature = await ESignatureModel.findById(signatureId).lean().orFail();
    const file = await database().collection('storedFiles').findOne({ _id: signature.fileId });
    expect(file?.contentType).toBe('image/png');
    expect(file?.ownerType).toBe(E_SIGNATURE_TYPE);
  });

  it('shows the status to everyone, and the image to the owner and the System Administrator only', async () => {
    const owner = await person('Quino', 'Lopez', NET);
    const notYet = await getEmployeeRecordView(hr.actor, owner.employeeId);
    expect(notYet?.eSignature).toEqual({ version: null });
    await uploadESignature(owner.actor, pngFile());
    await uploadESignature(owner.actor, pngFile());

    const hrView = await getEmployeeRecordView(hr.actor, owner.employeeId);
    expect(hrView?.eSignature).toEqual({ version: 2 });
    expect(Object.keys(hrView?.eSignature ?? {})).toEqual(['version']);
    const adminView = await getEmployeeRecordView(admin.actor, owner.employeeId);
    expect(adminView?.eSignature.imageUrl).toMatch(/^\/files\/[a-f\d]{24}\?inline=1$/);
    const own = await getOwnRecordView(owner.actor);
    expect(own?.eSignature.version).toBe(2);
    expect(own?.can.uploadESignature).toBe(true);
    expect(adminView?.can.uploadESignature).toBe(false);

    const versions = await listOwnESignatures(owner.actor);
    for (const version of versions) {
      const fileId = version.imageUrl.replace('/files/', '').replace('?inline=1', '');
      for (const [viewer, allowed] of [
        [owner, true],
        [admin, true],
        [hr, false],
        [requester, false],
      ] as const) {
        const opened = await openAccessibleFile(currentUser(viewer), fileId);
        if (allowed) {
          expect(opened).not.toBeNull();
          await opened?.stream.cancel();
        } else {
          expect(opened).toBeNull();
        }
      }
    }
  });
});

describe('signing approvals (the step’s "Done when")', () => {
  it('keeps version 1 on a record signed before the replacement, and signs the next with version 2', async () => {
    const approver = await person('Vida', 'Mercado', NET);
    const v1 = await uploadESignature(approver.actor, pngFile());
    const first = await submitFor(approver, 'A-1');
    await approve(approver, first);

    const v2 = await uploadESignature(approver.actor, pngFile());
    expect(v2.version).toBe(2);
    const second = await submitFor(approver, 'A-2');
    await approve(approver, second);

    const firstDecision = await decisionOf(first);
    const secondDecision = await decisionOf(second);
    expect(firstDecision?.signature.version).toBe(1);
    expect(firstDecision?.signature.signatureId.toHexString()).toBe(v1.signatureId);
    expect(secondDecision?.signature.version).toBe(2);
    expect(secondDecision?.signature.signatureId.toHexString()).toBe(v2.signatureId);

    const v1File = (await ESignatureModel.findById(v1.signatureId).lean().orFail()).fileId;
    const v2File = (await ESignatureModel.findById(v2.signatureId).lean().orFail()).fileId;
    const firstApplication = await SignatureApplicationModel.findById(
      firstDecision?.signature.applicationId,
    )
      .lean()
      .orFail();
    const secondApplication = await SignatureApplicationModel.findById(
      secondDecision?.signature.applicationId,
    )
      .lean()
      .orFail();
    expect(firstApplication.signatureVersion).toBe(1);
    expect(firstApplication.fileId.equals(v1File)).toBe(true);
    expect(firstApplication.target.type).toBe('core.approvalRequest');
    expect(firstApplication.target.id.toHexString()).toBe(first);
    expect(firstApplication.purpose).toBe('approval');
    expect(firstApplication.userId.toHexString()).toBe(approver.userId);
    expect(secondApplication.signatureVersion).toBe(2);
    expect(secondApplication.fileId.equals(v2File)).toBe(true);

    // The hooks got the stamps.
    expect(hookStamps.slice(-2).map((stamp) => stamp?.version)).toEqual([1, 2]);

    // The history counts each version's uses.
    const versions = await listOwnESignatures(approver.actor);
    expect(versions.map((v) => [v.version, v.applicationCount])).toEqual([
      [2, 1],
      [1, 1],
    ]);

    // Each use is a create entry on talent.signatureApplication, labelled with what was signed.
    const entry = (await auditEntries(SIGNATURE_APPLICATION_TYPE)).find(
      (e) => e.record.id.toHexString() === firstApplication._id.toHexString(),
    );
    expect(entry?.action).toBe('create');
    expect(entry?.record.label.startsWith(`${approver.employeeNumber} · Approval: `)).toBe(true);
  });

  it('signs a request whose record label is as long as allowed (the audit label is shortened)', async () => {
    const approver = await person('Lara', 'Longname', NET);
    await uploadESignature(approver.actor, pngFile());
    const requestId = await submitFor(approver, 'L'.repeat(190));
    await approve(approver, requestId);
    const signature = (await decisionOf(requestId))?.signature;
    expect(signature?.version).toBe(1);
    const entry = (await auditEntries(SIGNATURE_APPLICATION_TYPE)).find(
      (e) => e.record.id.toHexString() === signature?.applicationId.toHexString(),
    );
    expect(entry?.record.label.length).toBeLessThanOrEqual(200);
    expect(entry?.record.label.startsWith(`${approver.employeeNumber} · Approval: `)).toBe(true);
  });

  it('refuses an approve with no signature on file (the step 2.6 gate), writing nothing', async () => {
    const approver = await person('Wilma', 'Ortiz', NET);
    const requestId = await submitFor(approver, 'B-1');
    const before = await countWrites();
    const hooksBefore = hookStamps.length;
    const refusal = approve(approver, requestId);
    await expect(refusal).rejects.toBeInstanceOf(OnboardingGateError);
    await expect(refusal).rejects.toThrow(
      'Complete this onboarding item first: E-signature. Upload it in My record, then try again.',
    );
    // The decision rolled back: still pending, no decision, entry, application or notification.
    const stored = await database()
      .collection('approvalRequests')
      .findOne({ _id: new Types.ObjectId(requestId) });
    expect(stored?.status).toBe('pending');
    expect(stored?.steps[0].decisions).toEqual([]);
    expect(await countWrites()).toEqual(before);
    expect(hookStamps.length).toBe(hooksBefore);

    // Return and reject sign nothing and aren't gated.
    await decideApproval({ id: approver.userId, email: approver.actor.email }, requestId, {
      decision: 'return',
      remarks: 'Please attach the quote.',
      version: stored?.version as number,
    });
    const returned = await database()
      .collection('approvalRequests')
      .findOne({ _id: new Types.ObjectId(requestId) });
    expect(returned?.status).toBe('returned');
    const other = await submitFor(approver, 'B-2');
    const otherStored = await database()
      .collection('approvalRequests')
      .findOne({ _id: new Types.ObjectId(other) });
    await decideApproval({ id: approver.userId, email: approver.actor.email }, other, {
      decision: 'reject',
      remarks: 'Not needed.',
      version: otherStored?.version as number,
    });

    // After uploading a signature, the same kind of approve succeeds, signed with version 1.
    await uploadESignature(approver.actor, pngFile());
    const third = await submitFor(approver, 'B-3');
    await approve(approver, third);
    expect((await decisionOf(third))?.signature.version).toBe(1);
  });

  it('lets the bootstrap system account approve a request routed to the System Administrators, unsigned', async () => {
    const system = await systemAccount();
    const submitted = await withTransaction((session) =>
      submitApproval(
        {
          type: TYPE,
          record: { type: 'talent.testRecord', id: new Types.ObjectId(), label: 'S-1' },
          title: 'Request S-1',
          href: '/talent',
          requesterUserId: requester.userId,
          steps: [
            {
              kind: 'anyOf',
              label: 'Approver',
              approvers: { userIds: [] },
              whenEmpty: 'systemAdministrator',
            },
          ],
        },
        { session },
      ),
    );
    expect(submitted.routedToSystemAdministrator).toBe(true);
    const stored = await database()
      .collection('approvalRequests')
      .findOne({ _id: new Types.ObjectId(submitted.id) });
    await decideApproval(
      { id: system.id, email: system.email, isSystemAdministrator: true },
      submitted.id,
      { decision: 'approve', remarks: null, version: stored?.version as number },
    );
    const decision = await decisionOf(submitted.id);
    expect(decision?.decision).toBe('approve');
    expect(decision?.signature).toBeNull();
  });

  it('signs as the actor only and returns null for the system account', async () => {
    const system = await systemAccount();
    const stamp = await withTransaction((session) =>
      applyESignature({
        actor: { id: system.id },
        target: {
          type: 'core.approvalRequest',
          id: new Types.ObjectId().toHexString(),
          label: 'X',
        },
        purpose: 'approval',
        session,
      }),
    );
    expect(stamp).toBeNull();
  });
});

describe('insert-only', () => {
  it('refuses every update and delete of signatures and applications', async () => {
    const approver = await person('Xena', 'Pascual', NET);
    const { signatureId } = await uploadESignature(approver.actor, pngFile());
    const requestId = await submitFor(approver, 'C-1');
    await approve(approver, requestId);
    const applicationId = (await decisionOf(requestId))?.signature.applicationId;

    for (const [model, id] of [
      [ESignatureModel, new Types.ObjectId(signatureId)],
      [SignatureApplicationModel, applicationId],
    ] as const) {
      const anyModel = model as unknown as typeof ESignatureModel;
      await expect(anyModel.updateOne({ _id: id }, { $set: { version: 9 } })).rejects.toThrow(
        /never changed or deleted/,
      );
      await expect(anyModel.deleteOne({ _id: id })).rejects.toThrow(/never changed or deleted/);
      await expect(anyModel.deleteMany({})).rejects.toThrow(/never changed or deleted/);
      await expect(anyModel.replaceOne({ _id: id }, {})).rejects.toThrow(
        /never changed or deleted/,
      );
      await expect(anyModel.findOneAndUpdate({ _id: id }, { $set: {} })).rejects.toThrow(
        /never changed or deleted/,
      );
      const loaded = await anyModel.findById(id).orFail();
      await expect(loaded.deleteOne()).rejects.toThrow(/never changed or deleted/);
    }
    expect(await ESignatureModel.countDocuments({ _id: new Types.ObjectId(signatureId) })).toBe(1);
    expect(await SignatureApplicationModel.countDocuments({ _id: applicationId })).toBe(1);
  });
});
