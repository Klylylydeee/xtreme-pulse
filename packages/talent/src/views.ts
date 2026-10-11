import type { BusinessDate, EmploymentStatus } from '@pulse/core';
import type { EmployeeIdentity } from '@pulse/core/server';
import type { CompensationStatus } from './compensation';
import type { CivilStatus, PayrollBank, RateType, Sex, WorkRegion } from './fixed-sets';

// Spec: docs/modules/talent.md#the-employee-record-build-step-21 and SECURITY.md#sensitive-data —
// what the employee record's services send to the pages. Types and names only, safe in the
// browser.
//
// The server builds each view for its viewer: a section, key or last 4 digits the viewer may not
// see is not in the object at all (decisions 158–160 in docs/BUILD_PLAN.md).

/** The employee record's audit and reveal record type. */
export const EMPLOYEE_RECORD_TYPE = 'talent.employeeRecord';
/** A compensation entry's audit and reveal record type. */
export const COMPENSATION_ENTRY_TYPE = 'talent.compensationEntry';

/** The revealable fields of `talent.employeeRecord` (decision 166). */
export const GOVERNMENT_ID_FIELDS = ['tin', 'sss', 'philhealth', 'pagibig'] as const;
export type GovernmentIdField = (typeof GOVERNMENT_ID_FIELDS)[number];
export const BANK_ACCOUNT_NUMBER_FIELD = 'bankAccountNumber';
/** The revealable field of `talent.compensationEntry`. */
export const BASIC_SALARY_FIELD = 'basicSalary';

/** What the Reveal button sends to the reveal Server Action (`revealSensitiveAction`). */
export interface RevealTarget {
  ownerType: string;
  ownerId: string;
  field: string;
}

/** A stored government ID or account number, masked: its last 4 digits, computed on the server. */
export interface MaskedDigitsView extends RevealTarget {
  lastFour: string;
}

/** A stored salary amount, masked with no digits at all (`SALARY_MASK`, "••••"). */
export interface MaskedAmountView extends RevealTarget {
  mask: string;
}

/** Core's identity, read-only in Talent ("Managed in Users"). */
export type RecordIdentity = EmployeeIdentity;

export interface PersonalSectionView {
  /**
   * Present only for HR, Accounting, the System Administrator and the employee (decision 159);
   * the key is absent for anyone else, Board members included.
   */
  dateOfBirth?: BusinessDate | null;
  /** As `dateOfBirth`. */
  civilStatus?: CivilStatus | null;
  sex: Sex | null;
  nationality: string | null;
  presentAddress: string | null;
  permanentAddress: string | null;
  mobileNumber: string | null;
  personalEmail: string | null;
  emergencyContact: {
    name: string | null;
    relationship: string | null;
    mobileNumber: string | null;
  } | null;
}

export interface EmploymentSectionView {
  workRegion: WorkRegion;
  contractEndDate: BusinessDate | null;
  regularizationDate: BusinessDate | null;
  separationRemarks: string | null;
  /** Derived: the date hired + 6 months while the status is Probationary, else null. */
  probationEndDate: BusinessDate | null;
  /** A Contractual employee with no contract end date. */
  contractEndDateMissing: boolean;
}

/** Each ID null when none is stored. */
export interface GovernmentIdsSectionView {
  tin: MaskedDigitsView | null;
  rdoCode: string | null;
  sss: MaskedDigitsView | null;
  philhealth: MaskedDigitsView | null;
  pagibig: MaskedDigitsView | null;
}

export interface BankAccountSectionView {
  bank: PayrollBank | null;
  accountNumber: MaskedDigitsView | null;
  accountName: string | null;
}

export interface CompensationEntryView {
  id: string;
  effectiveDate: BusinessDate;
  basicSalary: MaskedAmountView;
  rateType: RateType;
  minimumWageEarner: boolean;
  reason: string;
  status: CompensationStatus;
  createdAt: Date;
}

export interface CompensationSectionView {
  /** The current entry (also in `entries`), or null when none is effective yet. */
  current: CompensationEntryView | null;
  /** Every entry, newest first (by effective date, then by creation). */
  entries: CompensationEntryView[];
}

/** What the viewer may do on this record; each service checks again itself. */
export interface EmployeeRecordPermissions {
  /** The Personal sheet (Talent Write, never one's own record). */
  editPersonal: boolean;
  /** The date of birth and civil status inside it (also HR or the System Administrator). */
  editBirthAndCivilStatus: boolean;
  editEmployment: boolean;
  /** Government IDs, the bank account and "Add salary change" (the sensitive-change rule). */
  editGovernmentIds: boolean;
  editBankAccount: boolean;
  addCompensation: boolean;
}

export interface EmployeeRecordView {
  employeeId: string;
  identity: RecordIdentity;
  /** The `employeeRecords` id, the reveal's `ownerId`; null until the first save. */
  recordId: string | null;
  /** Send back with every section's form; 0 until the first save. */
  version: number;
  /** False shows the "Not filled in" badge. */
  filledIn: boolean;
  personal: PersonalSectionView;
  employment: EmploymentSectionView;
  /** Present only for a viewer who may reveal `salary` for this employee. */
  compensation?: CompensationSectionView;
  /** Present only for a viewer who may reveal `governmentId` for this employee. */
  governmentIds?: GovernmentIdsSectionView;
  /** Present only for a viewer who may reveal `bankAccount` for this employee. */
  bankAccount?: BankAccountSectionView;
  /** `RESTRICTED_SECTIONS_NOTICE`, present only when a section above was left out. */
  restrictedNotice?: string;
  can: EmployeeRecordPermissions;
  /** `/admin/users?q=<employee number>` for HR and the System Administrator, else null. */
  editInUsersHref: string | null;
  /** `/admin/access?user=<userId>` for HR and the System Administrator on an active employee. */
  manageAccessHref: string | null;
}

/** One row of the employee list. No sensitive field, date of birth or civil status. */
export interface EmployeeListRow {
  employeeId: string;
  userId: string | null;
  name: string;
  initials: string;
  employeeNumber: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  department: { id: string; name: string; code: string } | null;
  position: { id: string; name: string } | null;
  employmentStatus: EmploymentStatus;
  dateHired: BusinessDate;
  separated: boolean;
  active: boolean;
  /** False shows the "Not filled in" badge. */
  filledIn: boolean;
}

export interface EmployeeList {
  rows: EmployeeListRow[];
  /** The stat tiles: active (not separated) employees by employment status, whatever the filters. */
  stats: { status: EmploymentStatus; count: number }[];
}
