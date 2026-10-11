import { Types } from 'mongoose';
import { connectDb, withTransaction } from '@pulse/db';
import {
  ActionError,
  type BusinessDate,
  businessToday,
  startOfBusinessDate,
  toBusinessDate,
} from '@pulse/core';
import {
  encryptSensitive,
  getEmployeeIdentity,
  recordAudit,
  reloadActorAccess,
  snapshotForAudit,
} from '@pulse/core/server';
import {
  compareCompensationEntries,
  compensationStatuses,
  latestEffectiveDate,
} from '../../compensation';
import { SALARY_MASK } from '../../formats';
import { type CompensationEntryInput, compensationEntrySchema } from '../../validation';
import {
  BASIC_SALARY_FIELD,
  COMPENSATION_ENTRY_TYPE,
  type CompensationEntryView,
  type CompensationSectionView,
} from '../../views';
import { inputError } from '../input';
import {
  assertCanChangeSensitiveDetails,
  assertCanEditEmployeeRecord,
  type TalentActor,
} from '../policy';
import { type CompensationEntryDocument, CompensationEntryModel } from './model';

// Spec: docs/modules/talent.md#the-employee-record-build-step-21 and
// docs/DATA_MODEL.md#collection-ownership (decision 163 in docs/BUILD_PLAN.md) — a salary change
// is a new compensation entry, never an edit. Adding one follows the sensitive-change rule
// (policy.ts), in one transaction with its `create` audit entry (labelled
// `<employee number> · <effective date>`; the salary is hidden in the snapshot). The effective
// date is on or after the date hired and at most a year ahead. Allowances and the minimum wage
// warning come in step 2.3.
//
// The Compensation section is built only for a viewer who may reveal `salary` (the record
// service checks that); even then the amount is sent masked with no digits ("••••"). The full
// amount reaches the browser only through the audit-logged reveal.

const EMPLOYEE_GONE = 'This employee no longer exists. Reload the page.';

/** Which of `employeeIds` have at least one compensation entry, as ids. */
export async function hasCompensationEntries(employeeIds: Types.ObjectId[]): Promise<Set<string>> {
  if (employeeIds.length === 0) return new Set();
  await connectDb();
  const ids = (await CompensationEntryModel.distinct('employeeId', {
    employeeId: { $in: employeeIds },
  })) as Types.ObjectId[];
  return new Set(ids.map((id) => id.toHexString()));
}

type EntryRow = Omit<CompensationEntryDocument, 'basicSalaryCentavos'>;

async function loadEntries(employeeId: string): Promise<EntryRow[]> {
  await connectDb();
  // The encrypted salary is never selected here: the view shows it masked with no digits.
  return CompensationEntryModel.find({ employeeId: new Types.ObjectId(employeeId) })
    .sort({ effectiveDate: -1, createdAt: -1, _id: -1 })
    .lean();
}

/** The Compensation section of `employeeId`'s record on `today`. The caller checks the viewer. */
export async function buildCompensationSection(
  employeeId: string,
  today: BusinessDate,
): Promise<CompensationSectionView> {
  const rows = await loadEntries(employeeId);
  const timeline = rows.map((row) => ({
    row,
    id: row._id.toHexString(),
    effectiveDate: toBusinessDate(row.effectiveDate),
    createdAt: row.createdAt,
  }));
  const statuses = compensationStatuses(timeline, today);
  const entries = timeline
    .sort(compareCompensationEntries)
    .map(({ row, id, effectiveDate }): CompensationEntryView => ({
      id,
      effectiveDate,
      basicSalary: {
        mask: SALARY_MASK,
        ownerType: COMPENSATION_ENTRY_TYPE,
        ownerId: id,
        field: BASIC_SALARY_FIELD,
      },
      rateType: row.rateType,
      minimumWageEarner: row.minimumWageEarner,
      reason: row.reason,
      status: statuses.get(id) ?? 'previous',
      createdAt: row.createdAt,
    }));
  return { current: entries.find((entry) => entry.status === 'current') ?? null, entries };
}

/**
 * Adds a compensation entry (a salary change or a same-date correction): Talent Write and HR or
 * the System Administrator; for an HR-department employee, Talent Write and the System
 * Administrator or a Board member; never one's own. Accounting is always refused.
 */
export async function addCompensationEntry(
  actor: TalentActor,
  input: CompensationEntryInput,
): Promise<{ id: string }> {
  const parsed = compensationEntrySchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const values = parsed.data;

  // Before anything is encrypted: the same checks the transaction makes again.
  assertCanEditEmployeeRecord(actor, { employeeId: values.employeeId, departmentCode: null });
  await connectDb();
  const known = await getEmployeeIdentity(actor, values.employeeId, { separated: true });
  if (!known) throw new ActionError(EMPLOYEE_GONE);
  assertCanChangeSensitiveDetails(actor, {
    employeeId: known.employeeId,
    departmentCode: known.department?.code ?? null,
  });

  const encrypted = await encryptSensitive(values.basicSalaryCentavos);
  return withTransaction(async (session) => {
    const current = await reloadActorAccess({ id: actor.id }, session);
    const identity = await getEmployeeIdentity(current, values.employeeId, {
      separated: true,
      session,
    });
    if (!identity) throw new ActionError(EMPLOYEE_GONE);
    assertCanChangeSensitiveDetails(current, {
      employeeId: identity.employeeId,
      departmentCode: identity.department?.code ?? null,
    });

    if (values.effectiveDate < identity.dateHired) {
      throw new ActionError('The effective date can’t be before the date hired.', {
        field: 'effectiveDate',
      });
    }
    if (values.effectiveDate > latestEffectiveDate(businessToday())) {
      throw new ActionError('The effective date can be at most a year from today.', {
        field: 'effectiveDate',
      });
    }

    const entry = new CompensationEntryModel({
      employeeId: new Types.ObjectId(identity.employeeId),
      effectiveDate: startOfBusinessDate(values.effectiveDate),
      basicSalaryCentavos: encrypted,
      rateType: values.rateType,
      minimumWageEarner: values.minimumWageEarner,
      reason: values.reason,
      createdBy: current.id,
      updatedBy: current.id,
    });
    await entry.save({ session });
    await recordAudit(
      {
        actorId: current.id,
        actorEmail: current.email,
        module: 'talent',
        action: 'create',
        record: {
          type: COMPENSATION_ENTRY_TYPE,
          id: entry._id,
          label: `${identity.employeeNumber} · ${values.effectiveDate}`,
        },
        before: null,
        after: snapshotForAudit(CompensationEntryModel, entry),
        reason: values.reason,
      },
      { session },
    );
    return { id: entry._id.toHexString() };
  });
}
