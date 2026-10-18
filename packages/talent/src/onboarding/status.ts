import type { BusinessDate } from '@pulse/core';
import { expiryStateOf } from '../derived';
import {
  DOCUMENT_201_TYPE_LABELS,
  type Document201Type,
  WORK_REGION_LABELS,
  type WorkRegion,
} from '../fixed-sets';
import {
  ASSETS_PLACEHOLDER_NOTE,
  ONBOARDING_EMPLOYEE_ITEMS,
  ONBOARDING_HR_ITEMS,
  ONBOARDING_ITEM_LABELS,
  type OnboardingEmployeeItem,
  type OnboardingHrItem,
  type OnboardingItemKey,
  type OnboardingItemState,
} from './items';

// Spec: docs/modules/talent.md#onboarding-checklist-and-change-requests-build-step-26 ("The
// checklist", "Progress", "Required but not enforced"; decisions 257, 258, 260 and 261 in
// docs/BUILD_PLAN.md) — each item's state, derived from plain facts every time it is read. Pure
// code with no database: the server gathers the facts (Core's account facts, the employee record,
// its 201 documents, e-signatures, compensation entries and `talent.onboardingSettings`) and calls
// `onboardingStatus`. The facts are presence flags only, never a value, so nothing sensitive
// passes through here.

/** The employee record fields the checklist needs filled in, by item. *Assumption* (item 84). */
export const ONBOARDING_REQUIRED_FIELDS = {
  personalInfo: [
    'dateOfBirth',
    'sex',
    'civilStatus',
    'nationality',
    'presentAddress',
    'permanentAddress',
    'mobileNumber',
  ],
  emergencyContact: [
    'emergencyContactName',
    'emergencyContactRelationship',
    'emergencyContactMobile',
  ],
  governmentIds: ['tin', 'rdoCode', 'sss', 'philhealth', 'pagibig'],
  bankAccount: ['bank', 'accountNumber', 'accountName'],
} as const satisfies Partial<Record<OnboardingEmployeeItem, readonly string[]>>;

export type OnboardingRecordField =
  (typeof ONBOARDING_REQUIRED_FIELDS)[keyof typeof ONBOARDING_REQUIRED_FIELDS][number];

/** Which required fields hold a value. */
export type OnboardingFilledFields = Readonly<Record<OnboardingRecordField, boolean>>;

/** Core's account facts about the employee (from Core's `employeeOnboardingFacts`). */
export interface OnboardingCoreFacts {
  /** The account still has a temporary password. */
  temporaryPassword: boolean;
  /** The account is in the User access page's "Needs access" group (never a System Administrator). */
  needsAccess: boolean;
  /** A profile photo is set. */
  hasPhoto: boolean;
  /** The employee is in the Board of Directors department. */
  isBoardMember: boolean;
  /** Supervisors in `reportingTo` whose account is active. */
  activeSupervisorCount: number;
  hasDepartment: boolean;
  hasPosition: boolean;
  hasEmploymentStatus: boolean;
}

/** One of the employee's 201 documents. */
export interface OnboardingDocumentFact {
  type: Document201Type;
  archived: boolean;
  expiryDate: BusinessDate | null;
}

/** Everything the checklist is derived from, for one employee. */
export interface OnboardingSnapshot {
  /** Today in Manila: a document expired on or before it doesn't count. */
  today: BusinessDate;
  core: OnboardingCoreFacts;
  /** All false when the employee has no record yet ({@link onboardingFilledFields}(null)). */
  filled: OnboardingFilledFields;
  /** `governmentIdsVerification` is set. */
  governmentIdsVerified: boolean;
  /** `bankAccountVerification` is set. */
  bankAccountVerified: boolean;
  /** `noSupervisorConfirmation` is set. */
  noSupervisorConfirmed: boolean;
  /** The record's work region (NCR when there is no record). */
  workRegion: WorkRegion;
  /** HR set an own work schedule (otherwise the company default applies). */
  ownWorkSchedule: boolean;
  /** At least one e-signature version is uploaded. */
  hasESignature: boolean;
  /** A current or scheduled compensation entry exists. */
  hasCompensation: boolean;
  documents: readonly OnboardingDocumentFact[];
  /** `talent.onboardingSettings.requiredDocumentTypes` in effect today. */
  requiredDocumentTypes: readonly Document201Type[];
}

/** An employee record's values, as stored (sensitive fields still encrypted, or just "set"). */
export interface OnboardingRecordValues {
  dateOfBirth?: unknown;
  sex?: unknown;
  civilStatus?: unknown;
  nationality?: unknown;
  presentAddress?: unknown;
  permanentAddress?: unknown;
  mobileNumber?: unknown;
  emergencyContact?: { name?: unknown; relationship?: unknown; mobileNumber?: unknown } | null;
  governmentIds?: {
    tin?: unknown;
    rdoCode?: unknown;
    sss?: unknown;
    philhealth?: unknown;
    pagibig?: unknown;
  } | null;
  bankAccount?: { bank?: unknown; accountNumber?: unknown; accountName?: unknown } | null;
}

function isSet(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  return true;
}

/**
 * Which required fields of a record hold a value: null, undefined and blank text are empty, and
 * anything else (a stored ciphertext included) is filled. Never reads a value beyond that.
 */
export function onboardingFilledFields(
  record: OnboardingRecordValues | null | undefined,
): OnboardingFilledFields {
  const ids = record?.governmentIds ?? null;
  const bank = record?.bankAccount ?? null;
  const contact = record?.emergencyContact ?? null;
  return {
    dateOfBirth: isSet(record?.dateOfBirth),
    sex: isSet(record?.sex),
    civilStatus: isSet(record?.civilStatus),
    nationality: isSet(record?.nationality),
    presentAddress: isSet(record?.presentAddress),
    permanentAddress: isSet(record?.permanentAddress),
    mobileNumber: isSet(record?.mobileNumber),
    emergencyContactName: isSet(contact?.name),
    emergencyContactRelationship: isSet(contact?.relationship),
    emergencyContactMobile: isSet(contact?.mobileNumber),
    tin: isSet(ids?.tin),
    rdoCode: isSet(ids?.rdoCode),
    sss: isSet(ids?.sss),
    philhealth: isSet(ids?.philhealth),
    pagibig: isSet(ids?.pagibig),
    bank: isSet(bank?.bank),
    accountNumber: isSet(bank?.accountNumber),
    accountName: isSet(bank?.accountName),
  };
}

/** One item, with its state and an optional detail line. */
export interface OnboardingItemStatus {
  key: OnboardingItemKey;
  label: string;
  state: OnboardingItemState;
  /**
   * A line beside the state: the documents still needed, "Company default" or "Own schedule", the
   * work region, "No supervisor (confirmed)", or the placeholder note. Null for none.
   */
  detail: string | null;
}

export interface OnboardingProgress {
  /** Items done (for the employee's own items, waiting for HR to verify counts too). */
  done: number;
  total: number;
}

export interface OnboardingStatus {
  /** The eight employee items, in order. */
  employeeItems: OnboardingItemStatus[];
  /** The nine HR items, in order (the assets placeholder last). */
  hrItems: OnboardingItemStatus[];
  /** Every item's state by key, for the gates. */
  states: Record<OnboardingItemKey, OnboardingItemState>;
  /** "5 of 8 done": the employee items, waiting for HR to verify counted as done. */
  employeeProgress: OnboardingProgress;
  /** HR's own count: the eight HR items without the placeholder. */
  hrProgress: OnboardingProgress;
  /** Every item but the placeholder is done, the government IDs and bank account verified. */
  complete: boolean;
  /**
   * The toolbar pill and the Home card: shown while any employee item is To do; gone once each is
   * done or waiting for HR. HR items never keep it showing.
   */
  showReminder: boolean;
}

function allFilled(filled: OnboardingFilledFields, fields: readonly OnboardingRecordField[]) {
  return fields.every((field) => filled[field]);
}

/** Done when filled in and verified, waiting when filled in only, otherwise To do. */
function verifiedGroupState(filledIn: boolean, verified: boolean): OnboardingItemState {
  if (!filledIn) return 'todo';
  return verified ? 'done' : 'waitingForVerification';
}

/** The required document types with no unarchived, unexpired document, in the setting's order. */
export function missingOnboardingDocumentTypes(
  documents: readonly OnboardingDocumentFact[],
  requiredDocumentTypes: readonly Document201Type[],
  today: BusinessDate,
): Document201Type[] {
  return requiredDocumentTypes.filter(
    (type) =>
      !documents.some(
        (document) =>
          document.type === type &&
          !document.archived &&
          expiryStateOf(document.expiryDate, today, 0).status !== 'expired',
      ),
  );
}

/** The `reportingTo` item: an active supervisor, a Board member, or "No supervisor" confirmed. */
export function reportingToItemState(
  facts: Pick<OnboardingCoreFacts, 'activeSupervisorCount' | 'isBoardMember'> & {
    noSupervisorConfirmed: boolean;
  },
): OnboardingItemState {
  return facts.activeSupervisorCount > 0 || facts.isBoardMember || facts.noSupervisorConfirmed
    ? 'done'
    : 'todo';
}

/** The e-signature item, for the gate when only the signature is known. */
export function eSignatureItemState(hasESignature: boolean): OnboardingItemState {
  return hasESignature ? 'done' : 'todo';
}

const doneIf = (condition: boolean): OnboardingItemState => (condition ? 'done' : 'todo');

/** Derives every item's state, the progress, completion and the reminder from the snapshot. */
export function onboardingStatus(snapshot: OnboardingSnapshot): OnboardingStatus {
  const { core, filled } = snapshot;
  const missingDocuments = missingOnboardingDocumentTypes(
    snapshot.documents,
    snapshot.requiredDocumentTypes,
    snapshot.today,
  );

  const employee: Record<OnboardingEmployeeItem, OnboardingItemState> = {
    password: doneIf(!core.temporaryPassword),
    personalInfo: doneIf(allFilled(filled, ONBOARDING_REQUIRED_FIELDS.personalInfo)),
    emergencyContact: doneIf(allFilled(filled, ONBOARDING_REQUIRED_FIELDS.emergencyContact)),
    governmentIds: verifiedGroupState(
      allFilled(filled, ONBOARDING_REQUIRED_FIELDS.governmentIds),
      snapshot.governmentIdsVerified,
    ),
    bankAccount: verifiedGroupState(
      allFilled(filled, ONBOARDING_REQUIRED_FIELDS.bankAccount),
      snapshot.bankAccountVerified,
    ),
    documents: doneIf(missingDocuments.length === 0),
    photo: doneIf(core.hasPhoto),
    eSignature: eSignatureItemState(snapshot.hasESignature),
  };
  const hr: Record<OnboardingHrItem, OnboardingItemState> = {
    moduleAccess: doneIf(!core.needsAccess),
    department: doneIf(core.hasDepartment),
    position: doneIf(core.hasPosition),
    reportingTo: reportingToItemState({
      activeSupervisorCount: core.activeSupervisorCount,
      isBoardMember: core.isBoardMember,
      noSupervisorConfirmed: snapshot.noSupervisorConfirmed,
    }),
    employmentStatus: doneIf(core.hasEmploymentStatus),
    workSchedule: 'done',
    workRegion: 'done',
    compensation: doneIf(snapshot.hasCompensation),
    assets: 'placeholder',
  };

  const details: Partial<Record<OnboardingItemKey, string>> = {
    workSchedule: snapshot.ownWorkSchedule ? 'Own schedule' : 'Company default',
    workRegion: WORK_REGION_LABELS[snapshot.workRegion],
    assets: ASSETS_PLACEHOLDER_NOTE,
  };
  if (missingDocuments.length > 0) {
    details.documents = `Needed: ${missingDocuments.map((type) => DOCUMENT_201_TYPE_LABELS[type]).join(', ')}`;
  }
  if (core.activeSupervisorCount === 0 && !core.isBoardMember && snapshot.noSupervisorConfirmed) {
    details.reportingTo = 'No supervisor (confirmed)';
  }

  const item = (key: OnboardingItemKey, state: OnboardingItemState): OnboardingItemStatus => ({
    key,
    label: ONBOARDING_ITEM_LABELS[key],
    state,
    detail: details[key] ?? null,
  });
  const employeeItems = ONBOARDING_EMPLOYEE_ITEMS.map((key) => item(key, employee[key]));
  const hrItems = ONBOARDING_HR_ITEMS.map((key) => item(key, hr[key]));
  const counted = hrItems.filter((entry) => entry.state !== 'placeholder');

  return {
    employeeItems,
    hrItems,
    states: { ...employee, ...hr },
    employeeProgress: {
      done: employeeItems.filter((entry) => entry.state !== 'todo').length,
      total: employeeItems.length,
    },
    hrProgress: {
      done: counted.filter((entry) => entry.state === 'done').length,
      total: counted.length,
    },
    complete: [...employeeItems, ...counted].every((entry) => entry.state === 'done'),
    showReminder: employeeItems.some((entry) => entry.state === 'todo'),
  };
}

/** "5 of 8 done". */
export function onboardingProgressText(progress: OnboardingProgress): string {
  return `${progress.done} of ${progress.total} done`;
}

/** The toolbar pill: "Onboarding 5 of 8". */
export function onboardingPillText(progress: OnboardingProgress): string {
  return `Onboarding ${progress.done} of ${progress.total}`;
}
