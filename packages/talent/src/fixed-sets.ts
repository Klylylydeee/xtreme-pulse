// Spec: docs/DATA_MODEL.md#collection-ownership ("The Talent employee record") and
// docs/CODE_STYLE.md — Pulse Talent's fixed sets for the employee record (build step 2.1). Pure
// code, safe in the browser: the forms and the models use the same lists.

/** `employeeRecords.sex`. */
export const SEXES = ['male', 'female'] as const;
export type Sex = (typeof SEXES)[number];
export const SEX_LABELS: Record<Sex, string> = { male: 'Male', female: 'Female' };

/** `employeeRecords.civilStatus`. */
export const CIVIL_STATUSES = ['single', 'married', 'widowed', 'separated', 'annulled'] as const;
export type CivilStatus = (typeof CIVIL_STATUSES)[number];
export const CIVIL_STATUS_LABELS: Record<CivilStatus, string> = {
  single: 'Single',
  married: 'Married',
  widowed: 'Widowed',
  separated: 'Legally separated',
  annulled: 'Annulled',
};

/**
 * `employeeRecords.workRegion`, for the minimum wage check: the 18 Philippine regions, Negros
 * Island Region included. *Assumption, to be confirmed by HR or counsel*
 * (docs/modules/talent.md#the-employee-record-build-step-21).
 */
export const WORK_REGIONS = [
  'NCR',
  'CAR',
  'I',
  'II',
  'III',
  'IV-A',
  'MIMAROPA',
  'V',
  'VI',
  'NIR',
  'VII',
  'VIII',
  'IX',
  'X',
  'XI',
  'XII',
  'XIII',
  'BARMM',
] as const;
export type WorkRegion = (typeof WORK_REGIONS)[number];
/** The company's region, and every record's default (docs/modules/talent.md#employment). */
export const DEFAULT_WORK_REGION: WorkRegion = 'NCR';
export const WORK_REGION_LABELS: Record<WorkRegion, string> = {
  NCR: 'National Capital Region (NCR)',
  CAR: 'Cordillera Administrative Region (CAR)',
  I: 'Ilocos Region (Region I)',
  II: 'Cagayan Valley (Region II)',
  III: 'Central Luzon (Region III)',
  'IV-A': 'CALABARZON (Region IV-A)',
  MIMAROPA: 'MIMAROPA Region',
  V: 'Bicol Region (Region V)',
  VI: 'Western Visayas (Region VI)',
  NIR: 'Negros Island Region (NIR)',
  VII: 'Central Visayas (Region VII)',
  VIII: 'Eastern Visayas (Region VIII)',
  IX: 'Zamboanga Peninsula (Region IX)',
  X: 'Northern Mindanao (Region X)',
  XI: 'Davao Region (Region XI)',
  XII: 'SOCCSKSARGEN (Region XII)',
  XIII: 'Caraga (Region XIII)',
  BARMM: 'Bangsamoro Autonomous Region in Muslim Mindanao (BARMM)',
};

/**
 * `employeeRecords.bankAccount.bank`: UnionBank or RCBC only, a fixed set because the spec names
 * them (docs/modules/talent.md#payroll-bank-account).
 */
export const PAYROLL_BANKS = ['unionbank', 'rcbc'] as const;
export type PayrollBank = (typeof PAYROLL_BANKS)[number];
export const PAYROLL_BANK_LABELS: Record<PayrollBank, string> = {
  unionbank: 'UnionBank',
  rcbc: 'RCBC',
};

/** `compensationEntries.rateType`. For a daily-rated employee the amount is the daily rate. */
export const RATE_TYPES = ['monthly', 'daily'] as const;
export type RateType = (typeof RATE_TYPES)[number];
export const RATE_TYPE_LABELS: Record<RateType, string> = {
  monthly: 'Monthly-rated',
  daily: 'Daily-rated',
};

// Step 2.2 (docs/DATA_MODEL.md#collection-ownership, "Documents, photo, e-signature and
// certifications"; decision 178 in docs/BUILD_PLAN.md).

/**
 * `employeeDocuments.type`, the 201 file's document types. *Assumption, to be confirmed by HR*
 * (docs/modules/talent.md#documents-photo-e-signature-and-certifications-build-step-22).
 */
export const DOCUMENT_201_TYPES = [
  'employmentContract',
  'regularizationEvaluation',
  'governmentIdCopy',
  'nbiClearance',
  'medicalCertificate',
  'diplomaTor',
  'other',
] as const;
export type Document201Type = (typeof DOCUMENT_201_TYPES)[number];
export const DOCUMENT_201_TYPE_LABELS: Record<Document201Type, string> = {
  employmentContract: 'Employment contract',
  regularizationEvaluation: 'Regularization evaluation',
  governmentIdCopy: 'Government ID copy',
  nbiClearance: 'NBI clearance',
  medicalCertificate: 'Medical certificate',
  diplomaTor: 'Diploma or TOR',
  other: 'Other document',
};

/**
 * The reveal category of a 201 document (decision 179): a medical certificate is `medical`, every
 * other document `file201`.
 */
export type Document201Category = 'file201' | 'medical';
export function documentCategoryOf(type: Document201Type): Document201Category {
  return type === 'medicalCertificate' ? 'medical' : 'file201';
}

/** `signatureApplications.purpose`: what an e-signature was applied for (`approval` in step 2.2). */
export const SIGNATURE_PURPOSES = ['approval'] as const;
export type SignaturePurpose = (typeof SIGNATURE_PURPOSES)[number];

/** A certification's status in the read services (decision 184). */
export const CERTIFICATION_STATUSES = ['current', 'expiring', 'expired'] as const;
export type CertificationStatus = (typeof CERTIFICATION_STATUSES)[number];

// Step 2.6 (docs/DATA_MODEL.md#collection-ownership, "Onboarding and change requests"; decisions
// 269 and 272 in docs/BUILD_PLAN.md).

/**
 * `changeRequests.section`: the part of the employee's own record one change request covers. The
 * on-screen Personal section holds both `contact` and `personal`.
 */
export const CHANGE_REQUEST_SECTIONS = [
  'contact',
  'skills',
  'personal',
  'governmentIds',
  'bankAccount',
] as const;
export type ChangeRequestSection = (typeof CHANGE_REQUEST_SECTIONS)[number];
export const CHANGE_REQUEST_SECTION_LABELS: Record<ChangeRequestSection, string> = {
  contact: 'Contact details',
  skills: 'Skills',
  personal: 'Personal details',
  governmentIds: 'Government IDs',
  bankAccount: 'Payroll bank account',
};

/**
 * `changeRequests.status`. `pending` → `approved` (applied), `returned` or `rejected`; a returned
 * request is sent again (back to `pending`) or `cancelled`. Approved, rejected and cancelled are
 * final.
 */
export const CHANGE_REQUEST_STATUSES = [
  'pending',
  'returned',
  'approved',
  'rejected',
  'cancelled',
] as const;
export type ChangeRequestStatus = (typeof CHANGE_REQUEST_STATUSES)[number];
export const CHANGE_REQUEST_STATUS_LABELS: Record<ChangeRequestStatus, string> = {
  pending: 'Waiting for approval',
  returned: 'Returned',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};
/** The open statuses: at most one open request per employee per section. */
export const OPEN_CHANGE_REQUEST_STATUSES = [
  'pending',
  'returned',
] as const satisfies readonly ChangeRequestStatus[];
export function isOpenChangeRequestStatus(status: ChangeRequestStatus): boolean {
  return (OPEN_CHANGE_REQUEST_STATUSES as readonly ChangeRequestStatus[]).includes(status);
}
