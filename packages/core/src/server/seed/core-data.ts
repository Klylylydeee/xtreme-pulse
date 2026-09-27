import type { TimesheetType } from '../../timesheet-types';
import type { BirRegistration } from '../company-settings/model';

// Base data `pnpm seed:admin` loads into Core. After the first run these are ordinary records that
// HR and the System Administrator manage; the seed only adds what is missing.

export interface SeedDepartment {
  code: string;
  name: string;
}

export interface SeedPosition {
  /** Stable across renames: `<department code>.<camelCase name>`. */
  seedKey: string;
  departmentCode: string;
  name: string;
  timesheetType: TimesheetType;
}

// Spec: docs/modules/core.md#departments-and-positions
export const SEED_DEPARTMENTS: readonly SeedDepartment[] = [
  { code: 'HR', name: 'Human Resource' },
  { code: 'ACCT', name: 'Accounting' },
  { code: 'ADMIN', name: 'Office Administrator' },
  { code: 'NET', name: 'Network' },
  { code: 'POS', name: 'Point of Sales' },
  { code: 'SALES', name: 'Sales' },
  { code: 'DC', name: 'Data Center' },
  { code: 'BOD', name: 'Board of Directors' },
  { code: 'WEB', name: 'Web Administrator' },
];

function position(
  departmentCode: string,
  key: string,
  name: string,
  timesheetType: TimesheetType = 'standard',
): SeedPosition {
  return { seedKey: `${departmentCode}.${key}`, departmentCode, name, timesheetType };
}

// Spec: docs/modules/core.md#departments-and-positions for the positions, and
// docs/modules/talent.md#timesheet-types for the default types: overtime for Lead HVAC Technician,
// HVAC Technician and Driver, standard for all others.
export const SEED_POSITIONS: readonly SeedPosition[] = [
  position('HR', 'humanResourceOfficer', 'Human Resource Officer'),
  position('ACCT', 'accountingOfficer', 'Accounting Officer'),
  position('ACCT', 'accountsPayableOfficer', 'Accounts Payable Officer'),
  position('ACCT', 'accountsReceivableOfficer', 'Accounts Receivable Officer'),
  position('ADMIN', 'administrativeSpecialist', 'Administrative Specialist'),
  position('ADMIN', 'driver', 'Driver', 'overtime'),
  position('NET', 'leadPresalesEngineer', 'Lead Presales Engineer'),
  position('NET', 'leadPostsalesEngineer', 'Lead Postsales Engineer'),
  position('NET', 'presalesSupportEngineer', 'Presales Support Engineer'),
  position('POS', 'leadBusinessTechnologySupport', 'Lead Business Technology Support'),
  position('POS', 'technologySupport', 'Technology Support'),
  position('SALES', 'sales', 'Sales'),
  position('SALES', 'marketing', 'Marketing'),
  position('SALES', 'accountManager', 'Account Manager'),
  position('SALES', 'channelAccountManager', 'Channel Account Manager'),
  position('SALES', 'businessDevelopmentManager', 'Business Development Manager'),
  position('DC', 'headDataCenter', 'Head Data Center'),
  position('DC', 'mechanicalEngineer', 'Mechanical Engineer'),
  position('DC', 'leadHvacTechnician', 'Lead HVAC Technician', 'overtime'),
  position('DC', 'hvacTechnician', 'HVAC Technician', 'overtime'),
  position('BOD', 'managingDirector', 'Managing Director'),
  position('BOD', 'salesDirector', 'Sales Director'),
  position('BOD', 'operationsDirector', 'Operations Director'),
  position('BOD', 'strategicDirector', 'Strategic Director'),
  position('WEB', 'developer', 'Developer'),
];

export interface SeedCompanyDetails {
  registeredName: string;
  businessAddress: string;
  tin: string;
  rdoCode: string;
  sssEmployerNumber: string;
  philhealthEmployerNumber: string;
  pagibigEmployerId: string;
  birRegistration: BirRegistration;
}

// Spec: docs/modules/core.md#company-details-pending-from-the-client — marked placeholders until
// the client provides the details. The logo starts empty (`logoFileId: null`).
export const COMPANY_DETAIL_PLACEHOLDERS: SeedCompanyDetails = {
  registeredName: '[Registered company name]',
  businessAddress: '[Business address]',
  tin: '[Company TIN]',
  rdoCode: '[RDO code]',
  sssEmployerNumber: '[SSS employer number]',
  philhealthEmployerNumber: '[PhilHealth employer number]',
  pagibigEmployerId: '[Pag-IBIG employer ID]',
  birRegistration: {
    casPermitDetails: '[CAS/CBA acknowledgment or permit details]',
    invoiceSeries: '[Registered invoice number series]',
  },
};
