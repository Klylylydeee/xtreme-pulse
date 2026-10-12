import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { AccessDeniedError, ActionError } from '@pulse/core';
import { openAccessibleFile } from '@pulse/core/server';
import {
  DOCUMENTS_NOTICE,
  MEDICAL_DOCUMENTS_NOTICE,
  RECORD_CHANGED_ELSEWHERE,
} from '../../validation';
import { EMPLOYEE_DOCUMENT_TYPE, type EmployeeRecordView } from '../../views';
import { getEmployeeRecordView, getOwnRecordView } from '../employee-records/service';
import { registerTalentFileAccess } from '../files/registrations';
import {
  auditEntries,
  countAudit,
  currentUser,
  database,
  type Department,
  department,
  moveTo,
  pdfFile,
  type Person,
  person,
} from '../testing/fixtures';
import { EmployeeDocumentModel } from './model';
import {
  addEmployeeDocument,
  archiveEmployeeDocument,
  listEmployeeDocuments,
  REPLACED_BY_RENEWAL_REASON,
  updateEmployeeDocument,
} from './service';

// The 201 file (build step 2.2, decisions 178–181 in docs/BUILD_PLAN.md,
// docs/TESTING.md#document-e-signature-and-certification-tests): who sees and changes documents,
// at the service and at the file route, the guards, and the audit. Made-up people and files only.

let storageDir: string;
let NET: Department;
let HRD: Department;
let ACCT: Department;
let BOD: Department;

let admin: Person;
let hr: Person;
let hrColleague: Person;
let accounting: Person;
let board: Person;
let writer: Person;
let reader: Person;

beforeAll(async () => {
  storageDir = await mkdtemp(path.join(tmpdir(), 'pulse-test-storage-'));
  process.env.FILE_STORAGE_DIR = storageDir;
  await connectDb();
  await EmployeeDocumentModel.init();
  NET = await department('Network', 'NET');
  HRD = await department('Human Resource', 'HR');
  ACCT = await department('Accounting', 'ACCT');
  BOD = await department('Board of Directors', 'BOD');
  admin = await person('Ada', 'Admin', NET, { admin: true });
  hr = await person('Hana', 'Reyes', HRD, { talent: 'write' });
  hrColleague = await person('Hector', 'Ramos', HRD, { talent: 'read' });
  accounting = await person('Abel', 'Santos', ACCT, { talent: 'read' });
  board = await person('Bert', 'Lim', BOD, { talent: 'write' });
  writer = await person('Wena', 'Cruz', NET, { talent: 'write' });
  reader = await person('Rita', 'Uy', NET, { talent: 'read' });
  registerTalentFileAccess();
});

afterAll(async () => {
  await rm(storageDir, { recursive: true, force: true });
});

afterEach(async () => {
  await database().command({ collMod: 'auditLogs', validator: {} });
});

async function blockAudit(): Promise<void> {
  await database().command({
    collMod: 'auditLogs',
    validator: { $jsonSchema: { required: ['aFieldNoEntryHas'] } },
    validationLevel: 'strict',
    validationAction: 'error',
  });
}

function documentInput(subject: Person, overrides: Record<string, unknown> = {}) {
  return {
    employeeId: subject.employeeId,
    type: 'nbiClearance' as const,
    title: null,
    issueDate: '2026-01-15',
    expiryDate: '2027-01-15',
    ...overrides,
  };
}

/** A subject with an NBI clearance and a medical certificate, added by HR. */
async function subjectWithDocuments(name: string) {
  const subject = await person(name, 'Garcia', NET);
  const nbi = await addEmployeeDocument(hr.actor, documentInput(subject), pdfFile('nbi.pdf'));
  const medical = await addEmployeeDocument(
    hr.actor,
    documentInput(subject, {
      type: 'medicalCertificate',
      title: 'Annual physical exam',
      expiryDate: null,
    }),
    pdfFile('medical.pdf'),
  );
  return { subject, nbi, medical };
}

const fileIdOf = (url: string) => url.replace('/files/', '');

/** The view as the page would receive it (JSON). */
const serialized = (view: EmployeeRecordView | null) => JSON.stringify(view);

describe('who sees 201 documents', () => {
  it('gives HR and the System Administrator every document', async () => {
    const { subject, nbi, medical } = await subjectWithDocuments('Ellen');
    for (const viewer of [hr, admin]) {
      const view = await getEmployeeRecordView(viewer.actor, subject.employeeId);
      expect(view?.documents?.map((d) => d.id).sort()).toEqual(
        [nbi.documentId, medical.documentId].sort(),
      );
      expect(view?.documentsNotice).toBeUndefined();
    }
  });

  it('gives Accounting all but medical certificates, with the medical line', async () => {
    const { subject, nbi, medical } = await subjectWithDocuments('Fely');
    const view = await getEmployeeRecordView(accounting.actor, subject.employeeId);
    expect(view?.documents?.map((d) => d.id)).toEqual([nbi.documentId]);
    expect(view?.documentsNotice).toBe(MEDICAL_DOCUMENTS_NOTICE);
    const json = serialized(view);
    expect(json).not.toContain(medical.documentId);
    expect(json).not.toContain('Annual physical exam');
    expect(json).not.toContain('medicalCertificate');
  });

  it('gives the employee their own documents on /talent/me', async () => {
    const { subject, nbi, medical } = await subjectWithDocuments('Gina');
    const view = await getOwnRecordView(subject.actor);
    expect(view?.documents?.map((d) => d.id).sort()).toEqual(
      [nbi.documentId, medical.documentId].sort(),
    );
    expect(view?.can.manageDocuments).toBe(false);
  });

  it('gives Talent access alone and a Board member no document and no document data', async () => {
    const { subject, nbi, medical } = await subjectWithDocuments('Hilda');
    const files = (await getEmployeeRecordView(hr.actor, subject.employeeId))?.documents?.map((d) =>
      fileIdOf(d.fileUrl),
    );
    for (const viewer of [writer, reader, board]) {
      const view = await getEmployeeRecordView(viewer.actor, subject.employeeId);
      expect(view).not.toBeNull();
      expect(Object.keys(view ?? {})).not.toContain('documents');
      expect(view?.documentsNotice).toBe(DOCUMENTS_NOTICE);
      const json = serialized(view);
      for (const hidden of [
        nbi.documentId,
        medical.documentId,
        ...(files ?? []),
        'nbiClearance',
        'Annual physical exam',
      ]) {
        expect(json).not.toContain(hidden);
      }
      expect(await listEmployeeDocuments(viewer.actor, subject.employeeId)).toEqual({
        notice: DOCUMENTS_NOTICE,
      });
    }
  });

  it('gives the same answers at the file route, and logs every open', async () => {
    const { subject } = await subjectWithDocuments('Ines');
    const docs = (await getEmployeeRecordView(hr.actor, subject.employeeId))?.documents ?? [];
    const nbiFile = fileIdOf(docs.find((d) => d.type === 'nbiClearance')?.fileUrl ?? '');
    const medicalFile = fileIdOf(docs.find((d) => d.type === 'medicalCertificate')?.fileUrl ?? '');

    const cases: [Person, string, boolean][] = [
      [hr, nbiFile, true],
      [hr, medicalFile, true],
      [admin, medicalFile, true],
      [accounting, nbiFile, true],
      [accounting, medicalFile, false],
      [subject, nbiFile, true],
      [subject, medicalFile, true],
      [writer, nbiFile, false],
      [reader, nbiFile, false],
      [board, medicalFile, false],
    ];
    for (const [viewer, fileId, allowed] of cases) {
      const before = (await auditEntries(EMPLOYEE_DOCUMENT_TYPE)).filter(
        (e) => e.action === 'reveal',
      ).length;
      const opened = await openAccessibleFile(currentUser(viewer), fileId);
      const reveals = (await auditEntries(EMPLOYEE_DOCUMENT_TYPE)).filter(
        (e) => e.action === 'reveal',
      );
      if (allowed) {
        expect(opened, `${viewer.firstName} opens`).not.toBeNull();
        await opened?.stream.cancel();
        expect(reveals).toHaveLength(before + 1);
        const entry = reveals[reveals.length - 1];
        expect(entry?.fields).toEqual(['file']);
        expect(entry?.module).toBe('talent');
        expect(entry?.actorId?.toHexString()).toBe(viewer.userId);
        expect(entry?.record.label).toMatch(new RegExp(`^${subject.employeeNumber} · `));
      } else {
        expect(opened, `${viewer.firstName} is refused`).toBeNull();
        expect(reveals).toHaveLength(before);
      }
    }
    // A refused file and a missing one get the same answer.
    expect(
      await openAccessibleFile(currentUser(writer), new Types.ObjectId().toHexString()),
    ).toBeNull();
  });

  it('opens nothing when the view entry can’t be written', async () => {
    const { subject } = await subjectWithDocuments('Jona');
    const docs = (await getEmployeeRecordView(hr.actor, subject.employeeId))?.documents ?? [];
    await blockAudit();
    await expect(
      openAccessibleFile(currentUser(hr), fileIdOf(docs[0]?.fileUrl ?? '')),
    ).rejects.toThrow();
  });
});

describe('who changes 201 documents', () => {
  it('lets HR and the System Administrator with Talent Write add, edit and archive', async () => {
    const subject = await person('Karla', 'Diaz', NET);
    for (const actor of [hr, admin]) {
      const added = await addEmployeeDocument(actor.actor, documentInput(subject), pdfFile());
      const edited = await updateEmployeeDocument(actor.actor, {
        documentId: added.documentId,
        version: added.version,
        type: 'governmentIdCopy',
        title: 'Passport',
        issueDate: '2026-02-01',
        expiryDate: '2031-02-01',
      });
      expect(edited.version).toBe(2);
      const archived = await archiveEmployeeDocument(actor.actor, {
        documentId: added.documentId,
        version: edited.version,
        reason: 'Uploaded twice by mistake.',
      });
      expect(archived.version).toBe(3);
    }
  });

  it('lets HR manage another HR employee’s documents', async () => {
    const added = await addEmployeeDocument(hr.actor, documentInput(hrColleague), pdfFile());
    expect(added.version).toBe(1);
  });

  it('refuses everyone else, and one’s own record, and writes nothing', async () => {
    const subject = await person('Lorna', 'Velasco', NET);
    const ownHr = documentInput(hr);
    const cases: [Person, ReturnType<typeof documentInput>][] = [
      [writer, documentInput(subject)],
      [accounting, documentInput(subject)],
      [board, documentInput(subject)],
      [reader, documentInput(subject)],
      [hrColleague, documentInput(subject)],
      [hr, ownHr],
      [admin, documentInput(admin)],
    ];
    const documents = await EmployeeDocumentModel.countDocuments();
    const audit = await countAudit();
    for (const [actor, input] of cases) {
      await expect(addEmployeeDocument(actor.actor, input, pdfFile())).rejects.toBeInstanceOf(
        AccessDeniedError,
      );
    }
    expect(await EmployeeDocumentModel.countDocuments()).toBe(documents);
    expect(await countAudit()).toBe(audit);

    const added = await addEmployeeDocument(hr.actor, documentInput(subject), pdfFile());
    await expect(
      archiveEmployeeDocument(writer.actor, { ...added, reason: 'No.' }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it('re-checks the actor in the transaction', async () => {
    const subject = await person('Mila', 'Torres', NET);
    const formerHr = await person('Nora', 'Flores', HRD, { talent: 'write' });
    // The session still says HR; the stored department no longer does.
    await moveTo(formerHr, NET);
    await expect(
      addEmployeeDocument(formerHr.actor, documentInput(subject), pdfFile()),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it('checks the details: title for Other, dates', async () => {
    const subject = await person('Olga', 'Navarro', NET);
    await expect(
      addEmployeeDocument(hr.actor, documentInput(subject, { type: 'other' }), pdfFile()),
    ).rejects.toMatchObject({ field: 'title' });
    await expect(
      addEmployeeDocument(
        hr.actor,
        documentInput(subject, { issueDate: '2999-01-01', expiryDate: null }),
        pdfFile(),
      ),
    ).rejects.toMatchObject({ field: 'issueDate' });
    await expect(
      addEmployeeDocument(
        hr.actor,
        documentInput(subject, { expiryDate: '2026-01-15' }),
        pdfFile(),
      ),
    ).rejects.toMatchObject({ field: 'expiryDate' });
  });
});

describe('never deleted', () => {
  it('refuses deletes and replacements', async () => {
    const subject = await person('Pia', 'Mendoza', NET);
    const { documentId } = await addEmployeeDocument(hr.actor, documentInput(subject), pdfFile());
    const _id = new Types.ObjectId(documentId);
    await expect(EmployeeDocumentModel.deleteOne({ _id })).rejects.toThrow(/never deleted/);
    await expect(EmployeeDocumentModel.deleteMany({})).rejects.toThrow(/never deleted/);
    await expect(EmployeeDocumentModel.findOneAndDelete({ _id })).rejects.toThrow(/never deleted/);
    await expect(EmployeeDocumentModel.replaceOne({ _id }, { type: 'other' })).rejects.toThrow(
      /never deleted/,
    );
    await expect(
      EmployeeDocumentModel.updateOne({ _id }, { $unset: { expiryDate: 1 } }),
    ).rejects.toThrow(/never deleted/);
    const loaded = await EmployeeDocumentModel.findById(_id).orFail();
    await expect(loaded.deleteOne()).rejects.toThrow(/never deleted/);
    expect(await EmployeeDocumentModel.countDocuments({ _id })).toBe(1);
  });

  it('archives with a reason, keeps the document, and refuses a stale version', async () => {
    const subject = await person('Quina', 'Bautista', NET);
    const added = await addEmployeeDocument(hr.actor, documentInput(subject), pdfFile());
    await expect(
      archiveEmployeeDocument(hr.actor, { ...added, reason: '  ' }),
    ).rejects.toMatchObject({ field: 'reason' });
    await expect(
      archiveEmployeeDocument(hr.actor, { ...added, version: 7, reason: 'Wrong person.' }),
    ).rejects.toThrow(RECORD_CHANGED_ELSEWHERE);
    await archiveEmployeeDocument(hr.actor, { ...added, reason: 'Wrong person.' });
    const view = await getEmployeeRecordView(hr.actor, subject.employeeId);
    const archived = view?.documents?.find((d) => d.id === added.documentId);
    expect(archived?.archived).toBe(true);
    expect(archived?.archiveReason).toBe('Wrong person.');
    await expect(
      updateEmployeeDocument(hr.actor, {
        documentId: added.documentId,
        version: 2,
        type: 'nbiClearance',
        title: null,
        issueDate: '2026-01-15',
        expiryDate: null,
      }),
    ).rejects.toBeInstanceOf(ActionError);
  });

  it('archives the replaced document in the same save as the renewal', async () => {
    const subject = await person('Rosa', 'Aquino', NET);
    const old = await addEmployeeDocument(hr.actor, documentInput(subject), pdfFile());
    const renewal = await addEmployeeDocument(
      hr.actor,
      documentInput(subject, {
        issueDate: '2026-03-01',
        expiryDate: '2027-03-01',
        replacesDocumentId: old.documentId,
        replacesVersion: old.version,
      }),
      pdfFile('renewal.pdf'),
    );
    const stored = await EmployeeDocumentModel.findById(old.documentId).lean().orFail();
    expect(stored.archivedAt).not.toBeNull();
    expect(stored.archiveReason).toBe(REPLACED_BY_RENEWAL_REASON);
    expect(stored.version).toBe(2);
    const entries = await auditEntries(EMPLOYEE_DOCUMENT_TYPE);
    expect(
      entries.filter((e) => e.record.id.toHexString() === old.documentId).map((e) => e.action),
    ).toEqual(['create', 'update']);
    expect(
      entries.filter((e) => e.record.id.toHexString() === renewal.documentId).map((e) => e.action),
    ).toEqual(['create']);

    // A stale replace refuses the renewal too.
    const again = await addEmployeeDocument(hr.actor, documentInput(subject), pdfFile());
    const count = await EmployeeDocumentModel.countDocuments({
      employeeId: new Types.ObjectId(subject.employeeId),
    });
    await expect(
      addEmployeeDocument(
        hr.actor,
        documentInput(subject, { replacesDocumentId: again.documentId, replacesVersion: 5 }),
        pdfFile(),
      ),
    ).rejects.toThrow(RECORD_CHANGED_ELSEWHERE);
    expect(
      await EmployeeDocumentModel.countDocuments({
        employeeId: new Types.ObjectId(subject.employeeId),
      }),
    ).toBe(count);
  });
});

describe('audit', () => {
  it('writes each change’s entry, labelled with the employee number and type', async () => {
    const subject = await person('Sara', 'Castillo', NET);
    const added = await addEmployeeDocument(hr.actor, documentInput(subject), pdfFile());
    await updateEmployeeDocument(hr.actor, {
      documentId: added.documentId,
      version: 1,
      type: 'nbiClearance',
      title: null,
      issueDate: '2026-01-15',
      expiryDate: '2027-02-15',
    });
    const entries = (await auditEntries(EMPLOYEE_DOCUMENT_TYPE)).filter(
      (e) => e.record.id.toHexString() === added.documentId,
    );
    expect(entries.map((e) => e.action)).toEqual(['create', 'update']);
    for (const entry of entries) {
      expect(entry.module).toBe('talent');
      expect(entry.record.label).toBe(`${subject.employeeNumber} · NBI clearance`);
    }
  });

  it('writes nothing when the entry can’t be written', async () => {
    const subject = await person('Tess', 'Ocampo', NET);
    const added = await addEmployeeDocument(hr.actor, documentInput(subject), pdfFile());
    const documents = await EmployeeDocumentModel.countDocuments();
    await blockAudit();
    await expect(
      addEmployeeDocument(hr.actor, documentInput(subject), pdfFile()),
    ).rejects.toThrow();
    await expect(
      archiveEmployeeDocument(hr.actor, { ...added, reason: 'Duplicate.' }),
    ).rejects.toThrow();
    await database().command({ collMod: 'auditLogs', validator: {} });
    expect(await EmployeeDocumentModel.countDocuments()).toBe(documents);
    const stored = await EmployeeDocumentModel.findById(added.documentId).lean().orFail();
    expect(stored.archivedAt).toBeNull();
    expect(stored.version).toBe(1);
  });
});
