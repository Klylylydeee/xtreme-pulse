import { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { toBusinessDate } from '@pulse/core';
import {
  employeeAuditLabel,
  getSensitiveSubject,
  listConfigVersions,
  registerSensitiveReveal,
  type SensitiveCategory,
} from '@pulse/core/server';
import {
  BANK_ACCOUNT_NUMBER_FIELD,
  BASIC_SALARY_FIELD,
  COMPENSATION_ENTRY_TYPE,
  EMPLOYEE_RECORD_TYPE,
} from '../../views';
import { ALLOWANCE_AMOUNT_FIELD, ALLOWANCE_ASSIGNMENT_TYPE } from '../../payroll/views';
import { AllowanceAssignmentModel } from '../allowances/model';
import { ALLOWANCE_TYPES_SETTING } from '../payroll-settings/settings';
import { CompensationEntryModel } from '../compensation/model';
import { EmployeeRecordModel } from '../employee-records/model';
import { ChangeRequestModel } from '../change-requests/model';
import { CHANGE_REQUEST_TYPE } from '../change-requests/service';
import { changeRequestAuditLabel } from '../../onboarding/change-requests';

// Spec: SECURITY.md#sensitive-data ("Registered reveals", decision 166 in docs/BUILD_PLAN.md) —
// Talent's revealable fields. The reveal Server Action calls `registerTalentSensitiveReveals()`
// before `revealSensitiveField`, which then checks the reveal rules for the user and this
// record's employee (read live from Core: the employee and their current department, for the
// Board rule), writes the `reveal` entry (module `talent`, the field name only) and only then
// decrypts. An explicit call, never an import side effect (docs/ARCHITECTURE.md#modules-and-packages).

/** The revealable fields of `talent.employeeRecord`, with their stored paths. */
const EMPLOYEE_RECORD_FIELDS: Record<string, { path: string; category: SensitiveCategory }> = {
  tin: { path: 'governmentIds.tin', category: 'governmentId' },
  sss: { path: 'governmentIds.sss', category: 'governmentId' },
  philhealth: { path: 'governmentIds.philhealth', category: 'governmentId' },
  pagibig: { path: 'governmentIds.pagibig', category: 'governmentId' },
  [BANK_ACCOUNT_NUMBER_FIELD]: { path: 'bankAccount.accountNumber', category: 'bankAccount' },
};

/**
 * The revealable fields of `talent.changeRequest` (step 2.6): each sensitive value of `proposed`
 * and of `previous`, by its stored path.
 */
const CHANGE_REQUEST_FIELDS: Record<string, SensitiveCategory> = Object.fromEntries(
  (['proposed', 'previous'] as const).flatMap((group) => [
    ...(['tin', 'sss', 'philhealth', 'pagibig'] as const).map((field) => [
      `${group}.${field}`,
      'governmentId' as const,
    ]),
    [`${group}.accountNumber`, 'bankAccount' as const],
  ]),
);

async function changeRequestOf(ownerId: string) {
  const id = objectIdOf(ownerId);
  if (!id) return null;
  await connectDb();
  return ChangeRequestModel.findById(id, { employeeId: 1, section: 1 }).lean();
}

function objectIdOf(id: string): Types.ObjectId | null {
  return Types.ObjectId.isValid(id) && /^[a-f\d]{24}$/i.test(id) ? new Types.ObjectId(id) : null;
}

/** The value at a dotted `path` of a lean record. */
function valueAt(record: unknown, path: string): unknown {
  let value: unknown = record;
  for (const key of path.split('.')) {
    if (value === null || typeof value !== 'object') return null;
    value = (value as Record<string, unknown>)[key];
  }
  return value ?? null;
}

async function recordEmployeeId(ownerId: string): Promise<Types.ObjectId | null> {
  const id = objectIdOf(ownerId);
  if (!id) return null;
  await connectDb();
  const record = await EmployeeRecordModel.findById(id, { employeeId: 1 }).lean();
  return record?.employeeId ?? null;
}

async function entryEmployee(
  ownerId: string,
): Promise<{ employeeId: Types.ObjectId; effectiveDate: Date } | null> {
  const id = objectIdOf(ownerId);
  if (!id) return null;
  await connectDb();
  return CompensationEntryModel.findById(id, { employeeId: 1, effectiveDate: 1 }).lean();
}

/** A type's name in the newest `talent.allowanceTypes` version (keys are never removed), or the key. */
async function allowanceTypeName(typeKey: string): Promise<string> {
  const [latest] = await listConfigVersions(ALLOWANCE_TYPES_SETTING);
  return latest?.value.types.find((type) => type.key === typeKey)?.name ?? typeKey;
}

async function assignmentEmployee(
  ownerId: string,
): Promise<{ employeeId: Types.ObjectId; effectiveDate: Date; typeKey: string } | null> {
  const id = objectIdOf(ownerId);
  if (!id) return null;
  await connectDb();
  return AllowanceAssignmentModel.findById(id, {
    employeeId: 1,
    effectiveDate: 1,
    typeKey: 1,
  }).lean();
}

/**
 * Registers Talent's reveals (from step 2.6 also `talent.changeRequest`: `proposed.<field>` and
 * `previous.<field>` for the government IDs as `governmentId` and the account number as
 * `bankAccount`, labelled `<employee number> · <section>`): `talent.employeeRecord` (`tin`,
 * `sss`, `philhealth`, `pagibig` as `governmentId`, `bankAccountNumber` as `bankAccount`) and `talent.compensationEntry`
 * (`basicSalary` as `salary`), and from step 2.3 `talent.allowanceAssignment` (`amount` as
 * `allowances`). Safe to call on every request.
 */
export function registerTalentSensitiveReveals(): void {
  registerSensitiveReveal(EMPLOYEE_RECORD_TYPE, {
    module: 'talent',
    fields: Object.fromEntries(
      Object.entries(EMPLOYEE_RECORD_FIELDS).map(([field, { category }]) => [field, category]),
    ),
    async loadValue(ownerId, field) {
      const known = EMPLOYEE_RECORD_FIELDS[field];
      const id = objectIdOf(ownerId);
      if (!known || !id) return null;
      await connectDb();
      const record = await EmployeeRecordModel.findById(id).select(`+${known.path}`).lean();
      return record ? valueAt(record, known.path) : null;
    },
    async subject(ownerId) {
      const employeeId = await recordEmployeeId(ownerId);
      return employeeId ? getSensitiveSubject(employeeId) : null;
    },
    async label(ownerId) {
      const employeeId = await recordEmployeeId(ownerId);
      const employee = employeeId ? await employeeAuditLabel(employeeId) : null;
      return employee ? `${employee.employeeNumber} · ${employee.name}` : null;
    },
  });

  registerSensitiveReveal(CHANGE_REQUEST_TYPE, {
    module: 'talent',
    fields: CHANGE_REQUEST_FIELDS,
    async loadValue(ownerId, field) {
      const id = objectIdOf(ownerId);
      if (!Object.hasOwn(CHANGE_REQUEST_FIELDS, field) || !id) return null;
      await connectDb();
      const request = await ChangeRequestModel.findById(id).select(`+${field}`).lean();
      return request ? valueAt(request, field) : null;
    },
    async subject(ownerId) {
      const request = await changeRequestOf(ownerId);
      return request ? getSensitiveSubject(request.employeeId) : null;
    },
    async label(ownerId) {
      const request = await changeRequestOf(ownerId);
      const employee = request ? await employeeAuditLabel(request.employeeId) : null;
      return request && employee
        ? changeRequestAuditLabel(employee.employeeNumber, request.section)
        : null;
    },
  });

  registerSensitiveReveal(COMPENSATION_ENTRY_TYPE, {
    module: 'talent',
    fields: { [BASIC_SALARY_FIELD]: 'salary' },
    async loadValue(ownerId, field) {
      const id = objectIdOf(ownerId);
      if (field !== BASIC_SALARY_FIELD || !id) return null;
      await connectDb();
      const entry = await CompensationEntryModel.findById(id).select('+basicSalaryCentavos').lean();
      return entry?.basicSalaryCentavos ?? null;
    },
    async subject(ownerId) {
      const entry = await entryEmployee(ownerId);
      return entry ? getSensitiveSubject(entry.employeeId) : null;
    },
    async label(ownerId) {
      const entry = await entryEmployee(ownerId);
      if (!entry) return null;
      const employee = await employeeAuditLabel(entry.employeeId);
      return employee
        ? `${employee.employeeNumber} · ${toBusinessDate(entry.effectiveDate)}`
        : null;
    },
  });

  registerSensitiveReveal(ALLOWANCE_ASSIGNMENT_TYPE, {
    module: 'talent',
    fields: { [ALLOWANCE_AMOUNT_FIELD]: 'allowances' },
    async loadValue(ownerId, field) {
      const id = objectIdOf(ownerId);
      if (field !== ALLOWANCE_AMOUNT_FIELD || !id) return null;
      await connectDb();
      const entry = await AllowanceAssignmentModel.findById(id).select('+amountCentavos').lean();
      return entry?.amountCentavos ?? null;
    },
    async subject(ownerId) {
      const entry = await assignmentEmployee(ownerId);
      return entry ? getSensitiveSubject(entry.employeeId) : null;
    },
    async label(ownerId) {
      const entry = await assignmentEmployee(ownerId);
      if (!entry) return null;
      const employee = await employeeAuditLabel(entry.employeeId);
      return employee
        ? `${employee.employeeNumber} · ${await allowanceTypeName(entry.typeKey)} · ${toBusinessDate(entry.effectiveDate)}`
        : null;
    },
  });
}
