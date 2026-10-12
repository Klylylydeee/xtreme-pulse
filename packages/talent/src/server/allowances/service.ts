import { type ClientSession, Types } from 'mongoose';
import { connectDb, withTransaction } from '@pulse/db';
import {
  AccessDeniedError,
  ActionError,
  type BusinessDate,
  businessToday,
  toBusinessDate,
} from '@pulse/core';
import {
  decryptSensitive,
  type EmployeeIdentity,
  encryptSensitive,
  getEmployeeIdentity,
  listConfigVersions,
  recordAudit,
  reloadActorAccess,
  snapshotForAudit,
} from '@pulse/core/server';
import { latestEffectiveDate } from '../../compensation';
import { SALARY_MASK } from '../../formats';
import {
  type AllowanceEntryTimeline,
  type AllowanceInEffect,
  allowanceEntryStatuses,
  compareAllowanceEntries,
  resolveAllowances,
} from '../../payroll/allowances';
import type { AllowanceType } from '../../payroll/schemas';
import { type AllowanceAssignmentInput, allowanceAssignmentSchema } from '../../payroll/validation';
import {
  ALLOWANCE_AMOUNT_FIELD,
  ALLOWANCE_ASSIGNMENT_TYPE,
  type AllowanceAssignmentView,
  type AllowanceLineView,
  type AllowancesSectionView,
} from '../../payroll/views';
import type { MaskedAmountView } from '../../views';
import { inputError } from '../input';
import { ALLOWANCE_TYPES_SETTING, payrollSettingVersionOn } from '../payroll-settings/settings';
import {
  assertCanChangeSensitiveDetails,
  assertCanEditEmployeeRecord,
  canSeeAllowances,
  type TalentActor,
} from '../policy';
import { auditLabelOf, EMPLOYEE_GONE, instantOf, targetOf } from '../shared';
import { AllowanceAssignmentModel } from './model';

// Spec: docs/modules/talent.md#payroll-settings-and-allowances-build-step-23 ("Allowance
// assignments"), docs/DATA_MODEL.md#collection-ownership and SECURITY.md#sensitive-data
// (decisions 202–204 in docs/BUILD_PLAN.md).
//
// - Automatic types are derived from Core's current date hired, never stored (resolveAllowances).
// - Explicit assignments are insert-only entries, added under the salary rule
//   (assertCanChangeSensitiveDetails), in one transaction with their `create` audit entry on
//   `talent.allowanceAssignment` (labelled `<employee number> · <type name> · <YYYY-MM-DD>`, the
//   amount hidden).
// - The section is built only for a viewer who may reveal `allowances` (the record service checks
//   it): the automatic line shows the company default unmasked, assigned amounts "••••".

const ALLOWANCES_DENIED = 'You don’t have access to this employee’s allowances.';

interface EntryRow {
  _id: Types.ObjectId;
  typeKey: string;
  effectiveDate: Date;
  kind: 'set' | 'end';
  reason: string;
  createdAt: Date;
  amountCentavos?: unknown;
}

async function loadEntries(
  employeeId: string,
  { withAmounts = false, session }: { withAmounts?: boolean; session?: ClientSession } = {},
): Promise<(AllowanceEntryTimeline & { reason: string })[]> {
  await connectDb();
  const query = AllowanceAssignmentModel.find({
    employeeId: new Types.ObjectId(employeeId),
  }).session(session ?? null);
  if (withAmounts) query.select('+amountCentavos');
  const rows = (await query.lean()) as EntryRow[];
  return Promise.all(
    rows.map(async (row) => {
      let amountCentavos: number | null = null;
      if (withAmounts && row.amountCentavos !== undefined && row.amountCentavos !== null) {
        const decrypted = await decryptSensitive(row.amountCentavos);
        amountCentavos = typeof decrypted === 'number' ? decrypted : null;
      }
      return {
        id: row._id.toHexString(),
        typeKey: row.typeKey,
        effectiveDate: toBusinessDate(row.effectiveDate),
        kind: row.kind,
        createdAt: row.createdAt,
        reason: row.reason,
        amountCentavos,
      };
    }),
  );
}

async function typesOn(day: BusinessDate, session?: ClientSession): Promise<AllowanceType[]> {
  return (
    (await payrollSettingVersionOn('talent.allowanceTypes', day, { session }))?.value.types ?? []
  );
}

/**
 * The allowances in effect on `day` for an employee whose date hired is `dateHired`, with the
 * assigned amounts decrypted (server-only: for later payroll steps, never for a page).
 */
export async function allowancesInEffectFor(
  { employeeId, dateHired }: { employeeId: string; dateHired: BusinessDate },
  day: BusinessDate,
  { session }: { session?: ClientSession } = {},
): Promise<AllowanceInEffect[]> {
  const [entries, types] = await Promise.all([
    loadEntries(employeeId, { withAmounts: true, session }),
    typesOn(day, session),
  ]);
  return resolveAllowances({ day, dateHired, types, entries });
}

/**
 * The allowances in effect on `day` for `employeeId`, amounts included (server-only, for the
 * payroll steps). Needs a viewer who may reveal `allowances` for that employee. Null when there is
 * no such employee.
 */
export async function allowancesInEffect(
  actor: TalentActor,
  employeeId: string,
  day: BusinessDate,
): Promise<AllowanceInEffect[] | null> {
  await connectDb();
  const identity = await getEmployeeIdentity(actor, employeeId, { separated: true });
  if (!identity) return null;
  if (!canSeeAllowances(actor, targetOf(identity))) throw new AccessDeniedError(ALLOWANCES_DENIED);
  return allowancesInEffectFor(identity, day);
}

function maskedAmount(id: string): MaskedAmountView {
  return {
    mask: SALARY_MASK,
    ownerType: ALLOWANCE_ASSIGNMENT_TYPE,
    ownerId: id,
    field: ALLOWANCE_AMOUNT_FIELD,
  };
}

/**
 * The Allowances part of the Compensation section, as of today (or the date hired, when later).
 * The caller checks that the viewer may reveal `allowances`; amounts are never decrypted here.
 */
export async function buildAllowancesSection(
  identity: Pick<EmployeeIdentity, 'employeeId' | 'dateHired'>,
  today: BusinessDate,
): Promise<AllowancesSectionView> {
  const asOf = identity.dateHired > today ? identity.dateHired : today;
  const [entries, types, versions] = await Promise.all([
    loadEntries(identity.employeeId),
    typesOn(asOf),
    listConfigVersions(ALLOWANCE_TYPES_SETTING),
  ]);
  // Keys are never removed, so the newest version names every type ever added.
  const names = new Map<string, string>();
  for (const version of [...versions].reverse()) {
    for (const type of version.value.types) names.set(type.key, type.name);
  }

  const lines = resolveAllowances({ day: asOf, dateHired: identity.dateHired, types, entries }).map(
    (line): AllowanceLineView => ({
      typeKey: line.typeKey,
      name: line.name,
      basis: line.basis,
      taxTreatment: line.taxTreatment,
      origin: line.origin,
      ...(line.origin === 'automatic'
        ? { defaultAmountCentavos: line.amountCentavos ?? 0 }
        : { amount: maskedAmount(line.entryId ?? '') }),
      since: line.since,
      upcoming: line.since > today,
    }),
  );
  const statuses = allowanceEntryStatuses(entries, today);
  const history = [...entries]
    .sort(compareAllowanceEntries)
    .map((entry): AllowanceAssignmentView => ({
      id: entry.id,
      typeKey: entry.typeKey,
      typeName: names.get(entry.typeKey) ?? entry.typeKey,
      effectiveDate: entry.effectiveDate,
      kind: entry.kind,
      amount: entry.kind === 'set' ? maskedAmount(entry.id) : null,
      reason: entry.reason,
      status: statuses.get(entry.id) ?? 'previous',
      createdAt: entry.createdAt,
    }));
  return {
    asOf,
    lines,
    history,
    types: types.map((type) => ({
      key: type.key,
      name: type.name,
      basis: type.basis,
      taxTreatment: type.taxTreatment,
      defaultAmountCentavos: type.defaultAmountCentavos,
      autoAssign: type.autoAssign,
      active: type.active,
    })),
  };
}

/**
 * "Assign allowance": a new insert-only entry that sets an amount for a type from a date, or ends
 * it (an automatic type included). The salary rule: Talent Write and HR or the System
 * Administrator; for an HR-department employee, Talent Write and the System Administrator or a
 * Board member; never one's own. The effective date is on or after the date hired and at most a
 * year ahead; the type must be in the `talent.allowanceTypes` version in effect on that date, and
 * active to set an amount.
 */
export async function assignAllowance(
  actor: TalentActor,
  input: AllowanceAssignmentInput,
): Promise<{ id: string }> {
  const parsed = allowanceAssignmentSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const values = parsed.data;

  // Before anything is encrypted: the same checks the transaction makes again.
  assertCanEditEmployeeRecord(actor, { employeeId: values.employeeId, departmentCode: null });
  await connectDb();
  const known = await getEmployeeIdentity(actor, values.employeeId, { separated: true });
  if (!known) throw new ActionError(EMPLOYEE_GONE);
  assertCanChangeSensitiveDetails(actor, targetOf(known));

  const encrypted =
    values.kind === 'set' && values.amountCentavos !== null
      ? await encryptSensitive(values.amountCentavos)
      : undefined;

  return withTransaction(async (session) => {
    const current = await reloadActorAccess({ id: actor.id }, session);
    const identity = await getEmployeeIdentity(current, values.employeeId, {
      separated: true,
      session,
    });
    if (!identity) throw new ActionError(EMPLOYEE_GONE);
    assertCanChangeSensitiveDetails(current, targetOf(identity));

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
    const type = (await typesOn(values.effectiveDate, session)).find(
      (t) => t.key === values.typeKey,
    );
    if (!type) {
      throw new ActionError('That allowance type isn’t in the payroll settings on that date.', {
        field: 'typeKey',
      });
    }
    if (values.kind === 'set' && !type.active) {
      throw new ActionError('That allowance type is inactive, so it can’t be newly assigned.', {
        field: 'typeKey',
      });
    }

    const entry = new AllowanceAssignmentModel({
      employeeId: new Types.ObjectId(identity.employeeId),
      typeKey: type.key,
      effectiveDate: instantOf(values.effectiveDate),
      kind: values.kind,
      ...(encrypted !== undefined ? { amountCentavos: encrypted } : {}),
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
          type: ALLOWANCE_ASSIGNMENT_TYPE,
          id: entry._id,
          label: auditLabelOf(identity.employeeNumber, type.name, values.effectiveDate),
        },
        before: null,
        after: snapshotForAudit(AllowanceAssignmentModel, entry),
        reason: values.reason,
      },
      { session },
    );
    return { id: entry._id.toHexString() };
  });
}
