import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { createCertification, removeCertification } from '../certifications/service';
import { CertificationModel } from '../certifications/model';
import {
  addEmployeeDocument,
  archiveEmployeeDocument,
  updateEmployeeDocument,
} from '../documents/service';
import { EmployeeDocumentModel } from '../documents/model';
import {
  type Department,
  department,
  moveTo,
  notifications,
  pdfFile,
  type Person,
  person,
  separate,
  setReportingTo,
} from '../testing/fixtures';
import {
  CERTIFICATION_EXPIRED_EVENT,
  CERTIFICATION_EXPIRING_EVENT,
  DOCUMENT_EXPIRED_EVENT,
  DOCUMENT_EXPIRING_EVENT,
  EXPIRY_ALERTS_SCHEDULE,
  runExpiryAlerts,
} from './job';
import { updateExpiryAlertSettings } from './settings';

// The expiry alert job (build step 2.2, decisions 185–187 in docs/BUILD_PLAN.md; the step's
// "Done when": an expiring document and certification raise alerts). Made-up people and dates.

/** 8:00 AM Manila on a day. */
const at = (day: string) => new Date(`${day}T08:00:00+08:00`);

let storageDir: string;
let NET: Department;
let HRD: Department;
let admin: Person;
let hr: Person;
let owner: Person;
let subject: Person;
let supervisor: Person;
let formerSupervisor: Person;

beforeAll(async () => {
  storageDir = await mkdtemp(path.join(tmpdir(), 'pulse-test-storage-'));
  process.env.FILE_STORAGE_DIR = storageDir;
  await connectDb();
  await Promise.all([EmployeeDocumentModel.init(), CertificationModel.init()]);
  NET = await department('Network', 'NET');
  HRD = await department('Human Resource', 'HR');
  admin = await person('Ada', 'Admin', NET, { admin: true });
  hr = await person('Hana', 'Reyes', HRD, { talent: 'owner' });
  owner = await person('Oscar', 'Tan', NET, { talent: 'owner' });
  subject = await person('Ellen', 'Garcia', NET);
  supervisor = await person('Sonia', 'Villa', NET);
  formerSupervisor = await person('Fidel', 'Ong', NET);
  await setReportingTo(subject, [supervisor, formerSupervisor]);
  await separate(formerSupervisor);
});

afterAll(async () => {
  await rm(storageDir, { recursive: true, force: true });
});

function addDocument(
  who: Person,
  type: 'nbiClearance' | 'medicalCertificate',
  expiryDate: string,
  title: string | null = null,
) {
  return addEmployeeDocument(
    hr.actor,
    { employeeId: who.employeeId, type, title, issueDate: '2025-01-01', expiryDate },
    pdfFile('a-file-name-that-must-not-appear.pdf'),
  );
}

function addCertification(who: Person, expiryDate: string) {
  return createCertification(hr.actor, {
    employeeId: who.employeeId,
    name: 'Secret Cert Title',
    issuer: 'Made-up Body',
    brandId: null,
    licenseNumber: null,
    issueDate: '2025-01-01',
    expiryDate,
  });
}

async function alertsFor(recordId: string) {
  return notifications({ 'record.id': new Types.ObjectId(recordId) });
}

const byRecipient = (rows: { recipientUserId: Types.ObjectId; href: string }[]) =>
  Object.fromEntries(rows.map((row) => [row.recipientUserId.toHexString(), row.href]));

describe('the schedule', () => {
  it('runs daily at 8:00 AM', () => {
    expect(EXPIRY_ALERTS_SCHEDULE.id).toBe('talent.expiryAlerts');
    expect(EXPIRY_ALERTS_SCHEDULE.pattern).toBe('0 8 * * *');
  });
});

describe('expiry alerts (the step’s "Done when")', () => {
  it('alerts HR and the employee on an expiring document, and supervisors too on a certification, once each', async () => {
    const document = await addDocument(subject, 'nbiClearance', '2026-11-20', null);
    const titled = await addDocument(subject, 'medicalCertificate', '2026-11-25');
    const far = await addDocument(subject, 'nbiClearance', '2027-03-01');
    const certification = await addCertification(subject, '2026-11-15');

    const result = await runExpiryAlerts(at('2026-11-01'));
    expect(result.documentLeadDays).toBe(30);
    expect(result.certificationLeadDays).toBe(30);

    const documentAlerts = await alertsFor(document.documentId);
    expect(documentAlerts.every((n) => n.event === DOCUMENT_EXPIRING_EVENT)).toBe(true);
    expect(byRecipient(documentAlerts)).toEqual({
      [subject.userId]: '/talent/me',
      [hr.userId]: `/talent?employee=${subject.employeeId}`,
    });
    const own = documentAlerts.find((n) => n.recipientUserId.toHexString() === subject.userId);
    expect(own?.title).toBe('Your NBI clearance expires on Nov 20, 2026');
    const hrAlert = documentAlerts.find((n) => n.recipientUserId.toHexString() === hr.userId);
    expect(hrAlert?.title).toBe('NBI clearance expiring: Ellen Garcia');
    expect((await alertsFor(titled.documentId)).length).toBe(2);
    expect(await alertsFor(far.documentId)).toEqual([]);

    const certificationAlerts = await alertsFor(certification.certificationId);
    expect(certificationAlerts.every((n) => n.event === CERTIFICATION_EXPIRING_EVENT)).toBe(true);
    expect(byRecipient(certificationAlerts)).toEqual({
      [subject.userId]: '/talent/me',
      [hr.userId]: `/talent?employee=${subject.employeeId}`,
      [supervisor.userId]: `/directory?person=${subject.employeeId}`,
    });

    // No file name, document title or certification name in any text.
    const text = JSON.stringify(await notifications({ module: 'talent' }));
    expect(text).not.toContain('a-file-name-that-must-not-appear');
    expect(text).not.toContain('Secret Cert Title');

    // A rerun sends nothing twice.
    const before = (await notifications()).length;
    expect((await runExpiryAlerts(at('2026-11-01'))).notified).toBe(0);
    expect((await runExpiryAlerts(at('2026-11-02'))).notified).toBe(0);
    expect((await notifications()).length).toBe(before);

    // A changed expiry date alerts again.
    await updateEmployeeDocument(hr.actor, {
      documentId: document.documentId,
      version: 1,
      type: 'nbiClearance',
      title: null,
      issueDate: '2025-01-01',
      expiryDate: '2026-11-22',
    });
    await runExpiryAlerts(at('2026-11-03'));
    expect((await alertsFor(document.documentId)).length).toBe(4);

    // The expired alert, once, on or after the expiry date.
    await runExpiryAlerts(at('2026-11-22'));
    await runExpiryAlerts(at('2026-11-23'));
    const expired = (await alertsFor(document.documentId)).filter(
      (n) => n.event === DOCUMENT_EXPIRED_EVENT,
    );
    expect(expired.map((n) => n.recipientUserId.toHexString()).sort()).toEqual(
      [subject.userId, hr.userId].sort(),
    );
    expect(expired.find((n) => n.recipientUserId.toHexString() === subject.userId)?.title).toBe(
      'Your NBI clearance expired on Nov 22, 2026',
    );
    await runExpiryAlerts(at('2026-11-15'));
    expect(
      (await alertsFor(certification.certificationId)).filter(
        (n) => n.event === CERTIFICATION_EXPIRED_EVENT,
      ),
    ).toHaveLength(3);
  });

  it('skips archived documents, removed certifications and separated employees', async () => {
    const other = await person('Gina', 'Lim', NET);
    const leaver = await person('Lito', 'Cruz', NET);
    const archived = await addDocument(other, 'nbiClearance', '2026-12-10');
    await archiveEmployeeDocument(hr.actor, { ...archived, reason: 'Superseded.' });
    const removed = await addCertification(other, '2026-12-10');
    await removeCertification(owner.actor, {
      certificationId: removed.certificationId,
      version: 1,
    });
    const leaversDocument = await addDocument(leaver, 'nbiClearance', '2026-12-10');
    const leaversCertification = await addCertification(leaver, '2026-12-10');
    await separate(leaver);

    await runExpiryAlerts(at('2026-12-01'));
    for (const id of [
      archived.documentId,
      removed.certificationId,
      leaversDocument.documentId,
      leaversCertification.certificationId,
    ]) {
      expect(await alertsFor(id)).toEqual([]);
    }
  });

  it('sends the HR alerts to the System Administrators when no HR user is active', async () => {
    const other = await person('Mara', 'Sison', NET);
    const document = await addDocument(other, 'nbiClearance', '2027-01-10');
    await moveTo(hr, NET);
    try {
      await runExpiryAlerts(at('2027-01-01'));
    } finally {
      await moveTo(hr, HRD);
    }
    const recipients = Object.keys(byRecipient(await alertsFor(document.documentId)));
    expect(recipients).toContain(admin.userId);
    expect(recipients).toContain(other.userId);
    expect(recipients).not.toContain(hr.userId);
  });

  it('takes the lead days from talent.expiryAlerts', async () => {
    await updateExpiryAlertSettings(owner.actor, {
      documentLeadDays: 10,
      certificationLeadDays: 5,
    });
    const other = await person('Nena', 'Abad', NET);
    const inTwenty = await addDocument(other, 'nbiClearance', '2027-02-21');
    const inSeven = await addCertification(other, '2027-02-08');
    const result = await runExpiryAlerts(at('2027-02-01'));
    expect(result).toMatchObject({ documentLeadDays: 10, certificationLeadDays: 5 });
    expect(await alertsFor(inTwenty.documentId)).toEqual([]);
    expect(await alertsFor(inSeven.certificationId)).toEqual([]);
    await runExpiryAlerts(at('2027-02-11'));
    expect((await alertsFor(inTwenty.documentId)).length).toBe(2);
  });
});
