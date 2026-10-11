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
