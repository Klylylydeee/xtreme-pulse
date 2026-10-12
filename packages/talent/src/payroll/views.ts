import type { BusinessDate, Centavos } from '@pulse/core';
import type { WorkRegion } from '../fixed-sets';
import type { MaskedAmountView } from '../views';
import type { AllowanceAssignmentKind, AllowanceEntryStatus } from './allowances';
import type {
  AllowanceBasis,
  AllowanceTaxTreatment,
  PayrollSettingKey,
  PayrollSettingValues,
} from './schemas';

// Spec: docs/modules/talent.md#payroll-settings-and-allowances-build-step-23 — what the payroll
// settings and allowance services send to the pages. Types and names only, safe in the browser.

/** An allowance assignment's audit and reveal record type. */
export const ALLOWANCE_ASSIGNMENT_TYPE = 'talent.allowanceAssignment';
/** The revealable field of `talent.allowanceAssignment` (category `allowances`). */
export const ALLOWANCE_AMOUNT_FIELD = 'amount';
/** The note on a seeded version. */
export const SEEDED_VERSION_NOTE =
  'Seeded: check against the current issuance before the first payroll.';
/** The confirmation "Add version" asks for before saving. */
export const ADD_VERSION_CONFIRMATION =
  'Versions can’t be changed or withdrawn once added. Check every figure against the issuance.';

export type PayrollVersionStatus = 'inEffect' | 'scheduled' | 'past';

/** One version of a payroll setting. */
export interface PayrollSettingVersionView<K extends PayrollSettingKey = PayrollSettingKey> {
  id: string;
  effectiveFrom: BusinessDate;
  value: PayrollSettingValues[K];
  source: string | null;
  /** True for a version `pnpm seed:admin` added: show `SEEDED_VERSION_NOTE`. */
  seeded: boolean;
  status: PayrollVersionStatus;
}

/** One setting on /talent/payroll-settings. */
export interface PayrollSettingView<K extends PayrollSettingKey = PayrollSettingKey> {
  key: K;
  label: string;
  /** The version in effect today ("In effect since <date>"), or null. */
  inEffect: PayrollSettingVersionView<K> | null;
  /** Versions taking effect after today, soonest first. */
  scheduled: PayrollSettingVersionView<K>[];
  /** Every version, newest first (read-only history). */
  history: PayrollSettingVersionView<K>[];
  /** The earliest effective date "Add version" accepts (the day after the latest version), or null for any. */
  earliestEffectiveFrom: BusinessDate | null;
  /** The latest effective date "Add version" accepts (one year from today). */
  latestEffectiveFrom: BusinessDate;
}

/** The count of active employees below one minimum wage version, per region in it. */
export interface MinimumWageBelowCount {
  versionId: string;
  region: WorkRegion;
  /** The day compared: the later of the version's effective date and today. */
  checkedOn: BusinessDate;
  count: number;
}

export interface PayrollSettingsView {
  today: BusinessDate;
  /** Talent Owner and HR or the System Administrator: "Add version". */
  canAddVersion: boolean;
  settings: { [K in PayrollSettingKey]: PayrollSettingView<K> };
  /**
   * Present only for Talent Read and HR, Accounting or the System Administrator: for each
   * `talent.minimumWages` version and region, the count of active employees paid below it.
   */
  minimumWageBelow?: MinimumWageBelowCount[];
}

/** One row of the wage order list: no amounts. */
export interface BelowMinimumWageRow {
  employeeId: string;
  name: string;
  employeeNumber: string;
  department: { id: string; name: string; code: string } | null;
  position: { id: string; name: string } | null;
  /** `/talent?employee=<id>`. */
  href: string;
}

export interface BelowMinimumWageList {
  versionId: string;
  region: WorkRegion;
  wageOrder: string;
  checkedOn: BusinessDate;
  rows: BelowMinimumWageRow[];
}

// ---------------------------------------------------------------------------------------------
// Allowances on the employee record

/** An allowance type the "Assign allowance" sheet offers. */
export interface AssignableAllowanceType {
  key: string;
  name: string;
  basis: AllowanceBasis;
  taxTreatment: AllowanceTaxTreatment;
  /** The company default, not sensitive. */
  defaultAmountCentavos: Centavos;
  autoAssign: boolean;
  /** False: can be ended but not newly set. */
  active: boolean;
}

/** One allowance in effect (or starting with the date hired). */
export interface AllowanceLineView {
  typeKey: string;
  name: string;
  basis: AllowanceBasis | null;
  taxTreatment: AllowanceTaxTreatment | null;
  origin: 'automatic' | 'assigned';
  /** The automatic line's company default, unmasked. */
  defaultAmountCentavos?: Centavos;
  /** An assigned amount, masked ("••••") until revealed. */
  amount?: MaskedAmountView;
  /** "Automatic from <date hired>" or the entry's effective date. */
  since: BusinessDate;
  /** True when `since` is after today ("Starts 3 Nov 2026"). */
  upcoming: boolean;
}

/** One explicit allowance assignment in the history. */
export interface AllowanceAssignmentView {
  id: string;
  typeKey: string;
  typeName: string;
  effectiveDate: BusinessDate;
  kind: AllowanceAssignmentKind;
  /** Masked; null for `end`. */
  amount: MaskedAmountView | null;
  reason: string;
  status: AllowanceEntryStatus;
  createdAt: Date;
}

export interface AllowancesSectionView {
  /** The day the lines are for: today, or the date hired when that is later. */
  asOf: BusinessDate;
  lines: AllowanceLineView[];
  /** Every explicit entry, newest first. */
  history: AllowanceAssignmentView[];
  /** The types in the version in effect on `asOf`, for "Assign allowance". */
  types: AssignableAllowanceType[];
}
