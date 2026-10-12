import { type ClientSession, Types } from 'mongoose';
import { connectDb, withTransaction } from '@pulse/db';
import { ActionError, type BusinessDate, businessToday, now } from '@pulse/core';
import {
  type EmployeeIdentity,
  getEmployeeIdentity,
  listEmployeeIdentities,
  recordAudit,
  reloadActorAccess,
  saveUpload,
  snapshotForAudit,
  snapshotsForAudit,
} from '@pulse/core/server';
import { expiryStateOf } from '../../derived';
import {
  DOCUMENT_201_TYPE_LABELS,
  type Document201Category,
  type Document201Type,
  documentCategoryOf,
} from '../../fixed-sets';
import {
  DOCUMENT_ARCHIVED,
  DOCUMENT_GONE,
  DOCUMENTS_NOTICE,
  employeeDocumentAddSchema,
  type EmployeeDocumentAddInput,
  employeeDocumentArchiveSchema,
  type EmployeeDocumentArchiveInput,
  employeeDocumentUpdateSchema,
  type EmployeeDocumentUpdateInput,
  MEDICAL_DOCUMENTS_NOTICE,
  RECORD_CHANGED_ELSEWHERE,
  REPLACED_DOCUMENT_ARCHIVED,
  REPLACED_DOCUMENT_GONE,
} from '../../validation';
import { EMPLOYEE_DOCUMENT_TYPE, type EmployeeDocumentView } from '../../views';
import { expiryLeadDaysOn } from '../expiry-alerts/settings';
import { inputError } from '../input';
import {
  assertCanManageDocuments,
  canReadEmployeeRecords,
  canSeeDocumentCategory,
  type RecordTarget,
  type TalentActor,
} from '../policy';
import {
  dayOf,
  dayOrNull,
  EMPLOYEE_GONE,
  fileUrlOf,
  instantOf,
  instantOrNull,
  objectIdOf,
  targetOf,
} from '../shared';
import { type EmployeeDocumentRecord, EmployeeDocumentModel } from './model';

// Spec: docs/modules/talent.md#documents-photo-e-signature-and-certifications-build-step-22,
// SECURITY.md#sensitive-data ("201 documents, the photo and the e-signature") and
// docs/DATA_MODEL.md#collection-ownership (decisions 178–181 in docs/BUILD_PLAN.md) — the 201 file.
//
// - Who sees them: others' documents, and even their list, only for a viewer with Talent Read who
//   may reveal that category for that employee (`file201`, or `medical` for a medical
//   certificate, which Accounting doesn't get). The employee always sees their own.
// - Who changes them: Talent Write and HR or the System Administrator, never on one's own record.
// - Never deleted: archiving is an update with a reason; the file never changes; the details can
//   be edited with the `version` check. A renewal is a new document, which can archive the one it
//   replaces in the same transaction.
// - Every write re-loads the actor and the employee in its transaction, re-checks the rules and
//   writes its audit entry there (`create` or `update` on `talent.employeeDocument`, labelled
//   `<employee number> · <type label>`), so the change and its entry commit or abort together.
// - Opening a file is audit-logged by the file route (registrations.ts).

const ISSUE_DATE_IN_FUTURE = 'The issue date can’t be in the future.';
/** The archive reason of a document a renewal replaced. */
export const REPLACED_BY_RENEWAL_REASON = 'Replaced by a renewed document.';

/** The audit label of a 201 document: `<employee number> · <type label>`. */
export function documentLabel(employeeNumber: string, type: Document201Type): string {
  return `${employeeNumber} · ${DOCUMENT_201_TYPE_LABELS[type]}`;
}

function assertIssueDateNotInFuture(issueDate: BusinessDate): void {
  if (issueDate > businessToday()) {
    throw new ActionError(ISSUE_DATE_IN_FUTURE, { field: 'issueDate' });
  }
}

/** The employee for a pre-check, before the file is saved (Talent Read reads it). */
async function preCheckEmployee(actor: TalentActor, employeeId: string): Promise<EmployeeIdentity> {
  assertCanManageDocuments(actor, { employeeId, departmentCode: null });
  const identity = await getEmployeeIdentity(actor, employeeId, { separated: true });
  if (!identity) throw new ActionError(EMPLOYEE_GONE);
  assertCanManageDocuments(actor, targetOf(identity));
  return identity;
}

/** The actor and employee as they are now, in the transaction, re-checked. */
async function recheck(
  actor: TalentActor,
  employeeId: string,
  session: ClientSession,
): Promise<{ current: Awaited<ReturnType<typeof reloadActorAccess>>; identity: EmployeeIdentity }> {
  const current = await reloadActorAccess({ id: actor.id }, session);
  const identity = await getEmployeeIdentity(current, employeeId, { separated: true, session });
  if (!identity) throw new ActionError(EMPLOYEE_GONE);
  assertCanManageDocuments(current, targetOf(identity));
  return { current, identity };
}

async function auditUpdate(
  actor: { id: string; email: string },
  before: EmployeeDocumentRecord,
  after: EmployeeDocumentRecord,
  employeeNumber: string,
  session: ClientSession,
): Promise<void> {
  await recordAudit(
    {
      actorId: actor.id,
      actorEmail: actor.email,
      module: 'talent',
      action: 'update',
      record: {
        type: EMPLOYEE_DOCUMENT_TYPE,
        id: before._id,
        label: documentLabel(employeeNumber, after.type),
      },
      ...snapshotsForAudit(EmployeeDocumentModel, before, after),
    },
    { session },
  );
}

/**
 * Adds a 201 document from an uploaded file (form field `file`, stored byte for byte): Talent
 * Write and HR or the System Administrator, never on one's own record. With `replacesDocumentId`
 * (and its `replacesVersion`), the document this renewal replaces is archived in the same
 * transaction. One `create` entry, plus an `update` entry for the archived one.
 *
 * The file is saved before the transaction (a side effect); if the transaction then fails, the
 * saved file is left unused and never opens (no document points at it).
 */
export async function addEmployeeDocument(
  actor: TalentActor,
  input: EmployeeDocumentAddInput,
  file: File,
): Promise<{ documentId: string; version: number }> {
  const parsed = employeeDocumentAddSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const values = parsed.data;
  await connectDb();
  await preCheckEmployee(actor, values.employeeId);
  assertIssueDateNotInFuture(values.issueDate);
  const replacesId = values.replacesDocumentId ? objectIdOf(values.replacesDocumentId) : null;

  const documentId = new Types.ObjectId();
  const stored = await saveUpload({
    file,
    owner: { type: EMPLOYEE_DOCUMENT_TYPE, id: documentId },
    actorId: objectIdOf(actor.id),
    field: 'file',
  });
  const fileId = objectIdOf(stored.id);
  if (!fileId) throw new Error('The stored document has no valid id.');

  await withTransaction(async (session) => {
    const { current, identity } = await recheck(actor, values.employeeId, session);
    const employeeId = new Types.ObjectId(identity.employeeId);
    const actorId = new Types.ObjectId(current.id);

    if (replacesId) {
      const replaced = await EmployeeDocumentModel.findOne({ _id: replacesId, employeeId })
        .session(session)
        .lean<EmployeeDocumentRecord>();
      if (!replaced) throw new ActionError(REPLACED_DOCUMENT_GONE);
      if (replaced.archivedAt) throw new ActionError(REPLACED_DOCUMENT_ARCHIVED);
      if (replaced.version !== values.replacesVersion) {
        throw new ActionError(RECORD_CHANGED_ELSEWHERE);
      }
      const archived = await EmployeeDocumentModel.findOneAndUpdate(
        { _id: replaced._id, version: replaced.version, archivedAt: null },
        {
          $set: {
            archivedAt: now(),
            archivedBy: actorId,
            archiveReason: REPLACED_BY_RENEWAL_REASON,
            updatedBy: actorId,
          },
          $inc: { version: 1 },
        },
        { session, returnDocument: 'after', runValidators: true },
      ).lean<EmployeeDocumentRecord>();
      if (!archived) throw new ActionError(RECORD_CHANGED_ELSEWHERE);
      await auditUpdate(current, replaced, archived, identity.employeeNumber, session);
    }

    const document = new EmployeeDocumentModel({
      _id: documentId,
      employeeId,
      fileId,
      type: values.type,
      title: values.title,
      issueDate: instantOf(values.issueDate),
      expiryDate: instantOrNull(values.expiryDate),
      version: 1,
      createdBy: actorId,
      updatedBy: actorId,
    });
    await document.save({ session });
    await recordAudit(
      {
        actorId: current.id,
        actorEmail: current.email,
        module: 'talent',
        action: 'create',
        record: {
          type: EMPLOYEE_DOCUMENT_TYPE,
          id: documentId,
          label: documentLabel(identity.employeeNumber, values.type),
        },
        before: null,
        after: snapshotForAudit(EmployeeDocumentModel, document),
      },
      { session },
    );
  });
  return { documentId: documentId.toHexString(), version: 1 };
}

/** The document and its employee for an edit or archive, before the transaction. */
async function loadForChange(
  actor: TalentActor,
  documentId: string,
): Promise<EmployeeDocumentRecord> {
  const id = objectIdOf(documentId);
  if (!id) throw new ActionError(DOCUMENT_GONE);
  await connectDb();
  const document = await EmployeeDocumentModel.findById(id).lean<EmployeeDocumentRecord>();
  // Someone who may not manage this employee's documents learns nothing about the document.
  if (!document) throw new ActionError(DOCUMENT_GONE);
  await preCheckEmployee(actor, document.employeeId.toHexString());
  return document;
}

/** Changes a document in a transaction that re-checks everything, with its `update` entry. */
async function changeDocument(
  actor: TalentActor,
  document: EmployeeDocumentRecord,
  version: number,
  set: (actorId: Types.ObjectId) => Record<string, unknown>,
): Promise<{ version: number }> {
  return withTransaction(async (session) => {
    const { current, identity } = await recheck(actor, document.employeeId.toHexString(), session);
    const before = await EmployeeDocumentModel.findById(document._id)
      .session(session)
      .lean<EmployeeDocumentRecord>();
    if (!before || !before.employeeId.equals(document.employeeId)) {
      throw new ActionError(DOCUMENT_GONE);
    }
    if (before.archivedAt) throw new ActionError(DOCUMENT_ARCHIVED);
    if (before.version !== version) throw new ActionError(RECORD_CHANGED_ELSEWHERE);
    const actorId = new Types.ObjectId(current.id);
    const after = await EmployeeDocumentModel.findOneAndUpdate(
      { _id: before._id, version: before.version, archivedAt: null },
      { $set: { ...set(actorId), updatedBy: actorId }, $inc: { version: 1 } },
      { session, returnDocument: 'after', runValidators: true },
    ).lean<EmployeeDocumentRecord>();
    if (!after) throw new ActionError(RECORD_CHANGED_ELSEWHERE);
    await auditUpdate(current, before, after, identity.employeeNumber, session);
    return { version: after.version };
  });
}

/**
 * Edits a document's details (type, title, dates), never its file or employee: the same rule as
 * {@link addEmployeeDocument}, with the `version` check. An archived document can't be edited.
 */
export async function updateEmployeeDocument(
  actor: TalentActor,
  input: EmployeeDocumentUpdateInput,
): Promise<{ version: number }> {
  const parsed = employeeDocumentUpdateSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const values = parsed.data;
  const document = await loadForChange(actor, values.documentId);
  assertIssueDateNotInFuture(values.issueDate);
  return changeDocument(actor, document, values.version, () => ({
    type: values.type,
    title: values.title,
    issueDate: instantOf(values.issueDate),
    expiryDate: instantOrNull(values.expiryDate),
  }));
}

/**
 * Archives a document with a reason (it moves under "Show archived" and gets no more expiry
 * alerts): the same rule as {@link addEmployeeDocument}, with the `version` check. Never a delete.
 */
export async function archiveEmployeeDocument(
  actor: TalentActor,
  input: EmployeeDocumentArchiveInput,
): Promise<{ version: number }> {
  const parsed = employeeDocumentArchiveSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const values = parsed.data;
  const document = await loadForChange(actor, values.documentId);
  return changeDocument(actor, document, values.version, (actorId) => ({
    archivedAt: now(),
    archivedBy: actorId,
    archiveReason: values.reason,
  }));
}

// ---------------------------------------------------------------------------------------------
// Reads

/** The 201 file section of a record, as `viewer` may see it (see the header). */
export interface DocumentsSection {
  /** Absent when the viewer may see no category. */
  documents?: EmployeeDocumentView[];
  /** `DOCUMENTS_NOTICE` or `MEDICAL_DOCUMENTS_NOTICE` when something is left out. */
  notice?: string;
}

/** The names of the users who uploaded, for a viewer with Talent Read (else none). */
async function uploaderNames(
  viewer: TalentActor,
  userIds: Types.ObjectId[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (userIds.length === 0 || !canReadEmployeeRecords(viewer)) return names;
  const wanted = new Set(userIds.map((id) => id.toHexString()));
  for (const identity of await listEmployeeIdentities(viewer, { separated: true })) {
    if (identity.userId && wanted.has(identity.userId)) {
      names.set(identity.userId, `${identity.firstName} ${identity.lastName}`);
    }
  }
  return names;
}

/**
 * Builds the 201 file section for `viewer` on `target`'s record. A category the viewer may not see
 * is never queried, so nothing of it (not even a count) leaves the server.
 */
export async function buildDocumentsSection(
  viewer: TalentActor,
  target: RecordTarget,
  today: BusinessDate = businessToday(),
): Promise<DocumentsSection> {
  const categories = (['file201', 'medical'] as const).filter((category) =>
    canSeeDocumentCategory(viewer, category, target),
  );
  if (categories.length === 0) return { notice: DOCUMENTS_NOTICE };
  const seesMedical = categories.includes('medical');
  const filter: Record<string, unknown> = { employeeId: new Types.ObjectId(target.employeeId) };
  if (!seesMedical) filter.type = { $ne: 'medicalCertificate' };
  else if (!categories.includes('file201')) filter.type = 'medicalCertificate';

  const [records, { documentLeadDays }] = await Promise.all([
    EmployeeDocumentModel.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .lean<EmployeeDocumentRecord[]>(),
    expiryLeadDaysOn(today),
  ]);
  const names = await uploaderNames(
    viewer,
    records.flatMap((record) => (record.createdBy ? [record.createdBy] : [])),
  );
  const documents = records.map((record): EmployeeDocumentView => {
    const expiryDate = dayOrNull(record.expiryDate);
    const category: Document201Category = documentCategoryOf(record.type);
    return {
      id: record._id.toHexString(),
      type: record.type,
      typeLabel: DOCUMENT_201_TYPE_LABELS[record.type],
      category,
      title: record.title ?? null,
      issueDate: dayOf(record.issueDate),
      expiryDate,
      expiry: expiryStateOf(expiryDate, today, documentLeadDays),
      fileUrl: fileUrlOf(record.fileId),
      uploadedAt: record.createdAt,
      uploadedByName: record.createdBy ? (names.get(record.createdBy.toHexString()) ?? null) : null,
      archived: record.archivedAt !== null,
      archivedAt: record.archivedAt ?? null,
      archiveReason: record.archiveReason ?? null,
      version: record.version,
    };
  });
  return seesMedical ? { documents } : { documents, notice: MEDICAL_DOCUMENTS_NOTICE };
}

/**
 * One employee's 201 file for `actor`: their own, or with Talent Read and the reveal rule for each
 * category (see the header). Null when there is no such employee for this viewer.
 */
export async function listEmployeeDocuments(
  actor: TalentActor,
  employeeId: string,
): Promise<DocumentsSection | null> {
  await connectDb();
  const identity = await getEmployeeIdentity(actor, employeeId, { separated: true });
  if (!identity) return null;
  return buildDocumentsSection(actor, targetOf(identity));
}
