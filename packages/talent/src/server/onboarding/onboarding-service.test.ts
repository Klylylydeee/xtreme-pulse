import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { connectDb, withTransaction } from '@pulse/db';
import { AccessDeniedError, ActionError } from '@pulse/core';
import { registerApprovalType, submitApproval } from '@pulse/core/server';
import { OnboardingGateError } from '../../onboarding/gates';
import { addCompensationEntry } from '../compensation/service';
import { CertificationModel } from '../certifications/model';
import {
  addOwnCertification,
  removeCertification,
  updateCertification,
} from '../certifications/service';
import { EmployeeDocumentModel } from '../documents/model';
import {
  addEmployeeDocument,
  addOwnEmployeeDocument,
  archiveEmployeeDocument,
  DOCUMENT_UPLOADED_EVENT,
  updateEmployeeDocument,
} from '../documents/service';
import { registerTalentApprovalSigner, uploadESignature } from '../e-signatures/service';
import { EmployeeRecordModel } from '../employee-records/model';
import {
  saveOwnBankAccount,
  saveOwnGovernmentIds,
  VERIFICATION_NEEDED_EVENT,
} from '../employee-records/own';
import {
  getEmployeeRecordView,
  getOwnRecordView,
  listEmployeeRecords,
  markVerified,
  setBankAccount,
  setGovernmentIds,
  setNoSupervisorConfirmation,
  updatePersonal,
} from '../employee-records/service';
import { talentSeedLoaders } from '../seed';
import { getOwnTimesheetView, timeIn, timeOut } from '../timesheets/service';
import {
  auditEntries,
  database,
  decide,
  type Department,
  department,
  notifications,
  pdfFile,
  type Person,
  person,
  pngFile,
  setPhoto,
  setReportingTo,
  separate,
  setTalentAccess,
  setTemporaryPassword,
  systemAccount,
} from '../testing/fixtures';
import { getEmployeeOnboarding, getOwnOnboarding, getOwnOnboardingReminder } from './service';

// The onboarding checklist on the server (docs/TESTING.md#onboarding-and-change-request-tests:
// items and progress, the e-signature gate and the Done when, verification, "No supervisor",
// uploads and certifications, and who sees what; decisions 256–268 and 274 in docs/BUILD_PLAN.md).
// "Today" is Monday 2026-09-14, 10:00 Manila. Made-up people and IDs only.

const IDS = {
  tin: '900123456781',
  sss: '0498765432',
  philhealth: '120987654329',
  pagibig: '121234567893',
};
const ACCOUNT_NUMBER = '0009876543217';
const SAMPLE_TYPE = 'talent.onboardingSample';

let storageDir: string;
let NET: Department;
let HRD: Department;
let ACCT: Department;
let BOD: Department;
let admin: Person;
let hr: Person;
let hrReader: Person;
let accounting: Person;
let board: Person;
let writer: Person;
let reader: Person;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-14T10:00:00+08:00'));
  storageDir = await mkdtemp(path.join(tmpdir(), 'pulse-test-storage-'));
  process.env.FILE_STORAGE_DIR = storageDir;
  await connectDb();
  await Promise.all([
    EmployeeRecordModel.init(),
    EmployeeDocumentModel.init(),
    CertificationModel.init(),
  ]);
  for (const loader of talentSeedLoaders) await loader.run();
  NET = await department('Network', 'NET');
  HRD = await department('Human Resource', 'HR');
  ACCT = await department('Accounting', 'ACCT');
  BOD = await department('Board of Directors', 'BOD');
  admin = await person('Ada', 'Admin', NET, { admin: true, talent: 'write' });
  hr = await person('Hana', 'Reyes', HRD, { talent: 'write' });
  hrReader = await person('Hugo', 'Ramos', HRD, { talent: 'read' });
  accounting = await person('Abel', 'Santos', ACCT, { talent: 'write' });
  board = await person('Bert', 'Lim', BOD, { talent: 'write' });
  writer = await person('Wena', 'Cruz', NET, { talent: 'write' });
  reader = await person('Rita', 'Uy', NET, { talent: 'read' });
  registerTalentApprovalSigner();
  registerApprovalType(SAMPLE_TYPE, {
    module: 'talent',
    label: 'Sample',
    allowedDecisions: ['approve', 'return', 'reject'],
    onSettled: () => {},
  });
});

afterAll(async () => {
  vi.useRealTimers();
  await rm(storageDir, { recursive: true, force: true });
});

function states(view: {
  employeeItems: { key: string; state: string }[];
  hrItems: { key: string; state: string }[];
}) {
  return Object.fromEntries(
    [...view.employeeItems, ...view.hrItems].map((item) => [item.key, item.state]),
  );
}

async function fillPersonal(who: Person, by: Person = admin, version = 0) {
  return updatePersonal(by.actor, {
    employeeId: who.employeeId,
    version,
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
  });
}

async function recordVersion(who: Person): Promise<number> {
  const record = await EmployeeRecordModel.findOne({
    employeeId: new Types.ObjectId(who.employeeId),
  }).lean();
  return record?.version ?? 0;
}

describe('items and progress', () => {
  it('a new employee with nothing filled in is 1 of 8 (the password), and the reminder shows', async () => {
    const fresh = await person('Nina', 'Bago', NET);
    const own = await getOwnOnboarding(fresh.actor);
    expect(own?.employeeProgress).toEqual({ done: 1, total: 8 });
    expect(own?.showReminder).toBe(true);
    expect(own?.complete).toBe(false);
    expect(states(must(own))).toMatchObject({
      password: 'done',
      personalInfo: 'todo',
      governmentIds: 'todo',
      documents: 'todo',
      eSignature: 'todo',
      moduleAccess: 'todo',
      department: 'done',
      reportingTo: 'todo',
      workSchedule: 'done',
      workRegion: 'done',
      compensation: 'todo',
      assets: 'placeholder',
    });
    expect(own?.uploadTypes).not.toContain('employmentContract');
    expect(await getOwnOnboardingReminder(fresh.actor)).toEqual({
      done: 1,
      total: 8,
      showReminder: true,
    });
    await setTemporaryPassword(fresh, true);
    expect(states(must(await getOwnOnboarding(fresh.actor))).password).toBe('todo');
  });

  it('the system account has no checklist', async () => {
    const system = await systemAccount();
    expect(await getOwnOnboarding(system)).toBeNull();
    expect(await getOwnOnboardingReminder(system)).toBeNull();
  });

  it('derives each item from the records, waiting for HR until the IDs and bank are verified', async () => {
    const emp = await person('Olga', 'Ramos', NET, { talent: 'read' });
    await fillPersonal(emp);
    // The employee fills in the IDs (no RDO code yet): not done.
    await saveOwnGovernmentIds(emp.actor, {
      version: await recordVersion(emp),
      ...IDS,
      rdoCode: null,
    });
    expect(states(must(await getOwnOnboarding(emp.actor))).governmentIds).toBe('todo');
    await saveOwnGovernmentIds(emp.actor, { version: await recordVersion(emp), rdoCode: '043' });
    await saveOwnBankAccount(emp.actor, {
      version: await recordVersion(emp),
      bank: 'unionbank',
      accountNumber: ACCOUNT_NUMBER,
      accountName: 'Olga Ramos',
    });
    await setPhoto(emp);
    await uploadESignature(emp.actor, pngFile());
    for (const type of ['governmentIdCopy', 'nbiClearance'] as const) {
      await addOwnEmployeeDocument(
        emp.actor,
        { type, title: null, issueDate: '2026-01-05', expiryDate: '2027-01-05' },
        pdfFile(),
      );
    }
    let own = await getOwnOnboarding(emp.actor);
    expect(states(must(own))).toMatchObject({
      personalInfo: 'done',
      emergencyContact: 'done',
      governmentIds: 'waitingForVerification',
      bankAccount: 'waitingForVerification',
      documents: 'done',
      photo: 'done',
      eSignature: 'done',
      moduleAccess: 'done',
    });
    expect(own?.employeeProgress).toEqual({ done: 8, total: 8 });
    expect(own?.showReminder).toBe(false);
    expect(own?.complete).toBe(false);

    // HR completes their items and verifies both groups: complete.
    await setReportingTo(emp, [writer]);
    await addCompensationEntry(hr.actor, {
      employeeId: emp.employeeId,
      effectiveDate: '2026-01-01',
      basicSalaryCentavos: 3_000_000,
      rateType: 'monthly',
      minimumWageEarner: false,
      reason: 'Hired',
    });
    let version = await recordVersion(emp);
    ({ version } = await markVerified(hr.actor, {
      employeeId: emp.employeeId,
      version,
      group: 'governmentIds',
    }));
    await markVerified(hr.actor, { employeeId: emp.employeeId, version, group: 'bankAccount' });
    own = await getOwnOnboarding(emp.actor);
    expect(states(must(own))).toMatchObject({
      governmentIds: 'done',
      bankAccount: 'done',
      reportingTo: 'done',
      compensation: 'done',
    });
    expect(own?.hrProgress).toEqual({ done: 8, total: 8 });
    expect(own?.complete).toBe(true);
  });

  it('counts only live, unexpired required documents', async () => {
    const emp = await person('Dora', 'Docs', NET);
    await addOwnEmployeeDocument(
      emp.actor,
      { type: 'nbiClearance', title: null, issueDate: '2025-01-05', expiryDate: '2026-09-14' },
      pdfFile(),
    );
    const { documentId } = await addOwnEmployeeDocument(
      emp.actor,
      { type: 'governmentIdCopy', title: null, issueDate: '2026-01-05', expiryDate: null },
      pdfFile(),
    );
    let item = must(await getOwnOnboarding(emp.actor)).employeeItems.find(
      (entry) => entry.key === 'documents',
    );
    expect(item?.state).toBe('todo');
    expect(item?.detail).toBe('Needed: NBI clearance');
    await archiveEmployeeDocument(hr.actor, { documentId, version: 1, reason: 'Wrong file' });
    item = must(await getOwnOnboarding(emp.actor)).employeeItems.find(
      (entry) => entry.key === 'documents',
    );
    expect(item?.detail).toBe('Needed: Government ID copy, NBI clearance');
  });

  it('reportingTo: an active supervisor, a Board member or "No supervisor", never a separated supervisor', async () => {
    const emp = await person('Sara', 'Solo', NET);
    const gone = await person('Gina', 'Gone', NET);
    await setReportingTo(emp, [gone]);
    await separate(gone);
    expect(states(must(await getOwnOnboarding(emp.actor))).reportingTo).toBe('todo');
    expect(states(must(await getOwnOnboarding(board.actor))).reportingTo).toBe('done');
    // A System Administrator's module access counts as done.
    expect(states(must(await getOwnOnboarding(admin.actor))).moduleAccess).toBe('done');

    await setNoSupervisorConfirmation(hr.actor, {
      employeeId: emp.employeeId,
      version: 0,
      confirmed: true,
    });
    const view = await getEmployeeOnboarding(hr.actor, emp.employeeId);
    expect(states(must(view)).reportingTo).toBe('done');
    expect(view?.noSupervisor.confirmed?.byName).toBe('Hana Reyes');
    expect(view?.noSupervisor.canWithdraw).toBe(true);
    const entry = (await auditEntries('talent.employeeRecord')).at(-1);
    expect(entry?.action).toBe('create');
    expect(entry?.actorId.toHexString()).toBe(hr.userId);

    // It counts only while no supervisor is active; with one, confirming is refused.
    const boss = await person('Boss', 'Active', NET);
    const other = await person('Omar', 'Other', NET);
    await setReportingTo(other, [boss]);
    await expect(
      setNoSupervisorConfirmation(hr.actor, {
        employeeId: other.employeeId,
        version: 0,
        confirmed: true,
      }),
    ).rejects.toThrow('active supervisor');
    expect((await getEmployeeOnboarding(hr.actor, other.employeeId))?.noSupervisor.canConfirm).toBe(
      false,
    );

    // Withdrawing; who may: HR, Board, System Administrator with Talent Read; never their own.
    await setNoSupervisorConfirmation(board.actor, {
      employeeId: emp.employeeId,
      version: 1,
      confirmed: false,
    });
    expect(states(must(await getEmployeeOnboarding(hr.actor, emp.employeeId))).reportingTo).toBe(
      'todo',
    );
    await expect(
      setNoSupervisorConfirmation(writer.actor, {
        employeeId: emp.employeeId,
        version: 2,
        confirmed: true,
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(
      setNoSupervisorConfirmation(hr.actor, {
        employeeId: hr.employeeId,
        version: 0,
        confirmed: true,
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });
});

describe('the e-signature gate (the Done when)', () => {
  it('a new user skips the checklist and keeps working, but approving names the missing item', async () => {
    const newcomer = await person('Nico', 'Neu', NET);
    const requester = await person('Rex', 'Quest', NET);
    // Skipping the checklist blocks nothing else: the timesheet, a time entry, the record.
    expect(await getOwnTimesheetView(newcomer.actor)).not.toBeNull();
    await timeIn(newcomer.actor);
    vi.setSystemTime(new Date('2026-09-14T11:00:00+08:00'));
    await timeOut(newcomer.actor, { activity: 'Rack and stack' });
    vi.setSystemTime(new Date('2026-09-14T10:00:00+08:00'));
    expect(await getOwnRecordView(newcomer.actor)).not.toBeNull();

    const submitted = await withTransaction((session) =>
      submitApproval(
        {
          type: SAMPLE_TYPE,
          record: { type: 'talent.sampleRecord', id: new Types.ObjectId(), label: 'S-1' },
          title: 'Sample request',
          href: '/talent',
          requesterUserId: requester.userId,
          steps: [{ kind: 'anyOf', label: 'Approver', approvers: { userIds: [newcomer.userId] } }],
        },
        { session },
      ),
    );
    const refusal = decide(newcomer.actor, submitted.id, 'approve');
    await expect(refusal).rejects.toBeInstanceOf(OnboardingGateError);
    await expect(refusal).rejects.toThrow(
      'Complete this onboarding item first: E-signature. Upload it in My record, then try again.',
    );
    const stored = await database()
      .collection('approvalRequests')
      .findOne({ _id: new Types.ObjectId(submitted.id) });
    expect(stored?.status).toBe('pending');

    await uploadESignature(newcomer.actor, pngFile());
    await decide(newcomer.actor, submitted.id, 'approve');
    const approved = await database()
      .collection('approvalRequests')
      .findOne({ _id: new Types.ObjectId(submitted.id) });
    expect(approved?.status).toBe('approved');
    expect(approved?.steps[0].decisions[0].signature.version).toBe(1);
  });
});

describe('verification', () => {
  async function withIds(dept: Department = NET, name = 'Vera') {
    const emp = await person(name, 'Verify', dept);
    let { version } = await setGovernmentIds(admin.actor, {
      employeeId: emp.employeeId,
      version: 0,
      ...IDS,
      rdoCode: '043',
    });
    ({ version } = await setBankAccount(admin.actor, {
      employeeId: emp.employeeId,
      version,
      bank: 'rcbc',
      accountNumber: ACCOUNT_NUMBER,
      accountName: `${name} Verify`,
    }));
    return { emp, version };
  }

  it('a verifier saving the group verifies it; the employee filling a blank clears it and notifies HR', async () => {
    const { emp } = await withIds();
    let view = await getEmployeeRecordView(hr.actor, emp.employeeId);
    expect(view?.governmentIds?.verification?.verifiedByName).toBe('Ada Admin');
    expect(view?.can.markGovernmentIdsVerified).toBe(false);

    // A record whose SSS is blank: the employee fills it in.
    const other = await person('Fely', 'Fill', NET);
    await setGovernmentIds(hr.actor, {
      employeeId: other.employeeId,
      version: 0,
      tin: IDS.tin,
      rdoCode: '043',
    });
    expect(
      (await getEmployeeRecordView(hr.actor, other.employeeId))?.governmentIds?.verification
        ?.verifiedByName,
    ).toBe('Hana Reyes');
    const result = await saveOwnGovernmentIds(other.actor, {
      version: 1,
      sss: IDS.sss,
      rdoCode: '043',
    });
    expect(result.sent).toEqual([]);
    expect(result.saved).toEqual(['sss']);
    view = await getEmployeeRecordView(hr.actor, other.employeeId);
    expect(view?.governmentIds?.verification).toBeNull();
    const sent = await notifications({
      event: VERIFICATION_NEEDED_EVENT,
      href: `/talent?employee=${other.employeeId}`,
    });
    const recipients = sent.map((n) => n.recipientUserId.toHexString());
    expect(recipients).toEqual(expect.arrayContaining([hr.userId, hrReader.userId]));
    expect(recipients).not.toContain(board.userId);
    expect(sent[0]?.title).toBe('Verify Fely Fill’s government IDs');
  });

  it('for an HR employee, the Board members and System Administrators are notified', async () => {
    const hrEmployee = await person('Hera', 'Hire', HRD);
    await saveOwnBankAccount(hrEmployee.actor, {
      version: 0,
      bank: 'unionbank',
      accountNumber: ACCOUNT_NUMBER,
      accountName: 'Hera Hire',
    });
    const sent = await notifications({
      event: VERIFICATION_NEEDED_EVENT,
      href: `/talent?employee=${hrEmployee.employeeId}`,
    });
    const recipients = sent.map((n) => n.recipientUserId.toHexString());
    expect(recipients).toEqual(expect.arrayContaining([board.userId, admin.userId]));
    expect(recipients).not.toContain(hr.userId);
    expect(sent[0]?.title).toBe('Verify Hera Hire’s payroll bank account');
  });

  it('who may mark verified', async () => {
    const emp = await person('Mara', 'Mark', NET);
    await saveOwnGovernmentIds(emp.actor, { version: 0, ...IDS, rdoCode: '043' });
    expect(
      (await getEmployeeRecordView(hr.actor, emp.employeeId))?.can.markGovernmentIdsVerified,
    ).toBe(true);
    for (const refused of [accounting, writer, reader]) {
      await expect(
        markVerified(refused.actor, {
          employeeId: emp.employeeId,
          version: 1,
          group: 'governmentIds',
        }),
      ).rejects.toBeInstanceOf(AccessDeniedError);
    }
    // An incomplete group is refused.
    await expect(
      markVerified(hr.actor, { employeeId: emp.employeeId, version: 1, group: 'bankAccount' }),
    ).rejects.toBeInstanceOf(ActionError);
    await markVerified(hr.actor, {
      employeeId: emp.employeeId,
      version: 1,
      group: 'governmentIds',
    });
    const entry = (await auditEntries('talent.employeeRecord')).at(-1);
    expect(entry?.action).toBe('update');
    expect(entry?.after.governmentIdsVerification).toBeTruthy();

    // Never on one's own record; HR never on an HR employee's; the Board and the System
    // Administrator (with Talent Write) do.
    await saveOwnGovernmentIds(hr.actor, {
      version: await recordVersion(hr),
      ...IDS,
      rdoCode: '043',
    });
    const hrColleague = await person('Hilda', 'Hale', HRD);
    await saveOwnGovernmentIds(hrColleague.actor, { version: 0, ...IDS, rdoCode: '043' });
    await expect(
      markVerified(hr.actor, {
        employeeId: hr.employeeId,
        version: await recordVersion(hr),
        group: 'governmentIds',
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(
      markVerified(hr.actor, {
        employeeId: hrColleague.employeeId,
        version: 1,
        group: 'governmentIds',
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    const { version } = await markVerified(board.actor, {
      employeeId: hrColleague.employeeId,
      version: 1,
      group: 'governmentIds',
    });
    expect(version).toBe(2);
    await markVerified(admin.actor, {
      employeeId: hr.employeeId,
      version: await recordVersion(hr),
      group: 'governmentIds',
    });
  });

  it('a Talent Read user who can’t see the section gets no verification state', async () => {
    const { emp } = await withIds(NET, 'Rhea');
    const view = await getEmployeeRecordView(reader.actor, emp.employeeId);
    expect(view?.governmentIds).toBeUndefined();
    expect(view?.bankAccount).toBeUndefined();
    const onboarding = await getEmployeeOnboarding(reader.actor, emp.employeeId);
    const items = Object.fromEntries(
      must(onboarding).employeeItems.map((item) => [item.key, item]),
    );
    expect(items.governmentIds?.state).toBe('hidden');
    expect(items.bankAccount?.state).toBe('hidden');
    expect(items.documents?.state).toBe('hidden');
    expect(onboarding?.hrItems.find((item) => item.key === 'compensation')?.state).toBe('hidden');
    expect(onboarding?.employeeProgress).toBeNull();
    expect(onboarding?.complete).toBeNull();
    expect(JSON.stringify(onboarding)).not.toMatch(/waitingForVerification|Needed:/);
    // HR sees every state.
    const forHr = await getEmployeeOnboarding(hr.actor, emp.employeeId);
    expect(forHr?.employeeProgress).not.toBeNull();
  });
});

describe('the /talent onboarding filter and tiles', () => {
  it('are for HR and the System Administrator only', async () => {
    const forHr = await listEmployeeRecords(hrReader.actor, { onboarding: 'verify' });
    expect(forHr.onboarding?.toVerify).toBeGreaterThan(0);
    expect(forHr.onboarding?.incomplete).toBeGreaterThan(0);
    expect(forHr.rows.length).toBe(forHr.onboarding?.toVerify);
    expect(forHr.rows.length).toBeLessThan((await listEmployeeRecords(hrReader.actor)).rows.length);
    const forReader = await listEmployeeRecords(reader.actor, { onboarding: 'verify' });
    expect(forReader.onboarding).toBeUndefined();
    expect(forReader.rows.length).toBe((await listEmployeeRecords(reader.actor)).rows.length);
  });
});

describe('uploads and certifications by the employee', () => {
  it('uploads an NBI clearance (HR notified, the type only), but not an employment contract; no edit or archive', async () => {
    const emp = await person('Uma', 'Upload', NET);
    const { documentId } = await addOwnEmployeeDocument(
      emp.actor,
      {
        type: 'nbiClearance',
        title: 'secret-title',
        issueDate: '2026-02-01',
        expiryDate: '2027-02-01',
      },
      pdfFile('my-nbi-scan.pdf'),
    );
    const sent = await notifications({
      event: DOCUMENT_UPLOADED_EVENT,
      href: `/talent?employee=${emp.employeeId}`,
    });
    expect(sent.map((n) => n.recipientUserId.toHexString())).toEqual(
      expect.arrayContaining([hr.userId, hrReader.userId]),
    );
    expect(sent[0]?.title).toBe('Uma Upload uploaded an NBI clearance');
    expect(JSON.stringify(sent)).not.toMatch(/secret-title|my-nbi-scan/);
    const own = await getOwnRecordView(emp.actor);
    expect(own?.documents?.[0]?.uploadedByName).toBe('Uma Upload');
    expect((await auditEntries('talent.employeeDocument')).at(-1)?.action).toBe('create');

    await expect(
      addOwnEmployeeDocument(
        emp.actor,
        { type: 'employmentContract', title: null, issueDate: '2026-02-01', expiryDate: null },
        pdfFile(),
      ),
    ).rejects.toThrow('HR issues the employment contract');
    await expect(
      updateEmployeeDocument(emp.actor, {
        documentId,
        version: 1,
        type: 'nbiClearance',
        title: null,
        issueDate: '2026-02-01',
        expiryDate: null,
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(
      archiveEmployeeDocument(emp.actor, { documentId, version: 1, reason: 'x' }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(
      addEmployeeDocument(
        emp.actor,
        {
          employeeId: emp.employeeId,
          type: 'nbiClearance',
          title: null,
          issueDate: '2026-02-01',
          expiryDate: null,
        },
        pdfFile(),
      ),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(
      addOwnEmployeeDocument(
        await systemAccount(),
        { type: 'nbiClearance', title: null, issueDate: '2026-02-01', expiryDate: null },
        pdfFile(),
      ),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it('adds a certification, shown "Added by", and can’t edit or remove it', async () => {
    const emp = await person('Cesar', 'Cert', NET);
    const { certificationId } = await addOwnCertification(emp.actor, {
      name: 'CCNA',
      issuer: 'Cisco',
      brandId: null,
      licenseNumber: null,
      issueDate: '2026-03-01',
      expiryDate: '2029-03-01',
    });
    const own = await getOwnRecordView(emp.actor);
    expect(own?.certifications[0]?.addedByName).toBe('Cesar Cert');
    expect((await auditEntries('talent.certification')).at(-1)?.action).toBe('create');
    await setTalentAccess(emp, 'owner');
    const elevated = {
      ...emp.actor,
      moduleAccess: { ...emp.actor.moduleAccess, talent: 'owner' as const },
    };
    await expect(
      updateCertification(elevated, {
        certificationId,
        version: 1,
        name: 'CCNP',
        issuer: 'Cisco',
        brandId: null,
        licenseNumber: null,
        issueDate: '2026-03-01',
        expiryDate: null,
        removeAttachment: false,
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(
      removeCertification(elevated, { certificationId, version: 1 }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });
});

/** The value, failing the test when it is missing. */
function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Expected a value.');
  return value;
}
