import type { BusinessDate, EmploymentStatus } from '@pulse/core';
import type { EmployeeIdentity } from '@pulse/core/server';
import type { CompensationStatus } from './compensation';
import type { ExpiryState } from './derived';
import type {
  CertificationStatus,
  CivilStatus,
  Document201Category,
  Document201Type,
  PayrollBank,
  RateType,
  Sex,
  WorkRegion,
} from './fixed-sets';

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
  /** Change and Remove on the profile photo (Core's rule: the employee, HR, the System Administrator). */
  changePhoto: boolean;
  /** Upload, Edit and Archive on the 201 file (Talent Write and HR or the System Administrator). */
  manageDocuments: boolean;
  /** Add certification (Talent Write, never one's own record). */
  addCertification: boolean;
  /** Edit on a certification (as above). */
  editCertification: boolean;
  /** Remove on a certification (Talent Owner, never one's own record). */
  removeCertification: boolean;
  /** The Skills Edit sheet (Talent Write, never one's own record). */
  editSkills: boolean;
  /** Upload or Replace the e-signature: the owner only, on /talent/me. */
  uploadESignature: boolean;
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
  /**
   * The 201 file, present only for a viewer who may see at least one of its categories (decision
   * 179): every document of the categories they may see, archived ones included ("Show
   * archived"), newest first. Absent for anyone else: no list, count or "has documents" flag.
   */
  documents?: EmployeeDocumentView[];
  /**
   * `DOCUMENTS_NOTICE` when `documents` is left out, or `MEDICAL_DOCUMENTS_NOTICE` when medical
   * certificates are left out of it (Accounting). Absent when nothing is left out.
   */
  documentsNotice?: string;
  /** The current profile photo (`/files/<id>?inline=1`), or null. */
  photoUrl: string | null;
  /** The e-signature status (everyone); its image only for the owner and the System Administrator. */
  eSignature: ESignatureStatusView;
  /** The skills tags, in the saved order. */
  skills: string[];
  /** The certifications (removed ones left out), latest issue date first. */
  certifications: CertificationView[];
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
  /** The current profile photo (`/files/<id>?inline=1`), or null for the initials (step 2.2). */
  photoUrl: string | null;
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

// ---------------------------------------------------------------------------------------------
// Step 2.2: the 201 file, the e-signature, certifications and their read services
// (docs/modules/talent.md#documents-photo-e-signature-and-certifications-build-step-22).

/** A 201 document's audit record type and file owner type. */
export const EMPLOYEE_DOCUMENT_TYPE = 'talent.employeeDocument';
/** An e-signature version's audit record type and file owner type. */
export const E_SIGNATURE_TYPE = 'talent.eSignature';
/** A use of an e-signature's audit record type. */
export const SIGNATURE_APPLICATION_TYPE = 'talent.signatureApplication';
/** A certification's audit record type and its attachment's file owner type. */
export const CERTIFICATION_TYPE = 'talent.certification';

/** One 201 document, for a viewer who may see its category. */
export interface EmployeeDocumentView {
  id: string;
  type: Document201Type;
  typeLabel: string;
  category: Document201Category;
  title: string | null;
  issueDate: BusinessDate;
  expiryDate: BusinessDate | null;
  /** The expiry badge, against the `talent.expiryAlerts` document lead days. */
  expiry: ExpiryState;
  /** The file route URL (`/files/<id>`). Every open is audit-logged. */
  fileUrl: string;
  uploadedAt: Date;
  /** The uploader's name when the viewer may read it, else null. */
  uploadedByName: string | null;
  archived: boolean;
  archivedAt: Date | null;
  archiveReason: string | null;
  /** Send back with Edit and Archive. */
  version: number;
}

/** The e-signature status on a record. */
export interface ESignatureStatusView {
  /** The current version ("E-signature on file, version N"), or null ("Not uploaded"). */
  version: number | null;
  /**
   * The current image (`/files/<id>?inline=1`), present only for the owner and the System
   * Administrator; null while there is none.
   */
  imageUrl?: string | null;
}

/** One version of the signed-in user's own e-signature (/talent/me's version history). */
export interface OwnESignatureVersionView {
  id: string;
  version: number;
  imageUrl: string;
  uploadedAt: Date;
  /** How many times this version was applied. */
  applicationCount: number;
  current: boolean;
}

/** One certification on the employee record. */
export interface CertificationView {
  id: string;
  name: string;
  issuer: string;
  /** The Core product; `name` is null when the product was retired. */
  product: { id: string; name: string | null } | null;
  licenseNumber: string | null;
  issueDate: BusinessDate;
  expiryDate: BusinessDate | null;
  /** The expiry badge, against the `talent.expiryAlerts` certification lead days. */
  expiry: ExpiryState;
  /** The attachment (`/files/<id>`), or null. */
  attachmentUrl: string | null;
  /** Send back with Edit and Remove. */
  version: number;
}

/**
 * One row of `listCertifications`, the read service for Pulse Ops and Pulse Engage (decision
 * 184): an allowlist, never the license number or the attachment.
 */
export interface CertificationReadRow {
  certificationId: string;
  employee: { employeeId: string; employeeNumber: string; name: string };
  name: string;
  issuer: string;
  product: { id: string; name: string | null } | null;
  issueDate: BusinessDate;
  expiryDate: BusinessDate | null;
  status: CertificationStatus;
  /** The employee's skills tags. */
  skills: string[];
}

/** One row of `countCertifiedEmployeesByBrand`. */
export interface CertifiedEmployeeCount {
  brandId: string;
  /** Employees (not separated) holding a certification for the product that is current on the date. */
  count: number;
}

/** The `talent.expiryAlerts` setting for the Settings sheet on /talent. */
export interface ExpiryAlertSettingsView {
  documentLeadDays: number;
  certificationLeadDays: number;
  /** The Manila day the values in effect started, or null while the defaults apply. */
  effectiveFrom: BusinessDate | null;
  /** True when a change already takes effect today: another one is refused until tomorrow. */
  changedToday: boolean;
  /** True for a Talent Owner (the Settings button). */
  canChange: boolean;
}
