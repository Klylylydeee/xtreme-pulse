import { type ClientSession, Types } from 'mongoose';
import { connectDb, withTransaction } from '@pulse/db';
import type { z } from 'zod';
import { AccessDeniedError, ActionError, type BusinessDate, businessToday, now } from '@pulse/core';
import {
  type EmployeeIdentity,
  getEmployeeIdentity,
  listBrandOptions,
  listDirectory,
  recordAudit,
  type ReloadedActor,
  reloadActorAccess,
  saveUpload,
  snapshotForAudit,
  snapshotsForAudit,
} from '@pulse/core/server';
import { expiryStateOf } from '../../derived';
import type { CertificationStatus } from '../../fixed-sets';
import {
  CERTIFICATION_GONE,
  certificationCreateSchema,
  type CertificationCreateInput,
  certificationRemoveSchema,
  type CertificationRemoveInput,
  certificationUpdateSchema,
  type CertificationUpdateInput,
  RECORD_CHANGED_ELSEWHERE,
} from '../../validation';
import {
  CERTIFICATION_TYPE,
  type CertificationReadRow,
  type CertificationView,
  type CertifiedEmployeeCount,
} from '../../views';
import { creatorNames } from '../documents/service';
import { EmployeeRecordModel } from '../employee-records/model';
import { expiryLeadDaysOn } from '../expiry-alerts/settings';
import { inputError } from '../input';
import {
  assertCanEditCertifications,
  assertCanReadCertifications,
  assertCanRemoveCertifications,
  canOpenCertificationAttachment,
  type RecordTarget,
  type TalentActor,
} from '../policy';
import {
  auditLabelOf,
  dayOf,
  dayOrNull,
  EMPLOYEE_GONE,
  fileUrlOf,
  instantOf,
  instantOrNull,
  objectIdOf,
  sentFile,
  targetOf,
} from '../shared';
import { type CertificationRecord, CertificationModel } from './model';

// Spec: docs/modules/talent.md#skills--certifications and
// #documents-photo-e-signature-and-certifications-build-step-22, docs/DATA_MODEL.md and
// docs/ARCHITECTURE.md#cross-module-integration (decisions 182 and 184 in docs/BUILD_PLAN.md).
//
// - Adding and editing need Talent Write, never on one's own record. Removing is a soft delete and
//   needs Talent Owner (also never on one's own record). Each write re-loads the actor and the
//   employee in its transaction, re-checks, and writes its audit entry there (`create`, `update` or
//   `delete` on `talent.certification`, labelled `<employee number> · <name>`).
// - The optional attachment (form field `attachment`) is stored byte for byte and opens for the
//   employee, Talent Read and the System Administrator, unlogged (registrations.ts).
// - The read services for Pulse Ops and Pulse Engage (`listCertifications`,
//   `countCertifiedEmployeesByBrand`): Talent, Engage or Ops Read, or the System Administrator.
//   Separated employees are left out. Each row is an allowlist built field by field: never the
//   license number or the attachment.

const PRODUCT_GONE = 'Choose a product from the list.';

/** The audit label of a certification: `<employee number> · <name>`. */
function certificationLabel(employeeNumber: string, name: string): string {
  return auditLabelOf(employeeNumber, name);
}

/** Refuses a product that isn't live, unless it is the one already stored. */
async function assertLiveProduct(
  brandId: string | null,
  stored: Types.ObjectId | null = null,
): Promise<void> {
  if (!brandId || (stored && stored.toHexString() === brandId)) return;
  const live = await listBrandOptions();
  if (!live.some((brand) => brand.id === brandId)) {
    throw new ActionError(PRODUCT_GONE, { field: 'brandId' });
  }
}

/** The employee for a pre-check, before a file is saved (Talent Read reads it). */
async function preCheckEmployee(
  actor: TalentActor,
  employeeId: string,
  check: (who: TalentActor, target: RecordTarget) => void,
): Promise<EmployeeIdentity> {
  check(actor, { employeeId, departmentCode: null });
  const identity = await getEmployeeIdentity(actor, employeeId, { separated: true });
  if (!identity) throw new ActionError(EMPLOYEE_GONE);
  check(actor, targetOf(identity));
  return identity;
}

/** The actor and employee as they are now, in the transaction, re-checked. */
async function recheck(
  actor: TalentActor,
  employeeId: string,
  check: (who: TalentActor, target: RecordTarget) => void,
  session: ClientSession,
): Promise<{ current: ReloadedActor; identity: EmployeeIdentity }> {
  const current = await reloadActorAccess({ id: actor.id }, session);
  const identity = await getEmployeeIdentity(current, employeeId, { separated: true, session });
  if (!identity) throw new ActionError(EMPLOYEE_GONE);
  check(current, targetOf(identity));
  return { current, identity };
}

async function saveAttachment(
  actor: TalentActor,
  certificationId: Types.ObjectId,
  file: File,
): Promise<Types.ObjectId> {
  const stored = await saveUpload({
    file,
    owner: { type: CERTIFICATION_TYPE, id: certificationId },
    actorId: objectIdOf(actor.id),
    field: 'attachment',
  });
  const fileId = objectIdOf(stored.id);
  if (!fileId) throw new Error('The stored attachment has no valid id.');
  return fileId;
}

/**
 * Adds a certification to an employee's record, with an optional attachment (form field
 * `attachment`): Talent Write, never on one's own record. One `create` entry.
 */
export async function createCertification(
  actor: TalentActor,
  input: CertificationCreateInput,
  attachment?: File | null,
): Promise<{ certificationId: string; version: number }> {
  const parsed = certificationCreateSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const values = parsed.data;
  await connectDb();
  await preCheckEmployee(actor, values.employeeId, assertCanEditCertifications);
  await assertLiveProduct(values.brandId);

  const certificationId = new Types.ObjectId();
  const file = sentFile(attachment);
  const attachmentFileId = file ? await saveAttachment(actor, certificationId, file) : null;

  await withTransaction(async (session) => {
    const { current, identity } = await recheck(
      actor,
      values.employeeId,
      assertCanEditCertifications,
      session,
    );
    const actorId = new Types.ObjectId(current.id);
    const certification = new CertificationModel({
      _id: certificationId,
      employeeId: new Types.ObjectId(identity.employeeId),
      name: values.name,
      issuer: values.issuer,
      brandId: objectIdOf(values.brandId),
      licenseNumber: values.licenseNumber,
      issueDate: instantOf(values.issueDate),
      expiryDate: instantOrNull(values.expiryDate),
      attachmentFileId,
      version: 1,
      createdBy: actorId,
      updatedBy: actorId,
    });
    await certification.save({ session });
    await recordAudit(
      {
        actorId: current.id,
        actorEmail: current.email,
        module: 'talent',
        action: 'create',
        record: {
          type: CERTIFICATION_TYPE,
          id: certificationId,
          label: certificationLabel(identity.employeeNumber, values.name),
        },
        before: null,
        after: snapshotForAudit(CertificationModel, certification),
      },
      { session },
    );
  });
  return { certificationId: certificationId.toHexString(), version: 1 };
}

async function loadCertification(certificationId: string): Promise<CertificationRecord> {
  const id = objectIdOf(certificationId);
  if (!id) throw new ActionError(CERTIFICATION_GONE);
  await connectDb();
  const certification = await CertificationModel.findById(id).lean<CertificationRecord>();
  if (!certification) throw new ActionError(CERTIFICATION_GONE);
  return certification;
}

/**
 * Edits a certification, with the `version` check: Talent Write, never on one's own record. A new
 * attachment (form field `attachment`) replaces the old one; `removeAttachment` clears it. The old
 * file is kept but no longer opens. One `update` entry.
 */
export async function updateCertification(
  actor: TalentActor,
  input: CertificationUpdateInput,
  attachment?: File | null,
): Promise<{ version: number }> {
  const parsed = certificationUpdateSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const values = parsed.data;
  const stored = await loadCertification(values.certificationId);
  const employeeId = stored.employeeId.toHexString();
  await preCheckEmployee(actor, employeeId, assertCanEditCertifications);
  await assertLiveProduct(values.brandId, stored.brandId);

  const file = sentFile(attachment);
  const newFileId = file ? await saveAttachment(actor, stored._id, file) : null;

  return withTransaction(async (session) => {
    const { current, identity } = await recheck(
      actor,
      employeeId,
      assertCanEditCertifications,
      session,
    );
    const before = await CertificationModel.findById(stored._id)
      .session(session)
      .lean<CertificationRecord>();
    if (!before || !before.employeeId.equals(stored.employeeId)) {
      throw new ActionError(CERTIFICATION_GONE);
    }
    if (before.version !== values.version) throw new ActionError(RECORD_CHANGED_ELSEWHERE);
    const actorId = new Types.ObjectId(current.id);
    const set: Record<string, unknown> = {
      name: values.name,
      issuer: values.issuer,
      brandId: objectIdOf(values.brandId),
      licenseNumber: values.licenseNumber,
      issueDate: instantOf(values.issueDate),
      expiryDate: instantOrNull(values.expiryDate),
      updatedBy: actorId,
    };
    if (newFileId) set.attachmentFileId = newFileId;
    else if (values.removeAttachment) set.attachmentFileId = null;
    const after = await CertificationModel.findOneAndUpdate(
      { _id: before._id, version: before.version },
      { $set: set, $inc: { version: 1 } },
      { session, returnDocument: 'after', runValidators: true },
    ).lean<CertificationRecord>();
    if (!after) throw new ActionError(RECORD_CHANGED_ELSEWHERE);
    await recordAudit(
      {
        actorId: current.id,
        actorEmail: current.email,
        module: 'talent',
        action: 'update',
        record: {
          type: CERTIFICATION_TYPE,
          id: before._id,
          label: certificationLabel(identity.employeeNumber, after.name),
        },
        ...snapshotsForAudit(CertificationModel, before, after),
      },
      { session },
    );
    return { version: after.version };
  });
}

/**
 * Removes a certification (a soft delete), with the `version` check: Talent Owner, never on one's
 * own record. It leaves the record, the read services and the expiry alerts. One `delete` entry.
 */
export async function removeCertification(
  actor: TalentActor,
  input: CertificationRemoveInput,
): Promise<void> {
  const parsed = certificationRemoveSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const values = parsed.data;
  const stored = await loadCertification(values.certificationId);
  const employeeId = stored.employeeId.toHexString();
  await preCheckEmployee(actor, employeeId, assertCanRemoveCertifications);

  await withTransaction(async (session) => {
    const { current, identity } = await recheck(
      actor,
      employeeId,
      assertCanRemoveCertifications,
      session,
    );
    const before = await CertificationModel.findById(stored._id)
      .session(session)
      .lean<CertificationRecord>();
    if (!before) throw new ActionError(CERTIFICATION_GONE);
    if (before.version !== values.version) throw new ActionError(RECORD_CHANGED_ELSEWHERE);
    const removed = await CertificationModel.findOneAndUpdate(
      { _id: before._id, version: before.version },
      {
        $set: { deletedAt: now(), updatedBy: new Types.ObjectId(current.id) },
        $inc: { version: 1 },
      },
      { session, returnDocument: 'after', runValidators: true },
    ).lean<CertificationRecord>();
    if (!removed) throw new ActionError(RECORD_CHANGED_ELSEWHERE);
    await recordAudit(
      {
        actorId: current.id,
        actorEmail: current.email,
        module: 'talent',
        action: 'delete',
        record: {
          type: CERTIFICATION_TYPE,
          id: before._id,
          label: certificationLabel(identity.employeeNumber, before.name),
        },
        before: snapshotForAudit(CertificationModel, before),
        after: null,
      },
      { session },
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Reads

/** Product names by id (live products only; a retired one has no name). */
async function productNames(): Promise<Map<string, string>> {
  return new Map((await listBrandOptions()).map((brand) => [brand.id, brand.name]));
}

function productOf(
  brandId: Types.ObjectId | null,
  names: Map<string, string>,
): { id: string; name: string | null } | null {
  if (!brandId) return null;
  const id = brandId.toHexString();
  return { id, name: names.get(id) ?? null };
}

/**
 * The certifications on one employee's record (removed ones left out), latest issue date first,
 * for a viewer of that record. The attachment link only for the employee, Talent Read and the
 * System Administrator.
 */
export async function buildCertificationsSection(
  viewer: TalentActor,
  employeeId: string,
  today: BusinessDate = businessToday(),
): Promise<CertificationView[]> {
  const id = objectIdOf(employeeId);
  if (!id) return [];
  const [records, names, { certificationLeadDays }] = await Promise.all([
    CertificationModel.find({ employeeId: id })
      .sort({ issueDate: -1, _id: -1 })
      .lean<CertificationRecord[]>(),
    productNames(),
    expiryLeadDaysOn(today),
  ]);
  const showAttachment = canOpenCertificationAttachment(viewer, employeeId);
  const creators = await creatorNames(
    viewer,
    employeeId,
    records.flatMap((record) => (record.createdBy ? [record.createdBy] : [])),
  );
  return records.map((record) => {
    const expiryDate = dayOrNull(record.expiryDate);
    return {
      id: record._id.toHexString(),
      name: record.name,
      issuer: record.issuer,
      product: productOf(record.brandId, names),
      licenseNumber: record.licenseNumber ?? null,
      issueDate: dayOf(record.issueDate),
      expiryDate,
      expiry: expiryStateOf(expiryDate, today, certificationLeadDays),
      attachmentUrl:
        showAttachment && record.attachmentFileId ? fileUrlOf(record.attachmentFileId) : null,
      addedByName: record.createdBy ? (creators.get(record.createdBy.toHexString()) ?? null) : null,
      version: record.version,
    };
  });
}

/** The read services' status: current, expiring or expired on `on`. */
function statusOf(
  expiryDate: BusinessDate | null,
  on: BusinessDate,
  leadDays: number,
): CertificationStatus {
  const state = expiryStateOf(expiryDate, on, leadDays);
  if (state.status === 'expired') return 'expired';
  return state.status === 'expiring' ? 'expiring' : 'current';
}

/** The employees who aren't separated, from the directory (directory fields only). */
async function activePeople(
  actor: TalentActor,
): Promise<Map<string, { employeeNumber: string; name: string }>> {
  const people = await listDirectory(actor);
  return new Map(
    people.map((person) => [
      person.id,
      { employeeNumber: person.employeeNumber, name: person.name },
    ]),
  );
}

function idsOf(values: readonly string[] | null | undefined): Types.ObjectId[] | null {
  if (!values) return null;
  return values.flatMap((value) => {
    const id = objectIdOf(value);
    return id ? [id] : [];
  });
}

export interface ListCertificationsOptions {
  /** Only these employees. */
  employeeIds?: readonly string[] | null;
  /** Only certifications for these Core products. */
  brandIds?: readonly string[] | null;
  /** Include certifications that have expired (left out by default). */
  includeExpired?: boolean;
  /** The day the statuses are for; today in Manila by default. */
  on?: BusinessDate;
}

/**
 * Certifications for Pulse Ops and Pulse Engage: Talent, Engage or Ops Read, or the System
 * Administrator. Removed certifications and separated employees are left out, and expired ones
 * unless `includeExpired`. Each row is an allowlist (never the license number or the attachment).
 * Sorted by employee name, then latest issue date.
 */
export async function listCertifications(
  actor: TalentActor,
  {
    employeeIds,
    brandIds,
    includeExpired = false,
    on = businessToday(),
  }: ListCertificationsOptions = {},
): Promise<CertificationReadRow[]> {
  assertCanReadCertifications(actor);
  await connectDb();
  const filter: Record<string, unknown> = {};
  const employees = idsOf(employeeIds);
  const brands = idsOf(brandIds);
  if (employees) filter.employeeId = { $in: employees };
  if (brands) filter.brandId = { $in: brands };
  if (!includeExpired) {
    filter.$or = [{ expiryDate: null }, { expiryDate: { $gt: instantOf(on) } }];
  }
  const [records, people, names, { certificationLeadDays }] = await Promise.all([
    CertificationModel.find(filter, {
      employeeId: 1,
      name: 1,
      issuer: 1,
      brandId: 1,
      issueDate: 1,
      expiryDate: 1,
    })
      .sort({ issueDate: -1, _id: -1 })
      .lean<
        Pick<
          CertificationRecord,
          '_id' | 'employeeId' | 'name' | 'issuer' | 'brandId' | 'issueDate' | 'expiryDate'
        >[]
      >(),
    activePeople(actor),
    productNames(),
    expiryLeadDaysOn(on),
  ]);
  const kept = records.filter((record) => people.has(record.employeeId.toHexString()));
  const skillRecords = await EmployeeRecordModel.find(
    {
      employeeId: {
        $in: [...new Set(kept.map((record) => record.employeeId.toHexString()))].map(
          (id) => new Types.ObjectId(id),
        ),
      },
    },
    { employeeId: 1, skills: 1 },
  ).lean();
  const skillsOf = new Map(
    skillRecords.map((record) => [record.employeeId.toHexString(), [...(record.skills ?? [])]]),
  );

  const rows = kept.map((record): CertificationReadRow => {
    const employeeId = record.employeeId.toHexString();
    const person = people.get(employeeId) as { employeeNumber: string; name: string };
    const expiryDate = dayOrNull(record.expiryDate);
    return {
      certificationId: record._id.toHexString(),
      employee: { employeeId, employeeNumber: person.employeeNumber, name: person.name },
      name: record.name,
      issuer: record.issuer,
      product: productOf(record.brandId ?? null, names),
      issueDate: dayOf(record.issueDate),
      expiryDate,
      status: statusOf(expiryDate, on, certificationLeadDays),
      skills: [...(skillsOf.get(employeeId) ?? [])],
    };
  });
  return rows.sort(
    (a, b) =>
      a.employee.name.localeCompare(b.employee.name, 'en') ||
      b.issueDate.localeCompare(a.issueDate),
  );
}

/**
 * How many employees (not separated) hold a certification for each product that is current on
 * `on` (not expired; an expiring one still counts), for Pulse Engage's partner requirements: the
 * same access as {@link listCertifications}. One row per requested product, in the order given.
 */
export async function countCertifiedEmployeesByBrand(
  actor: TalentActor,
  brandIds: readonly string[],
  on: BusinessDate = businessToday(),
): Promise<CertifiedEmployeeCount[]> {
  assertCanReadCertifications(actor);
  const rows = await listCertifications(actor, { brandIds, includeExpired: false, on });
  const holders = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.product) continue;
    const set = holders.get(row.product.id) ?? new Set<string>();
    set.add(row.employee.employeeId);
    holders.set(row.product.id, set);
  }
  const seen = new Set<string>();
  const counts: CertifiedEmployeeCount[] = [];
  for (const brandId of brandIds) {
    const id = objectIdOf(brandId)?.toHexString();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    counts.push({ brandId: id, count: holders.get(id)?.size ?? 0 });
  }
  return counts;
}

// ---------------------------------------------------------------------------------------------
// Step 2.6: the employee adds their own certifications (docs/modules/talent.md#onboarding-
// checklist-and-change-requests-build-step-26; decision 268 in docs/BUILD_PLAN.md). Self-service:
// no module access, no employee id taken. Editing needs Talent Write and removing Talent Owner,
// never on one's own record, as before.

const NO_EMPLOYEE_CERTIFICATIONS =
  'The system account has no employee record, so it has no certifications.';

/** What the own "Add certification" sheet sends: step 2.2's fields without the employee. */
export type OwnCertificationInput = Omit<z.input<typeof certificationCreateSchema>, 'employeeId'>;

/**
 * Adds a certification to the signed-in user's own record, with an optional attachment (form field
 * `attachment`) and step 2.2's checks. Takes no employee id. One `create` entry; it shows "Added by
 * <name>".
 */
export async function addOwnCertification(
  actor: TalentActor,
  input: OwnCertificationInput,
  attachment?: File | null,
): Promise<{ certificationId: string; version: number }> {
  if (!actor.employee) throw new AccessDeniedError(NO_EMPLOYEE_CERTIFICATIONS);
  const ownEmployeeId = actor.employee.id;
  const parsed = certificationCreateSchema.safeParse({ ...input, employeeId: ownEmployeeId });
  if (!parsed.success) throw inputError(parsed.error.issues);
  const values = parsed.data;
  await connectDb();
  await assertLiveProduct(values.brandId);

  const certificationId = new Types.ObjectId();
  const file = sentFile(attachment);
  const attachmentFileId = file ? await saveAttachment(actor, certificationId, file) : null;

  await withTransaction(async (session) => {
    const current = await reloadActorAccess({ id: actor.id }, session);
    if (!current.employee || current.employee.id !== ownEmployeeId) {
      throw new AccessDeniedError(NO_EMPLOYEE_CERTIFICATIONS);
    }
    const identity = await getEmployeeIdentity(current, ownEmployeeId, { session });
    if (!identity) throw new ActionError(EMPLOYEE_GONE);
    const actorId = new Types.ObjectId(current.id);
    const certification = new CertificationModel({
      _id: certificationId,
      employeeId: new Types.ObjectId(identity.employeeId),
      name: values.name,
      issuer: values.issuer,
      brandId: objectIdOf(values.brandId),
      licenseNumber: values.licenseNumber,
      issueDate: instantOf(values.issueDate),
      expiryDate: instantOrNull(values.expiryDate),
      attachmentFileId,
      version: 1,
      createdBy: actorId,
      updatedBy: actorId,
    });
    await certification.save({ session });
    await recordAudit(
      {
        actorId: current.id,
        actorEmail: current.email,
        module: 'talent',
        action: 'create',
        record: {
          type: CERTIFICATION_TYPE,
          id: certificationId,
          label: certificationLabel(identity.employeeNumber, values.name),
        },
        before: null,
        after: snapshotForAudit(CertificationModel, certification),
      },
      { session },
    );
  });
  return { certificationId: certificationId.toHexString(), version: 1 };
}
