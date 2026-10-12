import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { AccessDeniedError, ActionError, addDays, businessToday } from '@pulse/core';
import { openAccessibleFile } from '@pulse/core/server';
import { RECORD_CHANGED_ELSEWHERE } from '../../validation';
import { CERTIFICATION_TYPE } from '../../views';
import { getEmployeeRecordView, getOwnRecordView, setSkills } from '../employee-records/service';
import { EmployeeRecordModel } from '../employee-records/model';
import { getExpiryAlertSettings, updateExpiryAlertSettings } from '../expiry-alerts/settings';
import { registerTalentFileAccess } from '../files/registrations';
import {
  auditEntries,
  brand,
  countAudit,
  currentUser,
  type Department,
  department,
  pdfFile,
  type Person,
  person,
  separate,
} from '../testing/fixtures';
import { CertificationModel } from './model';
import {
  countCertifiedEmployeesByBrand,
  createCertification,
  listCertifications,
  removeCertification,
  updateCertification,
} from './service';

// Certifications, skills and the expiry alert setting (build step 2.2, decisions 182–184 and 187
// in docs/BUILD_PLAN.md, docs/TESTING.md#document-e-signature-and-certification-tests). Made-up
// people, products and license numbers only.

const LICENSE = 'LIC-0000-MADEUP';
const READ_ROW_KEYS = [
  'certificationId',
  'employee',
  'expiryDate',
  'issueDate',
  'issuer',
  'name',
  'product',
  'skills',
  'status',
].sort();

let storageDir: string;
let NET: Department;
let HRD: Department;
let admin: Person;
let hr: Person;
let writer: Person;
let owner: Person;
let reader: Person;
let nobody: Person;
let engage: Person;
let ops: Person;
let fortinet: string;
let cisco: string;

beforeAll(async () => {
  storageDir = await mkdtemp(path.join(tmpdir(), 'pulse-test-storage-'));
  process.env.FILE_STORAGE_DIR = storageDir;
  await connectDb();
  await Promise.all([CertificationModel.init(), EmployeeRecordModel.init()]);
  NET = await department('Network', 'NET');
  HRD = await department('Human Resource', 'HR');
  admin = await person('Ada', 'Admin', NET, { admin: true });
  hr = await person('Hana', 'Reyes', HRD, { talent: 'write' });
  writer = await person('Wena', 'Cruz', NET, { talent: 'write' });
  owner = await person('Oscar', 'Tan', NET, { talent: 'owner' });
  reader = await person('Rita', 'Uy', NET, { talent: 'read' });
  nobody = await person('Nico', 'Sy', NET);
  engage = await person('Elle', 'Go', NET);
  ops = await person('Opal', 'Ty', NET);
  // Engage and Ops Read, set as Core's access service would.
  const users = (await import('mongoose')).default.model('User');
  await users.updateOne(
    { _id: new Types.ObjectId(engage.userId) },
    { $set: { 'moduleAccess.engage': 'read' } },
  );
  await users.updateOne(
    { _id: new Types.ObjectId(ops.userId) },
    { $set: { 'moduleAccess.ops': 'read' } },
  );
  engage.actor.moduleAccess = { ...engage.actor.moduleAccess, engage: 'read' };
  ops.actor.moduleAccess = { ...ops.actor.moduleAccess, ops: 'read' };
  fortinet = await brand('Fortinet Test');
  cisco = await brand('Cisco Test');
  registerTalentFileAccess();
});

afterAll(async () => {
  await rm(storageDir, { recursive: true, force: true });
});

function certificationInput(subject: Person, overrides: Record<string, unknown> = {}) {
  return {
    employeeId: subject.employeeId,
    name: 'NSE 4 Network Security Professional',
    issuer: 'Fortinet',
    brandId: fortinet,
    licenseNumber: LICENSE,
    issueDate: '2025-06-01',
    expiryDate: '2027-06-01',
    ...overrides,
  };
}

describe('who changes certifications', () => {
  it('lets Talent Write add and edit, and Talent Owner remove, with their audit entries', async () => {
    const subject = await person('Ellen', 'Garcia', NET);
    const created = await createCertification(writer.actor, certificationInput(subject), pdfFile());
    const edited = await updateCertification(writer.actor, {
      certificationId: created.certificationId,
      version: 1,
      ...certificationInput(subject, { name: 'NSE 5' }),
      removeAttachment: false,
    });
    expect(edited.version).toBe(2);
    await expect(
      removeCertification(writer.actor, { certificationId: created.certificationId, version: 2 }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(
      removeCertification(owner.actor, { certificationId: created.certificationId, version: 1 }),
    ).rejects.toThrow(RECORD_CHANGED_ELSEWHERE);
    await removeCertification(owner.actor, {
      certificationId: created.certificationId,
      version: 2,
    });

    const stored = await CertificationModel.findById(created.certificationId, null, {
      withDeleted: true,
    }).lean();
    expect(stored?.deletedAt).not.toBeNull();
    expect(await CertificationModel.findById(created.certificationId).lean()).toBeNull();
    const entries = (await auditEntries(CERTIFICATION_TYPE)).filter(
      (e) => e.record.id.toHexString() === created.certificationId,
    );
    expect(entries.map((e) => e.action)).toEqual(['create', 'update', 'delete']);
    expect(entries[2]?.after).toBeNull();
    expect(entries[1]?.record.label).toBe(`${subject.employeeNumber} · NSE 5`);
    expect((await getEmployeeRecordView(hr.actor, subject.employeeId))?.certifications).toEqual([]);
  });

  it('adds a certification with the longest name allowed (the audit label is shortened)', async () => {
    const subject = await person('Nina', 'Longa', NET);
    const created = await createCertification(
      writer.actor,
      certificationInput(subject, { name: 'N'.repeat(200) }),
    );
    const [entry] = (await auditEntries(CERTIFICATION_TYPE)).filter(
      (e) => e.record.id.toHexString() === created.certificationId,
    );
    expect(entry?.record.label.length).toBe(200);
    expect(entry?.record.label.startsWith(`${subject.employeeNumber} · NNN`)).toBe(true);
  });

  it('refuses Talent Read, no access and one’s own record, and writes nothing', async () => {
    const subject = await person('Fely', 'Ramos', NET);
    const audit = await countAudit();
    for (const [actor, target] of [
      [reader, subject],
      [nobody, subject],
      [writer, writer],
      [admin, admin],
    ] as const) {
      await expect(
        createCertification(actor.actor, certificationInput(target)),
      ).rejects.toBeInstanceOf(AccessDeniedError);
    }
    const created = await createCertification(hr.actor, certificationInput(subject));
    await expect(
      removeCertification(owner.actor, { certificationId: created.certificationId, version: 1 }),
    ).resolves.toBeUndefined();
    const own = await createCertification(writer.actor, certificationInput(owner));
    await expect(
      removeCertification(owner.actor, { certificationId: own.certificationId, version: 1 }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    expect(await countAudit()).toBe(audit + 3);
  });

  it('refuses a product that isn’t in Core’s list, and an expiry before the issue date', async () => {
    const subject = await person('Gina', 'Lim', NET);
    await expect(
      createCertification(
        writer.actor,
        certificationInput(subject, { brandId: new Types.ObjectId().toHexString() }),
      ),
    ).rejects.toMatchObject({ field: 'brandId' });
    await expect(
      createCertification(writer.actor, certificationInput(subject, { expiryDate: '2025-01-01' })),
    ).rejects.toMatchObject({ field: 'expiryDate' });
  });

  it('opens the attachment for the employee, Talent Read and the System Administrator only', async () => {
    const subject = await person('Hilda', 'Uy', NET);
    const created = await createCertification(writer.actor, certificationInput(subject), pdfFile());
    const view = await getEmployeeRecordView(reader.actor, subject.employeeId);
    const url = view?.certifications.find((c) => c.id === created.certificationId)?.attachmentUrl;
    expect(url).toMatch(/^\/files\/[a-f\d]{24}$/);
    const fileId = (url ?? '').replace('/files/', '');
    for (const [viewer, allowed] of [
      [subject, true],
      [reader, true],
      [admin, true],
      [nobody, false],
      [engage, false],
    ] as const) {
      const opened = await openAccessibleFile(currentUser(viewer), fileId);
      if (allowed) {
        expect(opened).not.toBeNull();
        await opened?.stream.cancel();
      } else {
        expect(opened).toBeNull();
      }
    }
    // Replaced: the old file no longer opens.
    await updateCertification(writer.actor, {
      certificationId: created.certificationId,
      version: 1,
      ...certificationInput(subject),
      removeAttachment: true,
    });
    expect(await openAccessibleFile(currentUser(reader), fileId)).toBeNull();
    // The employee sees their certifications on /talent/me, read-only.
    const own = await getOwnRecordView(subject.actor);
    expect(own?.certifications.map((c) => c.id)).toEqual([created.certificationId]);
    expect(own?.can.addCertification).toBe(false);
  });
});

describe('the read services', () => {
  it('need Talent, Engage or Ops Read, or the System Administrator', async () => {
    for (const actor of [reader, engage, ops, admin]) {
      await expect(listCertifications(actor.actor)).resolves.toBeInstanceOf(Array);
      await expect(countCertifiedEmployeesByBrand(actor.actor, [fortinet])).resolves.toHaveLength(
        1,
      );
    }
    await expect(listCertifications(nobody.actor)).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(countCertifiedEmployeesByBrand(nobody.actor, [fortinet])).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
  });

  it('return exactly the allowlisted keys, never the license number or the attachment, and leave out separated employees', async () => {
    const today = businessToday();
    const active = await person('Ivan', 'Cortez', NET);
    const leaver = await person('Jose', 'Rizal', NET);
    await setSkills(writer.actor, {
      employeeId: active.employeeId,
      version: 0,
      skills: ['BGP', 'SD-WAN'],
    });
    const current = await createCertification(
      writer.actor,
      certificationInput(active, { brandId: cisco, expiryDate: addDays(today, 200) }),
      pdfFile(),
    );
    const expiring = await createCertification(
      writer.actor,
      certificationInput(active, { brandId: cisco, name: 'CCNP', expiryDate: addDays(today, 10) }),
    );
    const expired = await createCertification(
      writer.actor,
      certificationInput(active, {
        brandId: cisco,
        name: 'CCNA',
        issueDate: '2020-01-01',
        expiryDate: addDays(today, -1),
      }),
    );
    await createCertification(writer.actor, certificationInput(leaver, { brandId: cisco }));
    await separate(leaver);

    const rows = await listCertifications(engage.actor, { brandIds: [cisco] });
    expect(rows.map((r) => r.certificationId).sort()).toEqual(
      [current.certificationId, expiring.certificationId].sort(),
    );
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(READ_ROW_KEYS);
      expect(Object.keys(row.employee).sort()).toEqual(['employeeId', 'employeeNumber', 'name']);
      expect(row.employee.employeeId).toBe(active.employeeId);
      expect(row.skills).toEqual(['BGP', 'SD-WAN']);
      expect(row.product).toEqual({ id: cisco, name: 'Cisco Test' });
    }
    const json = JSON.stringify(rows);
    expect(json).not.toContain(LICENSE);
    expect(json).not.toContain('/files/');
    expect(json).not.toContain('attachment');
    expect(rows.find((r) => r.certificationId === expiring.certificationId)?.status).toBe(
      'expiring',
    );
    expect(rows.find((r) => r.certificationId === current.certificationId)?.status).toBe('current');

    const withExpired = await listCertifications(ops.actor, {
      brandIds: [cisco],
      includeExpired: true,
    });
    expect(withExpired.find((r) => r.certificationId === expired.certificationId)?.status).toBe(
      'expired',
    );
    expect(withExpired.some((r) => r.employee.employeeId === leaver.employeeId)).toBe(false);

    expect(await countCertifiedEmployeesByBrand(engage.actor, [cisco, fortinet, cisco])).toEqual([
      { brandId: cisco, count: 1 },
      { brandId: fortinet, count: expect.any(Number) },
    ]);
  });
});

describe('skills', () => {
  it('saves tags with the version check and refuses over 30, over 50 characters and duplicates', async () => {
    const subject = await person('Karla', 'Diaz', NET);
    const { version } = await setSkills(writer.actor, {
      employeeId: subject.employeeId,
      version: 0,
      skills: 'Fortinet, Cisco\nPython' as unknown as string[],
    });
    expect((await getEmployeeRecordView(reader.actor, subject.employeeId))?.skills).toEqual([
      'Fortinet',
      'Cisco',
      'Python',
    ]);
    const tooMany = Array.from({ length: 31 }, (_, i) => `Skill ${i}`);
    for (const skills of [tooMany, ['x'.repeat(51)], ['Linux', 'linux']]) {
      await expect(
        setSkills(writer.actor, { employeeId: subject.employeeId, version, skills }),
      ).rejects.toBeInstanceOf(ActionError);
    }
    await expect(
      setSkills(writer.actor, { employeeId: subject.employeeId, version: 0, skills: [] }),
    ).rejects.toThrow(RECORD_CHANGED_ELSEWHERE);
    await expect(
      setSkills(reader.actor, { employeeId: subject.employeeId, version, skills: [] }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(
      setSkills(writer.actor, { employeeId: writer.employeeId, version: 0, skills: [] }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });
});

describe('the expiry alert setting', () => {
  it('defaults to 30 days, and a Talent Owner changes it once per Manila day', async () => {
    const before = await getExpiryAlertSettings(reader.actor);
    expect(before).toMatchObject({
      documentLeadDays: 30,
      certificationLeadDays: 30,
      canChange: false,
    });
    await expect(
      updateExpiryAlertSettings(writer.actor, { documentLeadDays: 45, certificationLeadDays: 60 }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(
      updateExpiryAlertSettings(owner.actor, { documentLeadDays: 0, certificationLeadDays: 60 }),
    ).rejects.toMatchObject({ field: 'documentLeadDays' });
    const changed = await updateExpiryAlertSettings(owner.actor, {
      documentLeadDays: 45,
      certificationLeadDays: 60,
    });
    expect(changed).toMatchObject({
      documentLeadDays: 45,
      certificationLeadDays: 60,
      changedToday: true,
    });
    await expect(
      updateExpiryAlertSettings(owner.actor, { documentLeadDays: 10, certificationLeadDays: 10 }),
    ).rejects.toThrow(/already changed today/);
    const entries = await auditEntries('core.configVersion');
    expect(entries.at(-1)?.action).toBe('create');
    expect(entries.at(-1)?.module).toBe('core');
    expect((await getExpiryAlertSettings(owner.actor)).canChange).toBe(true);
  });
});
