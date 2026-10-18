import { type ClientSession, Types } from 'mongoose';
import { z } from 'zod';
import { connectDb, withTransaction } from '@pulse/db';
import {
  AccessDeniedError,
  ActionError,
  type BusinessDate,
  businessToday,
  formatDate,
  OBJECT_ID_PATTERN,
} from '@pulse/core';
import {
  type EmployeeIdentity,
  encryptSensitive,
  type EncryptedValue,
  getEmployeeIdentity,
  hasModuleAccess,
  isHR,
  isSystemAdministrator,
  listEmployeeIdentities,
  recordAudit,
  reloadActorAccess,
  snapshotForAudit,
} from '@pulse/core/server';
import { SALARY_MASK } from '../../formats';
import { centavosField } from '../../payroll/schemas';
import {
  type LeaveAdjustmentInput,
  leaveAdjustmentInputSchema,
  type LeaveOpeningInput,
  leaveOpeningInputSchema,
  type OffsetAdjustmentInput,
  offsetAdjustmentInputSchema,
  type OffsetOpeningInput,
  offsetOpeningInputSchema,
} from '../../time-off/schemas';
import {
  creditedLeaveTypes,
  GO_LIVE_DATE_MISSING_MESSAGE,
  type LeaveSettings,
  type LeaveType,
  leaveTypeOf,
} from '../../time-off/settings';
import type { MaskedAmountView } from '../../views';
import { inputError } from '../input';
import { insertLeaveEntry, LEAVE_TYPE_NOT_CREDITED } from '../leave/service';
import { LeaveEntryModel } from '../leave/model';
import { OffsetEntryModel } from '../offset/model';
import { writeOffsetHrEntry } from '../offset/service';
import { leaveSettingsOn } from '../payroll-settings/settings';
import {
  assertCanChangeSensitiveDetails,
  canChangeSensitiveDetails,
  canSeeSensitiveSection,
  type TalentActor,
} from '../policy';
import { EMPLOYEE_GONE, instantOf, isDuplicateKey, targetOf } from '../shared';
import {
  PAYROLL_OPENING_ENTRY_TYPE,
  PAYROLL_OPENING_FIELDS,
  PAYROLL_OPENING_REASON_MAX_LENGTH,
  type PayrollOpeningEntryDocument,
  PayrollOpeningEntryModel,
  type PayrollOpeningField,
  payrollOpeningPath,
} from './model';

// Spec: docs/modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28 ("Opening
// balances"), docs/modules/talent.md#opening-balances-at-go-live, SECURITY.md#sensitive-data and
// decisions 306–308 in docs/BUILD_PLAN.md.
//
// - The page `/talent/opening-balances`: Talent Write **and** HR or the System Administrator. It
//   lists every employee hired before the go-live date (and not separated before it) with their
//   VL, SL and offset openings and balances, and "Year-to-date pay: Entered" or "Not entered",
//   never an amount.
// - VL and SL: one `opening` per employee per `credited` type, 0 to 365 days in half days, dated
//   the go-live date. Offset: one `opening` in `offsetEntries`, in whole minutes, 0 or more. A
//   second opening for the same type is refused. Nothing while the go-live date is null, and only
//   for an employee hired before it.
// - Corrections: `adjustment` entries with a required reason (up to 300 characters), dated today,
//   for leave and offset, by the same people (decision 307).
// - Nobody enters their own, the System Administrator included.
// - Year-to-date pay (`payrollOpeningEntries`, decision 308): the salary rule decides who enters
//   it (Talent Write and HR or the System Administrator; for an HR employee, Talent Write and the
//   System Administrator or a Board member, never HR; never one's own). Each figure is encrypted
//   before the transaction; the audit snapshot hides them; the label is `<employee number> ·
//   <year>`. A correction supersedes the latest entry, with a reason; the latest wins.
// - Every write re-checks the actor's stored access in its transaction and writes its `create`
//   audit entry there. No amount is ever in a label, a notification or a log.

export const OPENING_BALANCES_DENIED =
  'Only HR and the System Administrator, with Talent Write, enter opening balances and corrections.';
export const OWN_OPENING_BALANCES_DENIED =
  'You can’t enter opening balances or corrections on your own record. Ask HR to enter them.';
export const PAYROLL_OPENING_STALE =
  'The year-to-date pay changed since you opened it. Reload the page and enter it again.';

/** True when `actor` may open `/talent/opening-balances` (Talent Write and HR or the System Administrator). */
export function canManageOpeningBalances(actor: TalentActor): boolean {
  return hasModuleAccess(actor, 'talent', 'write') && (isHR(actor) || isSystemAdministrator(actor));
}

/** Throws {@link AccessDeniedError} unless `actor` may open the opening balances page. */
export function assertCanManageOpeningBalances(actor: TalentActor): void {
  if (!canManageOpeningBalances(actor)) throw new AccessDeniedError(OPENING_BALANCES_DENIED);
}

/** Why `actor` may not enter `employeeId`'s leave and offset openings and corrections, or null. */
function openingRefusal(actor: TalentActor, employeeId: string): string | null {
  if (!canManageOpeningBalances(actor)) return OPENING_BALANCES_DENIED;
  if (actor.employee?.id === employeeId) return OWN_OPENING_BALANCES_DENIED;
  return null;
}

/** True when `actor` may enter `employeeId`'s leave and offset openings and corrections. */
export function canEnterOpeningBalances(actor: TalentActor, employeeId: string): boolean {
  return openingRefusal(actor, employeeId) === null;
}

function assertCanEnterOpeningBalances(actor: TalentActor, employeeId: string): void {
  const refusal = openingRefusal(actor, employeeId);
  if (refusal) throw new AccessDeniedError(refusal);
}

// ---------------------------------------------------------------------------------------------
// The page's list

/** One credited type's opening and balance on a row. */
export interface OpeningLeaveCell {
  typeKey: string;
  shortName: string;
  /** Null until entered. */
  openingHalfDays: number | null;
  balanceHalfDays: number;
}

/** One employee on `/talent/opening-balances`. No amounts of pay, only whether they're entered. */
export interface OpeningBalanceRow {
  employeeId: string;
  employeeNumber: string;
  name: string;
  department: string | null;
  dateHired: BusinessDate;
  separated: boolean;
  leave: OpeningLeaveCell[];
  offset: { openingMinutes: number | null; balanceMinutes: number };
  /** "Year-to-date pay: Entered" or "Not entered". */
  payrollOpening: 'entered' | 'notEntered';
  /** The viewer may enter this employee's leave and offset openings and corrections. */
  canEnter: boolean;
  /** The viewer may enter or correct this employee's year-to-date pay (the salary rule). */
  canEnterPayrollOpening: boolean;
}

export interface OpeningBalancesView {
  /** Null until HR sets it in Payroll settings › Leave: show `notice`. */
  goLiveDate: BusinessDate | null;
  /** "Set the go-live date first." while the go-live date is null. */
  notice: string | null;
  /** The year of the go-live date (year-to-date pay's year). */
  year: number | null;
  /** The credited types, in the setting's order (the columns). */
  leaveTypes: { key: string; name: string; shortName: string }[];
  rows: OpeningBalanceRow[];
}

/** True when the employee counts at go-live: hired before it, and not separated before it. */
function hiredBeforeGoLive(identity: EmployeeIdentity, goLiveDate: BusinessDate): boolean {
  return (
    identity.dateHired < goLiveDate &&
    (identity.separationDate === null || identity.separationDate >= goLiveDate)
  );
}

/**
 * `/talent/opening-balances`: Talent Write and HR or the System Administrator. Every employee
 * hired before the go-live date, with their openings, balances and whether year-to-date pay is
 * entered. While the go-live date is null, no rows and the notice.
 */
export async function getOpeningBalances(actor: TalentActor): Promise<OpeningBalancesView> {
  assertCanManageOpeningBalances(actor);
  await connectDb();
  const settings = await leaveSettingsOn();
  const types = creditedLeaveTypes(settings);
  const leaveTypes = types.map((type) => ({
    key: type.key,
    name: type.name,
    shortName: type.shortName,
  }));
  const goLiveDate = settings.goLiveDate;
  if (goLiveDate === null) {
    return { goLiveDate, notice: GO_LIVE_DATE_MISSING_MESSAGE, year: null, leaveTypes, rows: [] };
  }
  const year = Number(goLiveDate.slice(0, 4));
  const identities = (await listEmployeeIdentities(actor, { separated: true })).filter((identity) =>
    hiredBeforeGoLive(identity, goLiveDate),
  );
  const ids = identities.map((identity) => new Types.ObjectId(identity.employeeId));

  const [leaveSums, leaveOpenings, offsetSums, offsetOpenings, entered] = await Promise.all([
    LeaveEntryModel.aggregate<{
      _id: { employeeId: Types.ObjectId; typeKey: string };
      sum: number;
    }>([
      { $match: { employeeId: { $in: ids } } },
      {
        $group: {
          _id: { employeeId: '$employeeId', typeKey: '$typeKey' },
          sum: { $sum: '$halfDays' },
        },
      },
    ]),
    LeaveEntryModel.find(
      { employeeId: { $in: ids }, kind: 'opening' },
      { employeeId: 1, typeKey: 1, halfDays: 1 },
    ).lean<{ employeeId: Types.ObjectId; typeKey: string; halfDays: number }[]>(),
    OffsetEntryModel.aggregate<{ _id: Types.ObjectId; sum: number }>([
      { $match: { employeeId: { $in: ids } } },
      { $group: { _id: '$employeeId', sum: { $sum: '$minutes' } } },
    ]),
    OffsetEntryModel.find(
      { employeeId: { $in: ids }, kind: 'opening' },
      { employeeId: 1, minutes: 1 },
    ).lean<{ employeeId: Types.ObjectId; minutes: number }[]>(),
    PayrollOpeningEntryModel.distinct('employeeId', { employeeId: { $in: ids }, year }),
  ]);
  const leaveKey = (employeeId: string, typeKey: string) => `${employeeId}:${typeKey}`;
  const leaveSum = new Map(
    leaveSums.map((row) => [leaveKey(row._id.employeeId.toHexString(), row._id.typeKey), row.sum]),
  );
  const leaveOpening = new Map(
    leaveOpenings.map((row) => [leaveKey(row.employeeId.toHexString(), row.typeKey), row.halfDays]),
  );
  const offsetSum = new Map(offsetSums.map((row) => [row._id.toHexString(), row.sum]));
  const offsetOpening = new Map(
    offsetOpenings.map((row) => [row.employeeId.toHexString(), row.minutes]),
  );
  const enteredIds = new Set((entered as Types.ObjectId[]).map((id) => id.toHexString()));

  const rows = identities.map((identity): OpeningBalanceRow => {
    const id = identity.employeeId;
    return {
      employeeId: id,
      employeeNumber: identity.employeeNumber,
      name: `${identity.firstName} ${identity.lastName}`,
      department: identity.department?.name ?? null,
      dateHired: identity.dateHired,
      separated: identity.separated,
      leave: types.map((type) => ({
        typeKey: type.key,
        shortName: type.shortName,
        openingHalfDays: leaveOpening.get(leaveKey(id, type.key)) ?? null,
        balanceHalfDays: leaveSum.get(leaveKey(id, type.key)) ?? 0,
      })),
      offset: {
        openingMinutes: offsetOpening.get(id) ?? null,
        balanceMinutes: offsetSum.get(id) ?? 0,
      },
      payrollOpening: enteredIds.has(id) ? 'entered' : 'notEntered',
      canEnter: canEnterOpeningBalances(actor, id),
      canEnterPayrollOpening: canChangeSensitiveDetails(actor, targetOf(identity)),
    };
  });
  rows.sort(
    (a, b) => a.name.localeCompare(b.name) || a.employeeNumber.localeCompare(b.employeeNumber),
  );
  return { goLiveDate, notice: null, year, leaveTypes, rows };
}

// ---------------------------------------------------------------------------------------------
// Leave and offset openings and corrections

interface Checked {
  current: Awaited<ReturnType<typeof reloadActorAccess>>;
  identity: EmployeeIdentity;
}

/** In the transaction: the actor's stored access, the employee, and the opening rule. */
async function checkedInTransaction(
  actor: TalentActor,
  employeeId: string,
  session: ClientSession,
): Promise<Checked> {
  const current = await reloadActorAccess({ id: actor.id }, session);
  assertCanEnterOpeningBalances(current, employeeId);
  const identity = await getEmployeeIdentity(current, employeeId, { separated: true, session });
  if (!identity) throw new ActionError(EMPLOYEE_GONE);
  assertCanEnterOpeningBalances(current, identity.employeeId);
  return { current, identity };
}

/** The go-live date, refusing while it is null and for an employee not counted at go-live. */
function goLiveFor(settings: LeaveSettings, identity: EmployeeIdentity): BusinessDate {
  const goLiveDate = settings.goLiveDate;
  if (goLiveDate === null) throw new ActionError(GO_LIVE_DATE_MISSING_MESSAGE);
  if (!hiredBeforeGoLive(identity, goLiveDate)) {
    throw new ActionError(
      `Opening balances are only for employees hired before the go-live date, ${formatDate(goLiveDate)}, and not separated before it.`,
    );
  }
  return goLiveDate;
}

function creditedTypeOf(settings: LeaveSettings, typeKey: string): LeaveType {
  const type = leaveTypeOf(settings, typeKey);
  if (!type || type.balance !== 'credited') {
    throw new ActionError(LEAVE_TYPE_NOT_CREDITED, { field: 'typeKey' });
  }
  return type;
}

const leaveOpeningExists = (shortName: string) =>
  new ActionError(
    `The ${shortName} opening balance was already entered. Add a correction instead.`,
  );
const OFFSET_OPENING_EXISTS =
  'The offset opening balance was already entered. Add a correction instead.';

/**
 * Enters one VL or SL opening balance (a `credited` type), dated the go-live date. Talent Write and
 * HR or the System Administrator, never on one's own record. Refused while the go-live date is
 * null, for an employee hired on or after it, and when that type's opening exists.
 */
export async function enterLeaveOpening(
  actor: TalentActor,
  input: LeaveOpeningInput,
): Promise<{ id: string }> {
  const parsed = leaveOpeningInputSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const values = parsed.data;
  assertCanEnterOpeningBalances(actor, values.employeeId);
  await connectDb();
  let shortName = values.typeKey;
  try {
    return await withTransaction(async (session) => {
      const { current, identity } = await checkedInTransaction(actor, values.employeeId, session);
      const settings = await leaveSettingsOn(businessToday(), { session });
      const goLiveDate = goLiveFor(settings, identity);
      const type = creditedTypeOf(settings, values.typeKey);
      shortName = type.shortName;
      const existing = await LeaveEntryModel.exists({
        employeeId: new Types.ObjectId(identity.employeeId),
        typeKey: type.key,
        kind: 'opening',
      }).session(session);
      if (existing) throw leaveOpeningExists(type.shortName);
      const entry = await insertLeaveEntry(
        {
          employeeId: identity.employeeId,
          typeKey: type.key,
          kind: 'opening',
          halfDays: values.halfDays,
          effectiveOn: goLiveDate,
        },
        { employeeNumber: identity.employeeNumber, shortName: type.shortName },
        { userId: current.id, email: current.email },
        session,
      );
      return { id: entry._id.toHexString() };
    });
  } catch (error) {
    // Another opening for that type committed first (the unique index).
    if (isDuplicateKey(error)) throw leaveOpeningExists(shortName);
    throw error;
  }
}

/**
 * Enters the offset opening balance (whole minutes, 0 or more), dated the go-live date. The same
 * rules as {@link enterLeaveOpening}.
 */
export async function enterOffsetOpening(
  actor: TalentActor,
  input: OffsetOpeningInput,
): Promise<{ id: string }> {
  const parsed = offsetOpeningInputSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const values = parsed.data;
  assertCanEnterOpeningBalances(actor, values.employeeId);
  await connectDb();
  try {
    return await withTransaction(async (session) => {
      const { current, identity } = await checkedInTransaction(actor, values.employeeId, session);
      const settings = await leaveSettingsOn(businessToday(), { session });
      const goLiveDate = goLiveFor(settings, identity);
      const existing = await OffsetEntryModel.exists({
        employeeId: new Types.ObjectId(identity.employeeId),
        kind: 'opening',
      }).session(session);
      if (existing) throw new ActionError(OFFSET_OPENING_EXISTS);
      const entry = await writeOffsetHrEntry(
        {
          employeeId: identity.employeeId,
          employeeNumber: identity.employeeNumber,
          kind: 'opening',
          minutes: values.minutes,
          effectiveOn: goLiveDate,
          reason: null,
        },
        { userId: current.id, email: current.email },
        session,
      );
      return { id: entry._id.toHexString() };
    });
  } catch (error) {
    if (isDuplicateKey(error)) throw new ActionError(OFFSET_OPENING_EXISTS);
    throw error;
  }
}

/**
 * HR's leave correction: an `adjustment` of signed half days with a required reason, dated today,
 * for a `credited` type. Talent Write and HR or the System Administrator, never on one's own
 * record. Needs no go-live date.
 */
export async function addLeaveCorrection(
  actor: TalentActor,
  input: LeaveAdjustmentInput,
): Promise<{ id: string }> {
  const parsed = leaveAdjustmentInputSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const values = parsed.data;
  assertCanEnterOpeningBalances(actor, values.employeeId);
  await connectDb();
  return withTransaction(async (session) => {
    const { current, identity } = await checkedInTransaction(actor, values.employeeId, session);
    const today = businessToday();
    const settings = await leaveSettingsOn(today, { session });
    const type = creditedTypeOf(settings, values.typeKey);
    const entry = await insertLeaveEntry(
      {
        employeeId: identity.employeeId,
        typeKey: type.key,
        kind: 'adjustment',
        halfDays: values.halfDays,
        effectiveOn: today,
        reason: values.reason,
      },
      { employeeNumber: identity.employeeNumber, shortName: type.shortName },
      { userId: current.id, email: current.email },
      session,
    );
    return { id: entry._id.toHexString() };
  });
}

/** HR's offset correction: an `adjustment` of signed minutes with a required reason, dated today. */
export async function addOffsetCorrection(
  actor: TalentActor,
  input: OffsetAdjustmentInput,
): Promise<{ id: string }> {
  const parsed = offsetAdjustmentInputSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const values = parsed.data;
  assertCanEnterOpeningBalances(actor, values.employeeId);
  await connectDb();
  return withTransaction(async (session) => {
    const { current, identity } = await checkedInTransaction(actor, values.employeeId, session);
    const entry = await writeOffsetHrEntry(
      {
        employeeId: identity.employeeId,
        employeeNumber: identity.employeeNumber,
        kind: 'adjustment',
        minutes: values.minutes,
        effectiveOn: businessToday(),
        reason: values.reason,
      },
      { userId: current.id, email: current.email },
      session,
    );
    return { id: entry._id.toHexString() };
  });
}

// ---------------------------------------------------------------------------------------------
// Year-to-date pay at go-live

const emptyToNull = (value: unknown) => {
  const text = typeof value === 'string' ? value.trim() : value;
  return text === '' || text === undefined ? null : text;
};

/**
 * Year-to-date pay as the sheet sends it: the seven figures in whole centavos (the Server Action
 * parses the pesos typed with `parsePesos`), and for a correction the entry it supersedes and the
 * reason.
 */
export const payrollOpeningInputSchema = z.object({
  employeeId: z
    .string({ error: 'Choose an employee.' })
    .regex(OBJECT_ID_PATTERN, 'Choose an employee.'),
  grossCentavos: centavosField,
  basicSalaryEarnedCentavos: centavosField,
  taxableCompensationCentavos: centavosField,
  taxWithheldCentavos: centavosField,
  sssEmployeeCentavos: centavosField,
  philhealthEmployeeCentavos: centavosField,
  pagibigEmployeeCentavos: centavosField,
  /** The latest entry's id when correcting it; null for the first entry. */
  supersedesId: z.preprocess(
    emptyToNull,
    z.string().regex(OBJECT_ID_PATTERN, PAYROLL_OPENING_STALE).nullable().default(null),
  ),
  reason: z.preprocess(
    emptyToNull,
    z
      .string()
      .max(
        PAYROLL_OPENING_REASON_MAX_LENGTH,
        `Use at most ${PAYROLL_OPENING_REASON_MAX_LENGTH} characters.`,
      )
      .nullable()
      .default(null),
  ),
});
export type PayrollOpeningInput = z.input<typeof payrollOpeningInputSchema>;

/** The latest entry for an employee and year, or null. */
async function latestPayrollOpening(
  employeeId: Types.ObjectId,
  year: number,
  session: ClientSession | null = null,
): Promise<Pick<PayrollOpeningEntryDocument, '_id'> | null> {
  return PayrollOpeningEntryModel.findOne({ employeeId, year }, { _id: 1 })
    .sort({ createdAt: -1, _id: -1 })
    .session(session)
    .lean<Pick<PayrollOpeningEntryDocument, '_id'> | null>();
}

/**
 * Enters or corrects an employee's year-to-date pay at go-live, for the year of the go-live date.
 * The salary rule (Talent Write and HR or the System Administrator; for an HR employee, the System
 * Administrator or a Board member; never one's own), checked before encrypting and again in the
 * transaction. The first entry has no `supersedesId`; a correction names the latest entry and
 * gives a reason. Refused while the go-live date is null, and for an employee not counted at
 * go-live.
 */
export async function enterPayrollOpening(
  actor: TalentActor,
  input: PayrollOpeningInput,
): Promise<{ id: string }> {
  const parsed = payrollOpeningInputSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const values = parsed.data;

  // Before anything is encrypted: the same checks the transaction makes again.
  assertCanChangeSensitiveDetails(actor, { employeeId: values.employeeId, departmentCode: null });
  await connectDb();
  const known = await getEmployeeIdentity(actor, values.employeeId, { separated: true });
  if (!known) throw new ActionError(EMPLOYEE_GONE);
  assertCanChangeSensitiveDetails(actor, targetOf(known));

  const encrypted = Object.fromEntries(
    await Promise.all(
      PAYROLL_OPENING_FIELDS.map(
        async (field) =>
          [
            payrollOpeningPath(field),
            await encryptSensitive(values[payrollOpeningPath(field)]),
          ] as const,
      ),
    ),
  ) as Record<ReturnType<typeof payrollOpeningPath>, EncryptedValue>;

  try {
    return await withTransaction(async (session) => {
      const current = await reloadActorAccess({ id: actor.id }, session);
      const identity = await getEmployeeIdentity(current, values.employeeId, {
        separated: true,
        session,
      });
      if (!identity) throw new ActionError(EMPLOYEE_GONE);
      assertCanChangeSensitiveDetails(current, targetOf(identity));
      const settings = await leaveSettingsOn(businessToday(), { session });
      const goLiveDate = goLiveFor(settings, identity);
      const year = Number(goLiveDate.slice(0, 4));
      const employeeId = new Types.ObjectId(identity.employeeId);

      const latest = await latestPayrollOpening(employeeId, year, session);
      const latestId = latest?._id.toHexString() ?? null;
      if (values.supersedesId !== latestId) throw new ActionError(PAYROLL_OPENING_STALE);
      if (latest && !values.reason) {
        throw new ActionError('Enter the reason for the correction.', { field: 'reason' });
      }

      const entry = new PayrollOpeningEntryModel({
        employeeId,
        year,
        asOf: instantOf(goLiveDate),
        ...encrypted,
        supersedesId: latest?._id ?? null,
        reason: latest ? values.reason : null,
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
            type: PAYROLL_OPENING_ENTRY_TYPE,
            id: entry._id,
            label: `${identity.employeeNumber} · ${year}`,
          },
          before: null,
          after: snapshotForAudit(PayrollOpeningEntryModel, entry),
          reason: latest ? values.reason : null,
        },
        { session },
      );
      return { id: entry._id.toHexString() };
    });
  } catch (error) {
    // Another entry or correction committed first (the unique indexes).
    if (isDuplicateKey(error)) throw new ActionError(PAYROLL_OPENING_STALE);
    throw error;
  }
}

/** One year-to-date pay entry, every figure masked with no digits (revealed one by one). */
export interface PayrollOpeningVersionView {
  id: string;
  createdAt: Date;
  /** The correction's reason; null on the first entry. */
  reason: string | null;
  supersedesId: string | null;
  figures: Record<PayrollOpeningField, MaskedAmountView>;
}

/** The Compensation section's "Year-to-date pay at go-live". */
export interface PayrollOpeningSectionView {
  goLiveDate: BusinessDate | null;
  year: number | null;
  status: 'entered' | 'notEntered';
  /** The latest entry (it wins), or null. */
  current: PayrollOpeningVersionView | null;
  /** The entries it superseded, newest first. */
  history: PayrollOpeningVersionView[];
  /** The viewer may enter or correct it (the salary rule). */
  canEnter: boolean;
}

function versionView(entry: PayrollOpeningEntryDocument): PayrollOpeningVersionView {
  const id = entry._id.toHexString();
  return {
    id,
    createdAt: entry.createdAt,
    reason: entry.reason,
    supersedesId: entry.supersedesId?.toHexString() ?? null,
    figures: Object.fromEntries(
      PAYROLL_OPENING_FIELDS.map((field) => [
        field,
        { mask: SALARY_MASK, ownerType: PAYROLL_OPENING_ENTRY_TYPE, ownerId: id, field },
      ]),
    ) as Record<PayrollOpeningField, MaskedAmountView>,
  };
}

/**
 * Year-to-date pay at go-live for the inspector's Compensation section: only for a viewer who may
 * reveal `salary` for the employee (null for anyone else, as the Compensation section itself).
 * Every figure is sent masked with no digits; the amounts reach the browser only through the
 * audit-logged reveal (`talent.payrollOpeningEntry`).
 */
export async function getPayrollOpeningSection(
  actor: TalentActor,
  employeeId: string,
): Promise<PayrollOpeningSectionView | null> {
  await connectDb();
  let identity: EmployeeIdentity | null;
  try {
    identity = await getEmployeeIdentity(actor, employeeId, { separated: true });
  } catch (error) {
    if (error instanceof AccessDeniedError) return null;
    throw error;
  }
  if (!identity) return null;
  const target = targetOf(identity);
  if (!canSeeSensitiveSection(actor, 'salary', target)) return null;
  const settings = await leaveSettingsOn();
  const goLiveDate = settings.goLiveDate;
  const canEnter =
    canChangeSensitiveDetails(actor, target) &&
    goLiveDate !== null &&
    hiredBeforeGoLive(identity, goLiveDate);
  if (goLiveDate === null) {
    return { goLiveDate, year: null, status: 'notEntered', current: null, history: [], canEnter };
  }
  const year = Number(goLiveDate.slice(0, 4));
  // The encrypted figures are never selected here.
  const entries = await PayrollOpeningEntryModel.find({
    employeeId: new Types.ObjectId(identity.employeeId),
    year,
  })
    .sort({ createdAt: -1, _id: -1 })
    .lean<PayrollOpeningEntryDocument[]>();
  const [latest, ...older] = entries.map(versionView);
  return {
    goLiveDate,
    year,
    status: latest ? 'entered' : 'notEntered',
    current: latest ?? null,
    history: older,
    canEnter,
  };
}
