import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { AccessDeniedError, ActionError } from '@pulse/core';
import { HIDDEN_SENSITIVE_CHANGED, revealSensitiveField } from '@pulse/core/server';
import { uploadESignature, registerTalentApprovalSigner } from '../e-signatures/service';
import { EmployeeRecordModel } from '../employee-records/model';
import {
  saveOwnBankAccount,
  saveOwnGovernmentIds,
  saveOwnPersonal,
  saveOwnSkills,
} from '../employee-records/own';
import { getEmployeeRecordView, updatePersonal } from '../employee-records/service';
import { registerTalentSensitiveReveals } from '../sensitive/reveals';
import {
  auditEntries,
  database,
  decide,
  type Department,
  department,
  moveTo,
  notifications,
  type Person,
  person,
  pngFile,
  rawAuditJson,
  separate,
  setReportingTo,
  systemAccount,
} from '../testing/fixtures';
import { ChangeRequestModel } from './model';
import {
  cancelChangeRequest,
  CHANGE_REQUEST_TYPE,
  getChangeRequestView,
  getOwnChangeRequestStates,
  listOwnChangeRequests,
  registerTalentApprovalTypes,
  resendChangeRequest,
} from './service';

// Change requests (docs/TESTING.md#onboarding-and-change-request-tests: own entries, routing,
// applying, returning, rejecting and cancelling, and who sees a change request and its reveals;
// decisions 267 and 269–274 in docs/BUILD_PLAN.md). "Today" is Monday 2026-09-14, 10:00 Manila.
// Made-up people and IDs only.

const IDS = {
  tin: '900123456781',
  sss: '0498765432',
  philhealth: '120987654329',
  pagibig: '121234567893',
};
const NEW_TIN = '900765432109';
const ACCOUNT_NUMBER = '0009876543217';
const NEW_ACCOUNT_NUMBER = '0001112223334';

let storageDir: string;
let NET: Department;
let HRD: Department;
let BOD: Department;
let admin: Person;
let hr: Person;
let hr2: Person;
let board: Person;
let reader: Person;
let supervisor: Person;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-14T10:00:00+08:00'));
  storageDir = await mkdtemp(path.join(tmpdir(), 'pulse-test-storage-'));
  process.env.FILE_STORAGE_DIR = storageDir;
  await connectDb();
  await Promise.all([EmployeeRecordModel.init(), ChangeRequestModel.init()]);
  NET = await department('Network', 'NET');
  HRD = await department('Human Resource', 'HR');
  BOD = await department('Board of Directors', 'BOD');
  admin = await person('Ada', 'Admin', NET, { admin: true, talent: 'write' });
  hr = await person('Hana', 'Reyes', HRD);
  hr2 = await person('Hugo', 'Ramos', HRD, { talent: 'read' });
  board = await person('Bert', 'Lim', BOD);
  reader = await person('Rita', 'Uy', NET, { talent: 'read' });
  supervisor = await person('Sam', 'Super', NET);
  for (const approver of [admin, hr, hr2, board, supervisor]) {
    await uploadESignature(approver.actor, pngFile());
  }
  registerTalentApprovalSigner();
  registerTalentApprovalTypes();
  registerTalentSensitiveReveals();
});

afterAll(async () => {
  vi.useRealTimers();
  await rm(storageDir, { recursive: true, force: true });
});

const PERSONAL = {
  dateOfBirth: '1990-05-17',
  sex: 'female',
  civilStatus: 'single',
  nationality: 'Filipino',
  presentAddress: '1 Sample Street, Pasig',
  permanentAddress: '1 Sample Street, Pasig',
  mobileNumber: '09171234567',
  personalEmail: null,
  emergencyContactName: 'Ed Garcia',
  emergencyContactRelationship: 'Brother',
  emergencyContactMobile: '09181234567',
} as const;

async function versionOf(who: Person): Promise<number> {
  const record = await EmployeeRecordModel.findOne({
    employeeId: new Types.ObjectId(who.employeeId),
  }).lean();
  return record?.version ?? 0;
}

async function storedRecord(who: Person) {
  return database()
    .collection('employeeRecords')
    .findOne({ employeeId: new Types.ObjectId(who.employeeId) });
}

async function approvalOf(changeRequestId: string) {
  const request = await ChangeRequestModel.findById(changeRequestId).lean();
  return database()
    .collection('approvalRequests')
    .findOne({ _id: request?.approvalRequestId ?? new Types.ObjectId() });
}

async function approverIdsOf(changeRequestId: string): Promise<string[]> {
  const approval = await approvalOf(changeRequestId);
  return (approval?.pendingApproverIds ?? []).map((id: Types.ObjectId) => id.toHexString()).sort();
}

/** An employee in `dept` with their Personal section filled in by the employee. */
async function withPersonal(
  name: string,
  dept: Department = NET,
  reportingTo: Person[] = [supervisor],
) {
  const emp = await person(name, 'Garcia', dept);
  await setReportingTo(emp, reportingTo);
  await saveOwnPersonal(emp.actor, { version: 0, ...PERSONAL });
  return emp;
}

describe('own entries', () => {
  it('fills empty fields straight away, creating the record, with entries by the employee', async () => {
    const emp = await person('Fe', 'First', NET);
    const result = await saveOwnPersonal(emp.actor, { version: 0, ...PERSONAL });
    expect(result.sent).toEqual([]);
    expect(result.savedVersion).toBe(1);
    expect(result.saved).toEqual(
      expect.arrayContaining(['mobileNumber', 'emergencyContact', 'dateOfBirth', 'civilStatus']),
    );
    const entry = (await auditEntries('talent.employeeRecord')).at(-1);
    expect(entry?.action).toBe('create');
    expect(entry?.actorId.toHexString()).toBe(emp.userId);
    // A later blank (the personal email) is still saved straight away.
    const again = await saveOwnPersonal(emp.actor, {
      version: 1,
      ...PERSONAL,
      personalEmail: 'fe@example.com',
    });
    expect(again).toEqual({ savedVersion: 2, saved: ['personalEmail'], sent: [] });
    expect((await auditEntries('talent.employeeRecord')).at(-1)?.action).toBe('update');
  });

  it('a changed mobile number makes a Contact details request and leaves the record unchanged', async () => {
    const emp = await withPersonal('Mona');
    const before = await storedRecord(emp);
    const result = await saveOwnPersonal(emp.actor, {
      version: 1,
      ...PERSONAL,
      mobileNumber: '09179999999',
      note: 'New SIM',
    });
    expect(result.savedVersion).toBeNull();
    expect(result.sent).toHaveLength(1);
    expect(result.sent[0]?.section).toBe('contact');
    expect(await storedRecord(emp)).toEqual(before);
    const request = await ChangeRequestModel.findById(result.sent[0]?.id).lean();
    expect(request?.changedFields).toEqual(['mobileNumber']);
    expect(request?.proposed).toEqual({ mobileNumber: '09179999999' });
    expect(request?.note).toBe('New SIM');
    expect(request?.status).toBe('pending');
    const states = await getOwnChangeRequestStates(emp.actor);
    expect(states?.contact.openRequest).toEqual({ id: result.sent[0]?.id, status: 'pending' });
    expect(states?.personal.openRequest).toBeNull();
    expect(states?.personal.approvers).toBe('hr');
    expect(states?.contact.approvers).toBe('supervisorsAndHr');
  });

  it('one save touching contact and personal details makes two requests; no change is refused', async () => {
    const emp = await withPersonal('Tess');
    const result = await saveOwnPersonal(emp.actor, {
      version: 1,
      ...PERSONAL,
      presentAddress: '2 Other Street, Taguig',
      civilStatus: 'married',
    });
    expect(result.sent.map((entry) => entry.section).sort()).toEqual(['contact', 'personal']);
    await expect(saveOwnSkills(emp.actor, { version: 1, skills: [] })).rejects.toThrow(
      'Nothing changed',
    );
    // An open request blocks another save of that section; another section is allowed.
    await expect(
      saveOwnPersonal(emp.actor, { version: 1, ...PERSONAL, mobileNumber: '09170000000' }),
    ).rejects.toThrow('already waiting for approval');
    expect((await saveOwnSkills(emp.actor, { version: 1, skills: ['Fortinet'] })).saved).toEqual([
      'skills',
    ]);
  });

  it('refuses the system account, which has no employee', async () => {
    await expect(
      saveOwnSkills(await systemAccount(), { version: 0, skills: ['x'] }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });
});

describe('routing', () => {
  it('Contact details: the active supervisors and HR, not a separated supervisor or the requester', async () => {
    const gone = await person('Gina', 'Gone', NET);
    const emp = await withPersonal('Cora', NET, [supervisor, gone]);
    await separate(gone);
    const { sent } = await saveOwnPersonal(emp.actor, {
      version: 1,
      ...PERSONAL,
      mobileNumber: '09175555555',
    });
    expect(await approverIdsOf(firstId(sent))).toEqual(
      [supervisor.userId, hr.userId, hr2.userId].sort(),
    );
    const approval = await approvalOf(firstId(sent));
    expect(approval?.title).toBe('Change request: Contact details · Cora Garcia');
    expect(approval?.summary).toBe('Fields: mobile number');
    expect(approval?.href).toBe(`/talent/change-requests/${firstId(sent)}`);
  });

  it('Personal details go to HR only; IDs and bank to HR, or the Board for an HR employee', async () => {
    const emp = await withPersonal('Pia');
    const personal = await saveOwnPersonal(emp.actor, {
      version: 1,
      ...PERSONAL,
      nationality: 'Japanese',
    });
    expect(await approverIdsOf(firstId(personal.sent))).toEqual([hr.userId, hr2.userId].sort());
    await saveOwnGovernmentIds(emp.actor, {
      version: await versionOf(emp),
      ...IDS,
      rdoCode: '043',
    });
    const ids = await saveOwnGovernmentIds(emp.actor, {
      version: await versionOf(emp),
      tin: NEW_TIN,
      rdoCode: '043',
    });
    expect(await approverIdsOf(firstId(ids.sent))).toEqual([hr.userId, hr2.userId].sort());

    const hrEmployee = await withPersonal('Hera', HRD);
    await saveOwnBankAccount(hrEmployee.actor, {
      version: 1,
      bank: 'unionbank',
      accountNumber: ACCOUNT_NUMBER,
      accountName: 'Hera Garcia',
    });
    const bank = await saveOwnBankAccount(hrEmployee.actor, {
      version: 2,
      bank: 'rcbc',
      accountName: 'Hera Garcia',
    });
    expect(await approverIdsOf(firstId(bank.sent))).toEqual([board.userId]);
    // An HR employee's contact change: their supervisors and the other HR users.
    const contact = await saveOwnPersonal(hrEmployee.actor, {
      version: 2,
      ...PERSONAL,
      mobileNumber: '09176666666',
    });
    expect(await approverIdsOf(firstId(contact.sent))).toEqual(
      [supervisor.userId, hr.userId, hr2.userId].sort(),
    );
  });

  it('a step with no one left goes to the System Administrators', async () => {
    // An HR employee's bank change goes to the Board; with its only member away, to the admins.
    const lone = await withPersonal('Lone', HRD);
    await saveOwnBankAccount(lone.actor, {
      version: 1,
      bank: 'unionbank',
      accountNumber: ACCOUNT_NUMBER,
      accountName: 'Lone Garcia',
    });
    await separate(board);
    try {
      const result = await saveOwnBankAccount(lone.actor, {
        version: 2,
        bank: 'rcbc',
        accountName: 'Lone Garcia',
      });
      const approval = await approvalOf(firstId(result.sent));
      expect(approval?.steps[0].routedToSystemAdministrator).toBe(true);
      expect(approval?.pendingApproverIds.map((id: Types.ObjectId) => id.toHexString())).toContain(
        admin.userId,
      );
    } finally {
      await database()
        .collection('employees')
        .updateOne(
          { _id: new Types.ObjectId(board.employeeId) },
          { $set: { employmentStatus: 'Regular', separationDate: null } },
        );
    }
  });
});

describe('applying, returning, rejecting and cancelling', () => {
  it('approving writes only the changed fields, keeps the previous values and writes both entries', async () => {
    const emp = await withPersonal('Abby');
    const { sent } = await saveOwnPersonal(emp.actor, {
      version: 1,
      ...PERSONAL,
      mobileNumber: '09173333333',
    });
    const approval = await approvalOf(firstId(sent));
    await decide(supervisor.actor, must(approval)._id.toHexString(), 'approve');
    const record = await storedRecord(emp);
    expect(record?.mobileNumber).toBe('09173333333');
    expect(record?.presentAddress).toBe(PERSONAL.presentAddress);
    expect(record?.version).toBe(2);
    const request = await ChangeRequestModel.findById(firstId(sent)).lean();
    expect(request?.status).toBe('approved');
    expect(request?.previous).toEqual({ mobileNumber: PERSONAL.mobileNumber });
    expect(request?.decidedBy?.toHexString()).toBe(supervisor.userId);
    const recordEntry = (await auditEntries('talent.employeeRecord')).at(-1);
    expect(recordEntry?.reason).toBe('Change request approved');
    expect(recordEntry?.actorId.toHexString()).toBe(supervisor.userId);
    expect((await auditEntries(CHANGE_REQUEST_TYPE)).at(-1)?.action).toBe('update');
  });

  it('an approved ID change is stored encrypted, verified to the approver, and audited hidden', async () => {
    const emp = await withPersonal('Ivan');
    await saveOwnGovernmentIds(emp.actor, { version: 1, ...IDS, rdoCode: '043' });
    const { sent } = await saveOwnGovernmentIds(emp.actor, {
      version: 2,
      tin: NEW_TIN,
      rdoCode: '043',
    });
    const raw = await database()
      .collection('changeRequests')
      .findOne({ _id: new Types.ObjectId(firstId(sent)) });
    expect(raw?.proposed.tin.sub_type).toBe(6);
    expect(JSON.stringify(raw)).not.toContain(NEW_TIN);
    await decide(hr.actor, must(await approvalOf(firstId(sent)))._id.toHexString(), 'approve');
    const view = await getEmployeeRecordView(admin.actor, emp.employeeId);
    expect(view?.governmentIds?.tin?.lastFour).toBe(NEW_TIN.slice(-4));
    expect(view?.governmentIds?.verification?.verifiedByName).toBe('Hana Reyes');
    const request = await database()
      .collection('changeRequests')
      .findOne({ _id: new Types.ObjectId(firstId(sent)) });
    expect(request?.previous.tin.sub_type).toBe(6);
    const entry = (await auditEntries('talent.employeeRecord')).at(-1);
    expect(entry?.after.governmentIds.tin).toEqual(HIDDEN_SENSITIVE_CHANGED);
    const audit = await rawAuditJson();
    for (const value of [NEW_TIN, IDS.tin]) expect(audit).not.toContain(value);
    // The approval's title, summary and the notifications name no value.
    const approval = await approvalOf(firstId(sent));
    expect(`${approval?.title} ${approval?.summary}`).not.toMatch(/\d{4}/);
    const texts = (await notifications()).map((n) => `${n.title} ${n.body ?? ''}`).join(' | ');
    expect(texts).not.toContain(NEW_TIN.slice(-4));
    expect(texts).not.toContain(IDS.tin.slice(-4));
  });

  it('refuses HR’s approve of a bank change once the employee moved into HR, changing nothing', async () => {
    const emp = await withPersonal('Mia');
    await saveOwnBankAccount(emp.actor, {
      version: 1,
      bank: 'unionbank',
      accountNumber: ACCOUNT_NUMBER,
      accountName: 'Mia Garcia',
    });
    const { sent } = await saveOwnBankAccount(emp.actor, {
      version: 2,
      bank: 'unionbank',
      accountNumber: NEW_ACCOUNT_NUMBER,
      accountName: 'Mia Garcia',
    });
    await moveTo(emp, HRD);
    const before = await storedRecord(emp);
    const approvalId = must(await approvalOf(firstId(sent)))._id.toHexString();
    await expect(decide(hr.actor, approvalId, 'approve')).rejects.toThrow(
      /^This change can no longer be approved by you: .*\. Return it instead\.$/,
    );
    expect(await storedRecord(emp)).toEqual(before);
    expect((await ChangeRequestModel.findById(firstId(sent)).lean())?.status).toBe('pending');
    expect((await approvalOf(firstId(sent)))?.status).toBe('pending');
  });

  it('a return keeps the record; the employee sends it again or cancels it; a rejection is final', async () => {
    const emp = await withPersonal('Rosa');
    const { sent } = await saveOwnPersonal(emp.actor, {
      version: 1,
      ...PERSONAL,
      mobileNumber: '09174444444',
    });
    const firstApproval = must(await approvalOf(firstId(sent)))._id;
    await decide(hr.actor, firstApproval.toHexString(), 'return', 'Use your work SIM');
    expect((await storedRecord(emp))?.mobileNumber).toBe(PERSONAL.mobileNumber);
    let list = await listOwnChangeRequests(emp.actor);
    expect(list[0]).toMatchObject({
      status: 'returned',
      remarks: 'Use your work SIM',
      canResend: true,
      canCancel: true,
    });

    const resent = await resendChangeRequest(emp.actor, {
      changeRequestId: firstId(sent),
      values: { ...PERSONAL, mobileNumber: '09174444445' },
    });
    expect(resent.status).toBe('pending');
    const second = await approvalOf(firstId(sent));
    expect(second?._id.equals(firstApproval)).toBe(false);
    expect(second?.previousRequestId.equals(firstApproval)).toBe(true);
    expect((await ChangeRequestModel.findById(firstId(sent)).lean())?.proposed).toEqual({
      mobileNumber: '09174444445',
    });
    // A pending request can't be cancelled.
    await expect(
      cancelChangeRequest(emp.actor, { changeRequestId: firstId(sent) }),
    ).rejects.toBeInstanceOf(ActionError);
    await decide(hr.actor, must(second)._id.toHexString(), 'return', 'Still not it');
    await cancelChangeRequest(emp.actor, { changeRequestId: firstId(sent) });
    list = await listOwnChangeRequests(emp.actor);
    expect(list[0]).toMatchObject({ status: 'cancelled', canResend: false, canCancel: false });

    // Another's request reads as missing.
    const other = await withPersonal('Otto');
    await expect(
      cancelChangeRequest(other.actor, { changeRequestId: firstId(sent) }),
    ).rejects.toThrow('can’t be found');

    // A rejection is final.
    const next = await saveOwnPersonal(emp.actor, {
      version: 1,
      ...PERSONAL,
      mobileNumber: '09174444446',
    });
    await decide(
      hr.actor,
      must(await approvalOf(firstId(next.sent)))._id.toHexString(),
      'reject',
      'No',
    );
    expect((await ChangeRequestModel.findById(firstId(next.sent)).lean())?.status).toBe('rejected');
    await expect(
      resendChangeRequest(emp.actor, {
        changeRequestId: firstId(next.sent),
        values: { ...PERSONAL },
      }),
    ).rejects.toThrow('Only a returned change request');
    expect((await storedRecord(emp))?.mobileNumber).toBe(PERSONAL.mobileNumber);
  });
});

describe('who sees a change request', () => {
  it('the requester, its approvers, the System Administrator and Talent Read who may see the section', async () => {
    const emp = await withPersonal('Vida');
    const { sent } = await saveOwnPersonal(emp.actor, {
      version: 1,
      ...PERSONAL,
      mobileNumber: '09172222222',
    });
    const id = firstId(sent);
    const view = await getChangeRequestView(emp.actor, id);
    expect(view?.fields).toEqual([
      expect.objectContaining({
        field: 'mobileNumber',
        current: PERSONAL.mobileNumber,
        proposed: '09172222222',
        sensitive: false,
      }),
    ]);
    expect(view?.approvalHref).toMatch(/^\/approvals\?request=/);
    // The supervisor has no module access but is an approver.
    expect((await getChangeRequestView(supervisor.actor, id))?.id).toBe(id);
    expect((await getChangeRequestView(admin.actor, id))?.id).toBe(id);
    expect((await getChangeRequestView(reader.actor, id))?.id).toBe(id);
    const stranger = await person('Stan', 'Ger', NET);
    await expect(getChangeRequestView(stranger.actor, id)).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    // Personal details: a Talent Read user who can't see the date of birth gets 403.
    const personal = await saveOwnPersonal(emp.actor, {
      version: 1,
      ...PERSONAL,
      dateOfBirth: '1991-05-17',
    });
    await expect(getChangeRequestView(reader.actor, firstId(personal.sent))).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    expect(await getChangeRequestView(reader.actor, new Types.ObjectId().toHexString())).toBeNull();
  });

  it('masks the numbers and audits a reveal of a proposed TIN; a supervisor can’t reveal one', async () => {
    const emp = await withPersonal('Gil');
    await saveOwnGovernmentIds(emp.actor, { version: 1, ...IDS, rdoCode: '043' });
    const { sent } = await saveOwnGovernmentIds(emp.actor, {
      version: 2,
      tin: NEW_TIN,
      rdoCode: '043',
    });
    const id = firstId(sent);
    const view = await getChangeRequestView(hr.actor, id);
    const tin = view?.fields.find((field) => field.field === 'tin');
    expect(tin?.current).toBeNull();
    expect(tin?.proposedMasked?.lastFour).toBe(NEW_TIN.slice(-4));
    expect(tin?.currentMasked?.lastFour).toBe(IDS.tin.slice(-4));
    expect(view?.canReveal).toBe(true);
    expect(JSON.stringify(view)).not.toContain(NEW_TIN);
    // The Talent Read user who may not reveal IDs, and the supervisor, get no view of it.
    await expect(getChangeRequestView(reader.actor, id)).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(getChangeRequestView(supervisor.actor, id)).rejects.toBeInstanceOf(
      AccessDeniedError,
    );

    const revealed = await revealSensitiveField({
      actor: hr.actor,
      ownerType: CHANGE_REQUEST_TYPE,
      ownerId: id,
      field: 'proposed.tin',
    });
    expect(revealed).toBe(NEW_TIN);
    const entry = (await auditEntries(CHANGE_REQUEST_TYPE)).at(-1);
    expect(entry?.action).toBe('reveal');
    expect(entry?.fields).toEqual(['proposed.tin']);
    await expect(
      revealSensitiveField({
        actor: supervisor.actor,
        ownerType: CHANGE_REQUEST_TYPE,
        ownerId: id,
        field: 'proposed.tin',
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it('the validator refuses a plain proposed value', async () => {
    const emp = await person('Val', 'Idator', NET);
    await expect(
      database()
        .collection('changeRequests')
        .insertOne({
          employeeId: new Types.ObjectId(emp.employeeId),
          requesterUserId: new Types.ObjectId(emp.userId),
          section: 'governmentIds',
          changedFields: ['tin'],
          proposed: { tin: NEW_TIN },
          status: 'cancelled',
          sentAt: new Date(),
          version: 1,
        }),
    ).rejects.toThrow();
  });
});

// The inspector edit of another's record still works beside the own entries (decision 267).
describe('own entries leave the inspector alone', () => {
  it('HR still edits the Personal section directly', async () => {
    const emp = await withPersonal('Ines');
    await setReportingTo(emp, []);
    const hrWriter = await person('Hal', 'Writer', HRD, { talent: 'write' });
    const { version } = await updatePersonal(hrWriter.actor, {
      employeeId: emp.employeeId,
      version: 1,
      ...PERSONAL,
      mobileNumber: '09178888888',
    });
    expect(version).toBe(2);
  });
});

/** The value, failing the test when it is missing. */
function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Expected a value.');
  return value;
}

/** The id of the first change request a save sent. */
function firstId(sent: readonly { id: string }[]): string {
  return must(sent[0]).id;
}
