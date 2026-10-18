import { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { type BusinessDate, businessToday, toBusinessDate } from '@pulse/core';
import {
  employeeOnboardingFacts,
  type EmployeeOnboardingFacts,
  getEmployeeIdentity,
  userNames,
} from '@pulse/core/server';
import { DEFAULT_WORK_REGION, type Document201Type, type WorkRegion } from '../../fixed-sets';
import type { OnboardingItemKey } from '../../onboarding/items';
import { EMPLOYEE_UPLOAD_DOCUMENT_TYPES } from '../../onboarding/settings';
import {
  type OnboardingDocumentFact,
  onboardingFilledFields,
  type OnboardingRecordValues,
  type OnboardingSnapshot,
  type OnboardingStatus,
  onboardingStatus,
} from '../../onboarding/status';
import {
  type EmployeeOnboardingView,
  onboardingViewOf,
  type OwnOnboardingView,
} from '../../onboarding/views';
import { hasCompensationEntries } from '../compensation/service';
import { EmployeeDocumentModel } from '../documents/model';
import { ESignatureModel } from '../e-signatures/model';
import { EmployeeRecordModel } from '../employee-records/model';
import {
  assertCanReadEmployeeRecords,
  canConfirmNoSupervisor,
  canSeeDocumentCategory,
  canSeeSensitiveSection,
  type RecordTarget,
  type TalentActor,
} from '../policy';
import { targetOf } from '../shared';
import { WorkScheduleAssignmentModel } from '../work-schedules/model';
import { onboardingSettingsOn } from './settings';

// Spec: docs/modules/talent.md#onboarding-checklist-and-change-requests-build-step-26 ("The
// checklist", "Required but not enforced", "Screens"; decisions 257–261 and 274 in
// docs/BUILD_PLAN.md) and SECURITY.md#sensitive-data — the onboarding checklist, derived every
// time it is read from the records it is about. Nothing is stored but the two HR confirmations on
// the employee record.
//
// - The facts are presence flags only: Core's account facts (`employeeOnboardingFacts`, no
//   sensitive field), which of the record's fields hold a value (the sensitive ones read as
//   "stored or not" in the database, never decrypted or loaded), the 201 documents' types and
//   dates, whether an e-signature, a compensation entry or an own schedule exists, and the
//   required documents setting.
// - Own: the signed-in user's checklist (self-service, no employee id); the system account has none.
// - Others': the inspector's Onboarding section (Talent Read). An item about a section the viewer
//   can't see (government IDs, bank account, salary, 201 documents) is hidden, and so is any count
//   that includes it (HANDOFF items 101 and 104).
// - The /talent filter and tiles: HR and the System Administrator only.

type RecordFacts = OnboardingRecordValues & {
  employeeId: Types.ObjectId;
  workRegion?: WorkRegion;
  governmentIdsVerification?: unknown;
  bankAccountVerification?: unknown;
  noSupervisorConfirmation?: { confirmedAt: Date; confirmedBy: Types.ObjectId } | null;
};

const isStored = (path: string) => ({
  $cond: [{ $eq: [{ $type: path }, 'binData'] }, true, null],
});

/** The records' presence facts: each sensitive value only as "stored or not", from the database. */
async function recordFacts(ids: Types.ObjectId[]): Promise<Map<string, RecordFacts>> {
  const rows = await EmployeeRecordModel.aggregate<RecordFacts>([
    { $match: { employeeId: { $in: ids } } },
    {
      $project: {
        _id: 0,
        employeeId: 1,
        dateOfBirth: 1,
        sex: 1,
        civilStatus: 1,
        nationality: 1,
        presentAddress: 1,
        permanentAddress: 1,
        mobileNumber: 1,
        emergencyContact: 1,
        workRegion: 1,
        governmentIds: {
          tin: isStored('$governmentIds.tin'),
          sss: isStored('$governmentIds.sss'),
          philhealth: isStored('$governmentIds.philhealth'),
          pagibig: isStored('$governmentIds.pagibig'),
          rdoCode: { $ifNull: ['$governmentIds.rdoCode', null] },
        },
        bankAccount: {
          bank: { $ifNull: ['$bankAccount.bank', null] },
          accountNumber: isStored('$bankAccount.accountNumber'),
          accountName: { $ifNull: ['$bankAccount.accountName', null] },
        },
        governmentIdsVerification: 1,
        bankAccountVerification: 1,
        noSupervisorConfirmation: 1,
      },
    },
  ]);
  return new Map(rows.map((row) => [row.employeeId.toHexString(), row]));
}

/** Each employee's 201 documents (type, archived, expiry date only). */
async function documentFacts(
  ids: Types.ObjectId[],
): Promise<Map<string, OnboardingDocumentFact[]>> {
  const rows = await EmployeeDocumentModel.find(
    { employeeId: { $in: ids } },
    { employeeId: 1, type: 1, archivedAt: 1, expiryDate: 1 },
  ).lean<
    {
      employeeId: Types.ObjectId;
      type: Document201Type;
      archivedAt: Date | null;
      expiryDate: Date | null;
    }[]
  >();
  const byEmployee = new Map<string, OnboardingDocumentFact[]>();
  for (const row of rows) {
    const key = row.employeeId.toHexString();
    const list = byEmployee.get(key) ?? [];
    list.push({
      type: row.type,
      archived: row.archivedAt !== null && row.archivedAt !== undefined,
      expiryDate: row.expiryDate ? toBusinessDate(row.expiryDate) : null,
    });
    byEmployee.set(key, list);
  }
  return byEmployee;
}

/** The employees whose latest work schedule assignment on or before `today` is an own schedule. */
async function ownScheduleSet(ids: Types.ObjectId[], today: BusinessDate): Promise<Set<string>> {
  const rows = await WorkScheduleAssignmentModel.find(
    { employeeId: { $in: ids } },
    { employeeId: 1, effectiveFrom: 1, schedule: 1, createdAt: 1 },
  ).lean<
    { employeeId: Types.ObjectId; effectiveFrom: Date; schedule: unknown; createdAt: Date }[]
  >();
  const latest = new Map<string, { day: BusinessDate; createdAt: Date; own: boolean }>();
  for (const row of rows) {
    const day = toBusinessDate(row.effectiveFrom);
    if (day > today) continue;
    const key = row.employeeId.toHexString();
    const found = latest.get(key);
    if (
      !found ||
      day > found.day ||
      (day === found.day && row.createdAt.getTime() >= found.createdAt.getTime())
    ) {
      latest.set(key, { day, createdAt: row.createdAt, own: row.schedule != null });
    }
  }
  return new Set([...latest].filter(([, entry]) => entry.own).map(([key]) => key));
}

/** One employee's derived checklist, with what the views need besides it. */
export interface DerivedOnboarding {
  status: OnboardingStatus;
  facts: EmployeeOnboardingFacts;
  noSupervisorConfirmation: { confirmedAt: Date; confirmedBy: Types.ObjectId } | null;
}

/**
 * The checklist of each of `employeeIds` that Core knows, by employee id. Server-only, with no
 * access check: the callers below check the viewer first. Writes nothing.
 */
export async function deriveOnboarding(
  employeeIds: readonly string[],
  today: BusinessDate = businessToday(),
): Promise<Map<string, DerivedOnboarding>> {
  const ids = employeeIds.flatMap((id) =>
    /^[a-f\d]{24}$/i.test(id) ? [new Types.ObjectId(id)] : [],
  );
  if (ids.length === 0) return new Map();
  await connectDb();
  const [facts, records, documents, signatures, compensation, ownSchedules, settings] =
    await Promise.all([
      employeeOnboardingFacts(ids),
      recordFacts(ids),
      documentFacts(ids),
      ESignatureModel.distinct('employeeId', { employeeId: { $in: ids } }) as Promise<
        Types.ObjectId[]
      >,
      hasCompensationEntries(ids),
      ownScheduleSet(ids, today),
      onboardingSettingsOn(today),
    ]);
  const signed = new Set(signatures.map((id) => id.toHexString()));
  const result = new Map<string, DerivedOnboarding>();
  for (const fact of facts) {
    const record = records.get(fact.employeeId) ?? null;
    const snapshot: OnboardingSnapshot = {
      today,
      core: {
        temporaryPassword: fact.hasTemporaryPassword,
        needsAccess: fact.needsAccess,
        hasPhoto: fact.hasPhoto,
        isBoardMember: fact.isBoardMember,
        activeSupervisorCount: fact.activeSupervisorCount,
        // Creating a user requires all three (decision 258).
        hasDepartment: true,
        hasPosition: true,
        hasEmploymentStatus: true,
      },
      filled: onboardingFilledFields(record),
      governmentIdsVerified: record?.governmentIdsVerification != null,
      bankAccountVerified: record?.bankAccountVerification != null,
      noSupervisorConfirmed: record?.noSupervisorConfirmation != null,
      workRegion: record?.workRegion ?? DEFAULT_WORK_REGION,
      ownWorkSchedule: ownSchedules.has(fact.employeeId),
      hasESignature: signed.has(fact.employeeId),
      hasCompensation: compensation.has(fact.employeeId),
      documents: documents.get(fact.employeeId) ?? [],
      requiredDocumentTypes: settings.requiredDocumentTypes,
    };
    result.set(fact.employeeId, {
      status: onboardingStatus(snapshot),
      facts: fact,
      noSupervisorConfirmation: record?.noSupervisorConfirmation ?? null,
    });
  }
  return result;
}

/**
 * The items `viewer` may not see the state of on `target`'s checklist: government IDs, the bank
 * account, the salary, and the 201 documents (every category the required types fall in).
 */
export function hiddenOnboardingItems(
  viewer: TalentActor,
  target: RecordTarget,
  requiredDocumentTypes: readonly Document201Type[],
): OnboardingItemKey[] {
  const hidden: OnboardingItemKey[] = [];
  if (!canSeeSensitiveSection(viewer, 'governmentId', target)) hidden.push('governmentIds');
  if (!canSeeSensitiveSection(viewer, 'bankAccount', target)) hidden.push('bankAccount');
  const medical = requiredDocumentTypes.includes('medicalCertificate');
  if (
    !canSeeDocumentCategory(viewer, 'file201', target) ||
    (medical && !canSeeDocumentCategory(viewer, 'medical', target))
  ) {
    hidden.push('documents');
  }
  if (!canSeeSensitiveSection(viewer, 'salary', target)) hidden.push('compensation');
  return hidden;
}

/**
 * The signed-in user's own checklist (`/talent/onboarding`, the toolbar pill and the Home card):
 * self-service, no employee id, nothing hidden. Null for the system account, which has no employee.
 */
export async function getOwnOnboarding(actor: TalentActor): Promise<OwnOnboardingView | null> {
  const ownId = actor.employee?.id;
  if (!ownId) return null;
  const derived = (await deriveOnboarding([ownId])).get(ownId);
  if (!derived) return null;
  return {
    ...onboardingViewOf(derived.status),
    uploadTypes: [...EMPLOYEE_UPLOAD_DOCUMENT_TYPES],
  };
}

/**
 * The toolbar pill and Home card's condition: the own employee progress ("Onboarding 5 of 8") and
 * whether to show the reminder (any employee item To do). Null for the system account.
 */
export async function getOwnOnboardingReminder(
  actor: TalentActor,
): Promise<{ done: number; total: number; showReminder: boolean } | null> {
  const ownId = actor.employee?.id;
  if (!ownId) return null;
  const derived = (await deriveOnboarding([ownId])).get(ownId);
  if (!derived) return null;
  return { ...derived.status.employeeProgress, showReminder: derived.status.showReminder };
}

/**
 * The inspector's Onboarding section for `employeeId`: Talent Read. Items about sections the
 * viewer can't see are hidden, with any count that includes them. "Confirm no supervisor" is
 * offered to HR, a Board member or the System Administrator (never on their own record) while the
 * employee has no active supervisor; "Withdraw" while it is confirmed. Null when there is no such
 * employee for this viewer.
 */
export async function getEmployeeOnboarding(
  actor: TalentActor,
  employeeId: string,
  { separated = false }: { separated?: boolean } = {},
): Promise<EmployeeOnboardingView | null> {
  assertCanReadEmployeeRecords(actor);
  await connectDb();
  const identity = await getEmployeeIdentity(actor, employeeId, { separated });
  if (!identity) return null;
  const today = businessToday();
  const [derived, settings] = await Promise.all([
    deriveOnboarding([identity.employeeId], today).then((map) => map.get(identity.employeeId)),
    onboardingSettingsOn(today),
  ]);
  if (!derived) return null;
  const target = targetOf(identity);
  const hidden = hiddenOnboardingItems(actor, target, settings.requiredDocumentTypes);
  const confirmation = derived.noSupervisorConfirmation;
  const names = await userNames(confirmation ? [confirmation.confirmedBy] : []);
  const mayConfirm = canConfirmNoSupervisor(actor, target);
  return {
    ...onboardingViewOf(derived.status, hidden),
    noSupervisor: {
      confirmed: confirmation
        ? {
            at: confirmation.confirmedAt,
            byName: names.get(confirmation.confirmedBy.toHexString()) ?? 'Unknown user',
          }
        : null,
      canConfirm: mayConfirm && !confirmation && derived.facts.activeSupervisorCount === 0,
      canWithdraw: mayConfirm && confirmation !== null,
    },
  };
}

/** The /talent onboarding filter (`?onboarding=incomplete|verify`). */
export type OnboardingFilter = 'incomplete' | 'verify';
export const ONBOARDING_FILTERS: readonly OnboardingFilter[] = ['incomplete', 'verify'];

/** Each employee's place in the /talent filter: onboarding incomplete, and details to verify. */
export async function onboardingOverview(
  employeeIds: readonly string[],
): Promise<Map<string, { incomplete: boolean; toVerify: boolean }>> {
  const derived = await deriveOnboarding(employeeIds);
  return new Map(
    [...derived].map(([id, { status }]) => [
      id,
      {
        incomplete: !status.complete,
        toVerify:
          status.states.governmentIds === 'waitingForVerification' ||
          status.states.bankAccount === 'waitingForVerification',
      },
    ]),
  );
}
