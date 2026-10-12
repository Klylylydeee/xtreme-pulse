import { type ClientSession, Types } from 'mongoose';
import { connectDb, withTransaction } from '@pulse/db';
import {
  ActionError,
  businessToday,
  type EmploymentStatus,
  EMPLOYMENT_STATUS,
  EMPLOYMENT_STATUSES,
  initialsOf,
  startOfBusinessDate,
  toBusinessDate,
} from '@pulse/core';
import {
  canChangeEmployeePhoto,
  type EmployeeIdentity,
  encryptSensitive,
  getEmployeeIdentity,
  listEmployeeIdentities,
  recordAudit,
  reloadActorAccess,
  sensitiveLastFour,
  snapshotForAudit,
  snapshotsForAudit,
} from '@pulse/core/server';
import { isContractEndDateMissing, probationEndDate } from '../../derived';
import { DEFAULT_WORK_REGION } from '../../fixed-sets';
import {
  BANK_ACCOUNT_NUMBER_FIELD,
  EMPLOYEE_RECORD_TYPE,
  type EmployeeList,
  type EmployeeListRow,
  type EmployeeRecordView,
  type GovernmentIdField,
  type MaskedDigitsView,
  type PersonalSectionView,
} from '../../views';
import {
  type BankAccountSectionInput,
  bankAccountSectionSchema,
  type EmploymentSectionInput,
  employmentSectionSchema,
  type GovernmentIdsSectionInput,
  governmentIdsSectionSchema,
  type PersonalSectionInput,
  personalSectionSchema,
  RECORD_CHANGED_ELSEWHERE,
  RESTRICTED_SECTIONS_NOTICE,
  type SkillsSectionInput,
  skillsSectionSchema,
} from '../../validation';
import { buildAllowancesSection } from '../allowances/service';
import { buildCertificationsSection } from '../certifications/service';
import { buildCompensationSection, hasCompensationEntries } from '../compensation/service';
import { buildDocumentsSection } from '../documents/service';
import { getESignatureStatus } from '../e-signatures/service';
import {
  assertCanChangeBirthAndCivilStatus,
  assertCanChangeSensitiveDetails,
  assertCanEditEmployeeRecord,
  assertCanReadEmployeeRecords,
  canChangeBirthAndCivilStatus,
  canChangeSensitiveDetails,
  canEditCertifications,
  canEditEmployeeRecord,
  canEditSkills,
  canManageDocuments,
  canManageEmployeeAccount,
  canRemoveCertifications,
  canSeeAllowances,
  canSeeBirthAndCivilStatus,
  canSeeSensitiveSection,
  type RecordTarget,
  type TalentActor,
} from '../policy';
import { inputError } from '../input';
import {
  EMPLOYEE_RECORD_SENSITIVE_SELECT,
  type EmployeeRecordDocument,
  EmployeeRecordModel,
} from './model';

// Spec: docs/modules/talent.md#the-employee-record-build-step-21, SECURITY.md#sensitive-data and
// docs/DATA_MODEL.md#collection-ownership (decisions 155–170 in docs/BUILD_PLAN.md).
//
// Reads: the employee list (Talent Read), one record (Talent Read) and the own record (any
// signed-in user with an employee). Each view is built for its viewer on the server: a section
// the viewer may not reveal is not in the object at all, nor its last 4 digits, and the date of
// birth and civil status keys are absent for anyone but HR, Accounting, the System Administrator
// and the employee.
//
// Writes, one section at a time: each runs in one transaction that loads the actor and the
// employee again, re-checks the rules (policy.ts), checks the record's `version`, writes, and
// records the audit entry (`create` on the first save, then `update` with both sides
// snapshotted, so a changed sensitive value shows only as "Hidden (sensitive), changed").
// The record is created by the first save; two first saves at once leave one (unique
// `employeeId`), and the second gets the stale-form message.

const EMPLOYEE_GONE = 'This employee no longer exists. Reload the page.';
const BIRTH_IN_FUTURE = 'The date of birth can’t be in the future.';

/** The label of the record's audit entries: `<employee number> · <first name> <last name>`. */
function recordLabel(identity: EmployeeIdentity): string {
  return `${identity.employeeNumber} · ${identity.firstName} ${identity.lastName}`;
}

function targetOf(identity: EmployeeIdentity): RecordTarget {
  return { employeeId: identity.employeeId, departmentCode: identity.department?.code ?? null };
}

const dayOrNull = (value: Date | null | undefined) => (value ? toBusinessDate(value) : null);
const instantOrNull = (value: string | null) => (value ? startOfBusinessDate(value) : null);

// ---------------------------------------------------------------------------------------------
// Reads

export interface ListEmployeeRecordsOptions {
  /** Name or employee number; every word must match. */
  q?: string | null;
  departmentId?: string | null;
  status?: EmploymentStatus | null;
  /** "Show separated". */
  separated?: boolean;
}

/**
 * Which of `identities` have something saved in Talent that `viewer` may know about: a record, or
 * a compensation entry, which counts only for a viewer who may see that employee's Compensation
 * section. Otherwise the "Not filled in" badge would tell anyone else that a salary is stored
 * (SECURITY.md#sensitive-data: no "has a value" flag).
 */
async function filledInSet(
  viewer: TalentActor,
  identities: EmployeeIdentity[],
): Promise<Set<string>> {
  if (identities.length === 0) return new Set();
  const employeeIds = identities.map((identity) => new Types.ObjectId(identity.employeeId));
  const salaryVisible = identities
    .filter((identity) => canSeeSensitiveSection(viewer, 'salary', targetOf(identity)))
    .map((identity) => new Types.ObjectId(identity.employeeId));
  const [records, withCompensation] = await Promise.all([
    EmployeeRecordModel.find({ employeeId: { $in: employeeIds } }, { employeeId: 1 }).lean(),
    hasCompensationEntries(salaryVisible),
  ]);
  return new Set([...records.map((r) => r.employeeId.toHexString()), ...withCompensation]);
}

/**
 * The employee list (`/talent`): Talent Read. Employees from Core's identity service, by last
 * name, then first name, with no paging; separated ones only with `separated`. The stat tiles
 * count active employees by employment status, whatever the filters. No sensitive field, date of
 * birth or civil status is in it.
 */
export async function listEmployeeRecords(
  actor: TalentActor,
  { q, departmentId, status, separated = false }: ListEmployeeRecordsOptions = {},
): Promise<EmployeeList> {
  assertCanReadEmployeeRecords(actor);
  await connectDb();
  const [identities, everyone] = await Promise.all([
    listEmployeeIdentities(actor, { q, departmentId, status, separated }),
    listEmployeeIdentities(actor),
  ]);
  const filled = await filledInSet(actor, identities);

  const rows = identities.map((identity): EmployeeListRow => ({
    employeeId: identity.employeeId,
    userId: identity.userId,
    name: `${identity.firstName} ${identity.lastName}`,
    initials: initialsOf(identity),
    photoUrl: identity.photoUrl,
    employeeNumber: identity.employeeNumber,
    firstName: identity.firstName,
    middleName: identity.middleName,
    lastName: identity.lastName,
    department: identity.department,
    position: identity.position ? { id: identity.position.id, name: identity.position.name } : null,
    employmentStatus: identity.employmentStatus,
    dateHired: identity.dateHired,
    separated: identity.separated,
    active: identity.active,
    filledIn: filled.has(identity.employeeId),
  }));

  const counts = new Map<EmploymentStatus, number>();
  for (const identity of everyone) {
    counts.set(identity.employmentStatus, (counts.get(identity.employmentStatus) ?? 0) + 1);
  }
  const stats = EMPLOYMENT_STATUSES.filter((s) => EMPLOYMENT_STATUS[s] === 'active').map((s) => ({
    status: s,
    count: counts.get(s) ?? 0,
  }));
  return { rows, stats };
}

async function maskedDigits(
  value: unknown,
  ownerId: string,
  field: string,
): Promise<MaskedDigitsView | null> {
  if (value === undefined || value === null) return null;
  return {
    lastFour: await sensitiveLastFour(value),
    ownerType: EMPLOYEE_RECORD_TYPE,
    ownerId,
    field,
  };
}

type LeanRecord = Partial<EmployeeRecordDocument> & Pick<EmployeeRecordDocument, '_id'>;

/** The record view for `viewer`, built section by section (see the header). */
async function buildView(
  viewer: TalentActor,
  identity: EmployeeIdentity,
  { readOnly }: { readOnly: boolean },
): Promise<EmployeeRecordView> {
  const target = targetOf(identity);
  const showIds = canSeeSensitiveSection(viewer, 'governmentId', target);
  const showBank = canSeeSensitiveSection(viewer, 'bankAccount', target);
  const showSalary = canSeeSensitiveSection(viewer, 'salary', target);
  const showAllowances = canSeeAllowances(viewer, target);
  const showBirth = canSeeBirthAndCivilStatus(viewer, target);

  const query = EmployeeRecordModel.findOne({ employeeId: identity.employeeId });
  // The encrypted values are loaded only for a viewer who may see their last 4.
  if (showIds || showBank) query.select(EMPLOYEE_RECORD_SENSITIVE_SELECT);
  const record = (await query.lean()) as LeanRecord | null;
  const recordId = record ? record._id.toHexString() : null;

  const personal: PersonalSectionView = {
    sex: record?.sex ?? null,
    nationality: record?.nationality ?? null,
    presentAddress: record?.presentAddress ?? null,
    permanentAddress: record?.permanentAddress ?? null,
    mobileNumber: record?.mobileNumber ?? null,
    personalEmail: record?.personalEmail ?? null,
    emergencyContact: record?.emergencyContact
      ? {
          name: record.emergencyContact.name ?? null,
          relationship: record.emergencyContact.relationship ?? null,
          mobileNumber: record.emergencyContact.mobileNumber ?? null,
        }
      : null,
  };
  if (showBirth) {
    personal.dateOfBirth = dayOrNull(record?.dateOfBirth);
    personal.civilStatus = record?.civilStatus ?? null;
  }

  const contractEndDate = dayOrNull(record?.contractEndDate);
  const today = businessToday();
  const [documentsSection, eSignature, certifications] = await Promise.all([
    buildDocumentsSection(viewer, target, today),
    getESignatureStatus(viewer, identity.employeeId),
    buildCertificationsSection(viewer, identity.employeeId, today),
  ]);
  const own = viewer.employee !== null && viewer.employee.id === identity.employeeId;
  const view: EmployeeRecordView = {
    employeeId: identity.employeeId,
    identity,
    recordId,
    version: record?.version ?? 0,
    filledIn: record !== null,
    personal,
    employment: {
      workRegion: record?.workRegion ?? DEFAULT_WORK_REGION,
      contractEndDate,
      regularizationDate: dayOrNull(record?.regularizationDate),
      separationRemarks: record?.separationRemarks ?? null,
      probationEndDate: probationEndDate(identity.employmentStatus, identity.dateHired),
      contractEndDateMissing: isContractEndDateMissing(identity.employmentStatus, contractEndDate),
    },
    photoUrl: identity.photoUrl,
    eSignature,
    skills: [...(record?.skills ?? [])],
    certifications,
    can: {
      editPersonal: !readOnly && canEditEmployeeRecord(viewer, target),
      editBirthAndCivilStatus: !readOnly && canChangeBirthAndCivilStatus(viewer, target),
      editEmployment: !readOnly && canEditEmployeeRecord(viewer, target),
      editGovernmentIds: !readOnly && canChangeSensitiveDetails(viewer, target),
      editBankAccount: !readOnly && canChangeSensitiveDetails(viewer, target),
      addCompensation: !readOnly && canChangeSensitiveDetails(viewer, target),
      assignAllowance: !readOnly && canChangeSensitiveDetails(viewer, target),
      // The photo is changed on /talent/me by the employee, and in the inspector by HR and the
      // System Administrator (Core's rule, checked again by Core's service).
      changePhoto: canChangeEmployeePhoto(viewer, identity.employeeId),
      manageDocuments: !readOnly && canManageDocuments(viewer, target),
      addCertification: !readOnly && canEditCertifications(viewer, target),
      editCertification: !readOnly && canEditCertifications(viewer, target),
      removeCertification: !readOnly && canRemoveCertifications(viewer, target),
      editSkills: !readOnly && canEditSkills(viewer, target),
      // Only the owner uploads, on /talent/me (the read-only own view).
      uploadESignature: readOnly && own,
    },
    editInUsersHref:
      !readOnly && canManageEmployeeAccount(viewer)
        ? `/admin/users?q=${encodeURIComponent(identity.employeeNumber)}`
        : null,
    manageAccessHref:
      !readOnly && canManageEmployeeAccount(viewer) && identity.active && identity.userId
        ? `/admin/access?user=${encodeURIComponent(identity.userId)}`
        : null,
  };

  // A compensation entry counts as "filled in" only for a viewer who may see Compensation: for
  // anyone else the badge would say that a salary is stored (see filledInSet).
  if (showSalary) {
    view.compensation = await buildCompensationSection(
      identity.employeeId,
      today,
      record?.workRegion ?? DEFAULT_WORK_REGION,
    );
    if (view.compensation.entries.length > 0) view.filledIn = true;
  }
  // The allowances only for a viewer who may reveal `allowances` (decision 204).
  if (showAllowances) view.allowances = await buildAllowancesSection(identity, today);
  if (showIds) {
    const ids = record?.governmentIds;
    const masked = async (field: GovernmentIdField) =>
      recordId ? maskedDigits(ids?.[field], recordId, field) : null;
    view.governmentIds = {
      tin: await masked('tin'),
      rdoCode: ids?.rdoCode ?? null,
      sss: await masked('sss'),
      philhealth: await masked('philhealth'),
      pagibig: await masked('pagibig'),
    };
  }
  if (showBank) {
    const bank = record?.bankAccount;
    view.bankAccount = {
      bank: bank?.bank ?? null,
      accountNumber: recordId
        ? await maskedDigits(bank?.accountNumber, recordId, BANK_ACCOUNT_NUMBER_FIELD)
        : null,
      accountName: bank?.accountName ?? null,
    };
  }
  if (!showIds || !showBank || !showSalary) view.restrictedNotice = RESTRICTED_SECTIONS_NOTICE;
  // The 201 file only for a viewer who may see a category of it; otherwise not even the key.
  if (documentsSection.documents) view.documents = documentsSection.documents;
  if (documentsSection.notice) view.documentsNotice = documentsSection.notice;
  return view;
}

/**
 * One employee's record for the `/talent` inspector: Talent Read. Null when there is no such
 * employee, or they are separated and `separated` isn't set. Sections are built for the viewer.
 */
export async function getEmployeeRecordView(
  actor: TalentActor,
  employeeId: string,
  { separated = false }: { separated?: boolean } = {},
): Promise<EmployeeRecordView | null> {
  assertCanReadEmployeeRecords(actor);
  await connectDb();
  const identity = await getEmployeeIdentity(actor, employeeId, { separated });
  if (!identity) return null;
  return buildView(actor, identity, { readOnly: false });
}

/**
 * The signed-in user's own record (`/talent/me`), read-only, with every section (the employee
 * may reveal everything on their own record). Needs no Talent access and takes no employee id:
 * it loads `actor.employee` only. Null for the bootstrap system account, which has no employee.
 */
export async function getOwnRecordView(actor: TalentActor): Promise<EmployeeRecordView | null> {
  if (!actor.employee) return null;
  await connectDb();
  const identity = await getEmployeeIdentity(actor, actor.employee.id);
  if (!identity) return null;
  return buildView(actor, identity, { readOnly: true });
}

// ---------------------------------------------------------------------------------------------
// Writes

/** Something that the actor and employee must allow: before encrypting, and again in the transaction. */
type SectionCheck = (actor: TalentActor, target: RecordTarget) => void;

interface SectionSave {
  employeeId: string;
  version: number;
  /** The fields to set, as dotted paths; sensitive values already encrypted. */
  changes: Record<string, unknown>;
  check: SectionCheck;
  /** Checks against the stored record, in the transaction, throwing ActionError. */
  validate?: (existing: EmployeeRecordDocument | null) => void;
}

function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 11000;
}

/** Loads the employee for a pre-check, before anything is encrypted. */
async function preCheck(
  actor: TalentActor,
  employeeId: string,
  check: SectionCheck,
): Promise<EmployeeIdentity> {
  assertCanEditEmployeeRecord(actor, { employeeId, departmentCode: null });
  const identity = await getEmployeeIdentity(actor, employeeId, { separated: true });
  if (!identity) throw new ActionError(EMPLOYEE_GONE);
  check(actor, targetOf(identity));
  return identity;
}

/** The shared write path of every section (see the header). Returns the record's new version. */
async function saveSection(actor: TalentActor, save: SectionSave): Promise<{ version: number }> {
  const actorId = actor.id;
  try {
    return await withTransaction(async (session: ClientSession) => {
      const current = await reloadActorAccess({ id: actorId }, session);
      const identity = await getEmployeeIdentity(current, save.employeeId, {
        separated: true,
        session,
      });
      if (!identity) throw new ActionError(EMPLOYEE_GONE);
      save.check(current, targetOf(identity));

      const existing = (await EmployeeRecordModel.findOne({ employeeId: identity.employeeId })
        .select(EMPLOYEE_RECORD_SENSITIVE_SELECT)
        .session(session)
        .lean()) as EmployeeRecordDocument | null;
      if ((existing?.version ?? 0) !== save.version) {
        throw new ActionError(RECORD_CHANGED_ELSEWHERE);
      }
      save.validate?.(existing);

      const label = recordLabel(identity);
      if (!existing) {
        const record = new EmployeeRecordModel({
          employeeId: identity.employeeId,
          version: 1,
          createdBy: current.id,
          updatedBy: current.id,
        });
        record.set(save.changes);
        await record.save({ session });
        await recordAudit(
          {
            actorId: current.id,
            actorEmail: current.email,
            module: 'talent',
            action: 'create',
            record: { type: EMPLOYEE_RECORD_TYPE, id: record._id, label },
            before: null,
            after: snapshotForAudit(EmployeeRecordModel, record),
          },
          { session },
        );
        return { version: 1 };
      }

      const updated = (await EmployeeRecordModel.findOneAndUpdate(
        { _id: existing._id, version: existing.version },
        { $set: { ...save.changes, updatedBy: current.id }, $inc: { version: 1 } },
        { session, returnDocument: 'after', runValidators: true },
      )
        .select(EMPLOYEE_RECORD_SENSITIVE_SELECT)
        .lean()) as EmployeeRecordDocument | null;
      if (!updated) throw new ActionError(RECORD_CHANGED_ELSEWHERE);
      const { before, after } = snapshotsForAudit(EmployeeRecordModel, existing, updated);
      await recordAudit(
        {
          actorId: current.id,
          actorEmail: current.email,
          module: 'talent',
          action: 'update',
          record: { type: EMPLOYEE_RECORD_TYPE, id: existing._id, label },
          before,
          after,
        },
        { session },
      );
      return { version: updated.version };
    });
  } catch (error) {
    // Two first saves at once: the unique `employeeId` index refused the second insert.
    if (isDuplicateKey(error)) throw new ActionError(RECORD_CHANGED_ELSEWHERE);
    throw error;
  }
}

/**
 * Saves the Personal section: Talent Write, never one's own record. The date of birth and civil
 * status, when the input has them (absent keys keep the stored values), also need HR or the
 * System Administrator.
 */
export async function updatePersonal(
  actor: TalentActor,
  input: PersonalSectionInput,
): Promise<{ version: number }> {
  const parsed = personalSectionSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const values = parsed.data;
  const touchesBirth = values.dateOfBirth !== undefined || values.civilStatus !== undefined;
  const check: SectionCheck = (who, target) => {
    assertCanEditEmployeeRecord(who, target);
    if (touchesBirth) assertCanChangeBirthAndCivilStatus(who, target);
  };
  await preCheck(actor, values.employeeId, check);

  if (values.dateOfBirth && values.dateOfBirth > businessToday()) {
    throw new ActionError(BIRTH_IN_FUTURE, { field: 'dateOfBirth' });
  }
  const contact = {
    name: values.emergencyContactName,
    relationship: values.emergencyContactRelationship,
    mobileNumber: values.emergencyContactMobile,
  };
  const changes: Record<string, unknown> = {
    sex: values.sex,
    nationality: values.nationality,
    presentAddress: values.presentAddress,
    permanentAddress: values.permanentAddress,
    mobileNumber: values.mobileNumber,
    personalEmail: values.personalEmail,
    emergencyContact: Object.values(contact).some((value) => value !== null) ? contact : null,
  };
  if (values.dateOfBirth !== undefined) changes.dateOfBirth = instantOrNull(values.dateOfBirth);
  if (values.civilStatus !== undefined) changes.civilStatus = values.civilStatus;

  return saveSection(actor, {
    employeeId: values.employeeId,
    version: values.version,
    changes,
    check,
  });
}

/** Saves Talent's Employment fields: Talent Write, never one's own record. */
export async function updateEmployment(
  actor: TalentActor,
  input: EmploymentSectionInput,
): Promise<{ version: number }> {
  const parsed = employmentSectionSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const values = parsed.data;
  const check: SectionCheck = (who, target) => assertCanEditEmployeeRecord(who, target);
  await preCheck(actor, values.employeeId, check);
  return saveSection(actor, {
    employeeId: values.employeeId,
    version: values.version,
    changes: {
      workRegion: values.workRegion,
      contractEndDate: instantOrNull(values.contractEndDate),
      regularizationDate: instantOrNull(values.regularizationDate),
      separationRemarks: values.separationRemarks,
    },
    check,
  });
}

const sensitiveCheck: SectionCheck = (who, target) => assertCanChangeSensitiveDetails(who, target);

/**
 * Saves the Government IDs: Talent Write and HR or the System Administrator; for an HR-department
 * employee, Talent Write and the System Administrator or a Board member. Never one's own. An
 * empty ID keeps the stored one (an ID can be replaced, never cleared).
 */
export async function setGovernmentIds(
  actor: TalentActor,
  input: GovernmentIdsSectionInput,
): Promise<{ version: number }> {
  const parsed = governmentIdsSectionSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const values = parsed.data;
  await preCheck(actor, values.employeeId, sensitiveCheck);

  const changes: Record<string, unknown> = { 'governmentIds.rdoCode': values.rdoCode };
  for (const field of ['tin', 'sss', 'philhealth', 'pagibig'] as const) {
    const value = values[field];
    if (value !== undefined) changes[`governmentIds.${field}`] = await encryptSensitive(value);
  }
  return saveSection(actor, {
    employeeId: values.employeeId,
    version: values.version,
    changes,
    check: sensitiveCheck,
  });
}

/**
 * Saves the Payroll bank account: the same rule as {@link setGovernmentIds}. An empty account
 * number keeps the stored one; the first save of a bank account needs one.
 */
export async function setBankAccount(
  actor: TalentActor,
  input: BankAccountSectionInput,
): Promise<{ version: number }> {
  const parsed = bankAccountSectionSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const values = parsed.data;
  await preCheck(actor, values.employeeId, sensitiveCheck);

  const changes: Record<string, unknown> = {
    'bankAccount.bank': values.bank,
    'bankAccount.accountName': values.accountName,
  };
  if (values.accountNumber !== undefined) {
    changes['bankAccount.accountNumber'] = await encryptSensitive(values.accountNumber);
  }
  return saveSection(actor, {
    employeeId: values.employeeId,
    version: values.version,
    changes,
    check: sensitiveCheck,
    validate: (existing) => {
      if (values.accountNumber === undefined && !existing?.bankAccount?.accountNumber) {
        throw new ActionError('Enter the account number.', { field: 'accountNumber' });
      }
    },
  });
}

/**
 * Saves the skills tags (build step 2.2, decision 183): Talent Write, never one's own record, with
 * the record's `version`, like a section. Up to 30 tags of up to 50 characters, no duplicates
 * ignoring case. One `update` entry on `talent.employeeRecord` (`create` on the first save).
 */
export async function setSkills(
  actor: TalentActor,
  input: SkillsSectionInput,
): Promise<{ version: number }> {
  const parsed = skillsSectionSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const values = parsed.data;
  const check: SectionCheck = (who, target) => assertCanEditEmployeeRecord(who, target);
  await preCheck(actor, values.employeeId, check);
  return saveSection(actor, {
    employeeId: values.employeeId,
    version: values.version,
    changes: { skills: values.skills },
    check,
  });
}
