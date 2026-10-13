import { type ClientSession, Types } from 'mongoose';
import { connectDb, withTransaction } from '@pulse/db';
import {
  AccessDeniedError,
  ActionError,
  addDays,
  type BusinessDate,
  businessToday,
  formatDate,
  now,
} from '@pulse/core';
import {
  type ConfigVersion,
  type EmployeeIdentity,
  findStoredFile,
  getEmployeeIdentity,
  listClientOptions,
  listConfigVersions,
  recordAudit,
  reloadActorAccess,
  saveUpload,
  snapshotForAudit,
  snapshotsForAudit,
} from '@pulse/core/server';
import {
  type CreateReimbursementInput,
  createReimbursementSchema,
  type DeleteReimbursementInput,
  deleteReimbursementSchema,
  type UpdateReimbursementInput,
  updateReimbursementSchema,
} from '../../reimbursements/inputs';
import { type LimitLine, overLimit, overLimitByLine } from '../../reimbursements/limits';
import { receiptKey } from '../../reimbursements/receipt-key';
import {
  type ReimbursementSettings,
  type ReimbursementType,
  reimbursementTypeOf,
} from '../../reimbursements/schemas';
import {
  RECEIPT_REQUIRED,
  REIMBURSEMENT_NOT_FOUND,
  REIMBURSEMENT_TYPE,
  type ReimbursementDayGroup,
  type ReimbursementLineView,
  type ReimbursementSaveResult,
  type ReimbursementsSectionView,
  STALE_REIMBURSEMENT_MESSAGE,
} from '../../reimbursements/views';
import { versionOn } from '../../timesheets/schedule';
import type { TimesheetRecordView } from '../../timesheets/views';
import { inputError } from '../input';
import { REIMBURSEMENT_SETTINGS_SETTING } from '../payroll-settings/settings';
import { NO_EMPLOYEE_TIMESHEET, type TalentActor } from '../policy';
import {
  assertReceiptNotClaimed,
  claimReceipt,
  type ReceiptKeyParts,
  receiptKeyPartsOf,
  releaseReceiptClaim,
} from '../receipt-claims/service';
import {
  auditLabelOf,
  dayOf,
  EMPLOYEE_GONE,
  fileUrlOf,
  inlineFileUrlOf,
  instantOf,
  objectIdOf,
  sentFile,
} from '../shared';
import { type TimesheetDocument, TimesheetModel } from '../timesheets/model';
import { loadPayrollVersions, type PayrollVersions, periodOrNull } from '../timesheets/periods';
import { type ReimbursementDocument, ReimbursementModel } from './model';

// Spec: docs/modules/talent.md#reimbursements-build-step-25 ("Reimbursement lines", "The
// timesheet a line belongs to", "Checks", "No duplicates", "Limits", "The receipt file", "Who may
// do what", "Serialization and audit"), SECURITY.md#exceptions-to-module-access ("The own
// timesheet") and decisions 237–253 in docs/BUILD_PLAN.md.
//
// - Every change is self-service: it acts on the signed-in user's own employee, read from the
//   database in the transaction, never from the request. Nobody changes another person's lines,
//   HR and the System Administrator included: another person's line is simply not found.
// - Checks, in the save's transaction: the timesheet open; the receipt date in the filing window
//   (from the start of the cut-off N before the line's timesheet to the earlier of its end and
//   today, on or after the date hired, not after the separation date; N from today's version);
//   adding also needs the timesheet's cut-off to be today's or one of the N before; the type in
//   the receipt date's version and active (a stored inactive type is kept on edit) with its
//   required fields; a live client; the receipt not claimed already; the line's `version`.
// - The receipt is claimed in the register (`claimReceipt`) in the same transaction. Deleting a
//   line, or changing its TIN or receipt number, releases its claim in the same transaction.
// - The receipt file is saved before the transaction (a side effect), after the same checks run
//   once outside it, so a refused save rarely leaves a stray file; a stray one never opens (the
//   file route needs a live line that points at it). A new file on edit replaces the old one.
// - Each save touches its timesheet (the step 2.4 touch), so step 2.7's submission conflicts
//   with a save in flight. Audit: `create`, `update` and `delete` on `talent.reimbursement`,
//   labelled `<employee number> · <receipt date>`, in the same transaction. No notification.
// - Over-limit lines are highlighted, never refused. The client is for tracking only: nothing
//   here offers a line for billing.

export const REIMBURSEMENT_TIMESHEET_NOT_FOUND = 'This timesheet can’t be found. Reload to see it.';
export const REIMBURSEMENT_TIMESHEET_NOT_OPEN =
  'This timesheet is no longer open, so its reimbursements can’t change.';
export const REIMBURSEMENT_SETTINGS_MISSING =
  'Reimbursements aren’t set up yet. Ask HR to check the payroll settings.';

type ReimbursementVersions = ConfigVersion<ReimbursementSettings>[];
type Actor = Awaited<ReturnType<typeof reloadActorAccess>> | TalentActor;

// ---------------------------------------------------------------------------------------------
// The filing window

/** The start of the cut-off `n` before the one starting on `start` (as far back as one exists). */
function cutOffStartBack(start: BusinessDate, n: number, payroll: PayrollVersions): BusinessDate {
  let found = start;
  for (let step = 0; step < n; step += 1) {
    const previous = periodOrNull(addDays(found, -1), payroll);
    if (!previous) break;
    found = previous.start;
  }
  return found;
}

/** `filingWindowPreviousCutOffs` of the version in effect today. */
function previousCutOffsToday(versions: ReimbursementVersions, today: BusinessDate): number {
  const version = versionOn(versions, today);
  if (!version) throw new ActionError(REIMBURSEMENT_SETTINGS_MISSING);
  return version.value.filingWindowPreviousCutOffs;
}

interface WindowEmployee {
  dateHired: BusinessDate;
  separationDate: BusinessDate | null;
}

/**
 * The receipt dates a timesheet takes: from the start of the cut-off `n` before it (or the date
 * hired) to the earlier of its end and today (or the separation date). Null when that is empty.
 */
function receiptWindow(
  timesheet: { periodStart: BusinessDate; periodEnd: BusinessDate },
  employee: WindowEmployee,
  n: number,
  payroll: PayrollVersions,
  today: BusinessDate,
): { from: BusinessDate; to: BusinessDate } | null {
  let from = cutOffStartBack(timesheet.periodStart, n, payroll);
  if (employee.dateHired > from) from = employee.dateHired;
  let to = timesheet.periodEnd < today ? timesheet.periodEnd : today;
  if (employee.separationDate && employee.separationDate < to) to = employee.separationDate;
  return from <= to ? { from, to } : null;
}

/** True when a timesheet starting on `start` takes new lines: today's cut-off or the `n` before. */
function takesNewLines(
  start: BusinessDate,
  n: number,
  payroll: PayrollVersions,
  today: BusinessDate,
): boolean {
  const current = periodOrNull(today, payroll);
  if (!current) return false;
  return start >= cutOffStartBack(current.start, n, payroll) && start <= current.start;
}

// ---------------------------------------------------------------------------------------------
// The checks

interface LineValues {
  typeKey: string;
  receiptDate: BusinessDate;
  merchant: string;
  merchantTin: string;
  receiptNumber: string;
  amountCentavos: number;
  clientId: string | null;
  pickUp: string | null;
  dropOff: string | null;
  description: string | null;
}

interface CheckContext {
  identity: EmployeeIdentity;
  timesheet: TimesheetDocument;
  versions: ReimbursementVersions;
  payroll: PayrollVersions;
  today: BusinessDate;
}

interface CheckedLine {
  type: ReimbursementType;
  parts: ReceiptKeyParts;
  /** The stored route and description (the route only when the type requires it). */
  pickUp: string | null;
  dropOff: string | null;
  description: string | null;
}

/**
 * Every rule of a line but the client and the duplicate: the timesheet open, the filing window,
 * the type and its required fields, the TIN and number. `storedTypeKey` is the line's type on
 * edit (kept even when inactive); null when adding, which also needs a timesheet that takes new
 * lines.
 */
function checkLine(
  { identity, timesheet, versions, payroll, today }: CheckContext,
  values: LineValues,
  storedTypeKey: string | null,
): CheckedLine {
  if (timesheet.status !== 'open') throw new ActionError(REIMBURSEMENT_TIMESHEET_NOT_OPEN);
  const n = previousCutOffsToday(versions, today);
  const periodStart = dayOf(timesheet.periodStart);
  if (storedTypeKey === null && !takesNewLines(periodStart, n, payroll, today)) {
    throw new ActionError(
      n === 0
        ? 'New reimbursements go on the current cut-off’s timesheet only.'
        : `New reimbursements go on the current cut-off’s timesheet or one of the ${n} before it.`,
    );
  }

  const date = values.receiptDate;
  if (date > today) {
    throw new ActionError('The receipt date can’t be after today.', { field: 'receiptDate' });
  }
  if (date < identity.dateHired) {
    throw new ActionError('The receipt date can’t be before your date hired.', {
      field: 'receiptDate',
    });
  }
  if (identity.separationDate && date > identity.separationDate) {
    throw new ActionError('The receipt date can’t be after your separation date.', {
      field: 'receiptDate',
    });
  }
  const window = receiptWindow(
    { periodStart, periodEnd: dayOf(timesheet.periodEnd) },
    identity,
    n,
    payroll,
    today,
  );
  if (!window || date < window.from || date > window.to) {
    throw new ActionError(
      window
        ? `Receipts on this timesheet must be dated ${formatDate(window.from)} – ${formatDate(window.to)}.`
        : 'This timesheet takes no more receipts.',
      { field: 'receiptDate' },
    );
  }

  const type = reimbursementTypeOf(versionOn(versions, date)?.value, values.typeKey);
  if (!type) {
    throw new ActionError('Choose a type in use on the receipt date.', { field: 'typeKey' });
  }
  if (!type.active && values.typeKey !== storedTypeKey) {
    throw new ActionError('This type is no longer used. Choose another type.', {
      field: 'typeKey',
    });
  }
  if (type.requiresRoute) {
    if (!values.pickUp) throw new ActionError('Enter the pick-up location.', { field: 'pickUp' });
    if (!values.dropOff) {
      throw new ActionError('Enter the drop-off location.', { field: 'dropOff' });
    }
  }
  if (type.requiresDescription && !values.description) {
    throw new ActionError('Enter a description of the expense.', { field: 'description' });
  }
  if (type.requiresClient && !values.clientId) {
    throw new ActionError('Choose the client.', { field: 'clientId' });
  }
  if (!Number.isSafeInteger(values.amountCentavos) || values.amountCentavos <= 0) {
    throw new ActionError('Enter an amount above zero.', { field: 'amountCentavos' });
  }
  return {
    type,
    parts: receiptKeyPartsOf(values.merchantTin, values.receiptNumber),
    pickUp: type.requiresRoute ? values.pickUp : null,
    dropOff: type.requiresRoute ? values.dropOff : null,
    description: values.description,
  };
}

/** Refuses a client that isn't a live Core client (unless it is the one already stored). */
async function checkClient(
  clientId: string | null,
  stored: Types.ObjectId | null = null,
): Promise<Types.ObjectId | null> {
  if (!clientId) return null;
  if (stored && stored.toHexString() === clientId) return stored;
  const options = await listClientOptions();
  if (!options.some((option) => option.id === clientId)) {
    throw new ActionError('Choose a client from the list.', { field: 'clientId' });
  }
  return new Types.ObjectId(clientId);
}

/** The register key of a stored line. */
function storedParts(line: ReimbursementDocument): ReceiptKeyParts {
  return { merchantTin: line.merchantTin, receiptKey: receiptKey(line.receiptNumber) ?? '' };
}

const sameParts = (a: ReceiptKeyParts, b: ReceiptKeyParts) =>
  a.merchantTin === b.merchantTin && a.receiptKey === b.receiptKey;

// ---------------------------------------------------------------------------------------------
// Loading

/** Refuses an actor with no employee (the bootstrap system account) before any work. */
function assertHasEmployee(actor: TalentActor): asserts actor is TalentActor & {
  employee: { id: string };
} {
  if (!actor.employee) throw new AccessDeniedError(NO_EMPLOYEE_TIMESHEET);
}

/** The actor (reloaded in a transaction) and their own employee, as they are now. */
async function ownEmployee(
  actor: TalentActor,
  session?: ClientSession,
): Promise<{ current: Actor; identity: EmployeeIdentity }> {
  const current = session ? await reloadActorAccess({ id: actor.id }, session) : actor;
  if (!current.employee) throw new AccessDeniedError(NO_EMPLOYEE_TIMESHEET);
  const identity = await getEmployeeIdentity(current, current.employee.id, {
    separated: true,
    session: session ?? null,
  });
  if (!identity) throw new ActionError(EMPLOYEE_GONE);
  return { current, identity };
}

async function ownTimesheet(
  identity: EmployeeIdentity,
  timesheetId: Types.ObjectId,
  session?: ClientSession,
): Promise<TimesheetDocument> {
  const timesheet = await TimesheetModel.findOne({
    _id: timesheetId,
    employeeId: new Types.ObjectId(identity.employeeId),
  })
    .session(session ?? null)
    .lean<TimesheetDocument>();
  if (!timesheet) throw new ActionError(REIMBURSEMENT_TIMESHEET_NOT_FOUND);
  return timesheet;
}

async function ownLine(
  identity: EmployeeIdentity,
  reimbursementId: string,
  session?: ClientSession,
): Promise<ReimbursementDocument> {
  const id = objectIdOf(reimbursementId);
  const line = id
    ? await ReimbursementModel.findOne({
        _id: id,
        employeeId: new Types.ObjectId(identity.employeeId),
      })
        .session(session ?? null)
        .lean<ReimbursementDocument>()
    : null;
  if (!line) throw new ActionError(REIMBURSEMENT_NOT_FOUND);
  return line;
}

async function loadVersions(session?: ClientSession) {
  const [versions, payroll] = await Promise.all([
    listConfigVersions(REIMBURSEMENT_SETTINGS_SETTING, { session }),
    loadPayrollVersions({ session }),
  ]);
  return { versions, payroll };
}

/** The step 2.4 touch: `updatedBy` set and `__v` incremented, so concurrent saves conflict. */
async function touchTimesheet(
  timesheetId: Types.ObjectId,
  actorId: string,
  session: ClientSession,
): Promise<void> {
  await TimesheetModel.updateOne(
    { _id: timesheetId },
    { $set: { updatedBy: new Types.ObjectId(actorId) }, $inc: { __v: 1 } },
    { session },
  );
}

async function saveReceipt(
  actor: TalentActor,
  lineId: Types.ObjectId,
  file: File,
): Promise<Types.ObjectId> {
  const stored = await saveUpload({
    file,
    owner: { type: REIMBURSEMENT_TYPE, id: lineId },
    actorId: objectIdOf(actor.id),
    field: 'receipt',
    transformImages: 'receipt',
  });
  const fileId = objectIdOf(stored.id);
  if (!fileId) throw new Error('The stored receipt has no valid id.');
  return fileId;
}

function lineLabel(employeeNumber: string, receiptDate: BusinessDate): string {
  return auditLabelOf(employeeNumber, receiptDate);
}

async function auditLine(
  current: Actor,
  action: 'create' | 'update' | 'delete',
  lineId: Types.ObjectId,
  label: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  session: ClientSession,
): Promise<void> {
  await recordAudit(
    {
      actorId: current.id,
      actorEmail: current.email,
      module: 'talent',
      action,
      record: { type: REIMBURSEMENT_TYPE, id: lineId, label },
      before,
      after,
    },
    { session },
  );
}

/** The employee's live lines dated `receiptDate` (every timesheet), for the per-day limit. */
async function linesOn(
  employeeId: Types.ObjectId,
  receiptDates: BusinessDate[],
  session?: ClientSession,
): Promise<LimitLine[]> {
  if (receiptDates.length === 0) return [];
  const lines = await ReimbursementModel.find(
    { employeeId, receiptDate: { $in: receiptDates.map(instantOf) } },
    { typeKey: 1, receiptDate: 1, amountCentavos: 1 },
  )
    .session(session ?? null)
    .lean<Pick<ReimbursementDocument, '_id' | 'typeKey' | 'receiptDate' | 'amountCentavos'>[]>();
  return lines.map(limitLineOf);
}

function limitLineOf(
  line: Pick<ReimbursementDocument, '_id' | 'typeKey' | 'receiptDate' | 'amountCentavos'>,
): LimitLine {
  return {
    id: line._id.toHexString(),
    typeKey: line.typeKey,
    receiptDate: dayOf(line.receiptDate),
    amountCentavos: line.amountCentavos,
  };
}

async function overLimitOf(
  line: ReimbursementDocument,
  versions: ReimbursementVersions,
  session: ClientSession,
) {
  const day = dayOf(line.receiptDate);
  return overLimit(limitLineOf(line), versions, await linesOn(line.employeeId, [day], session));
}

// ---------------------------------------------------------------------------------------------
// Add, edit, delete

/**
 * "Add reimbursement": a new line on the employee's own open timesheet `timesheetId`, with its
 * receipt (form field `receipt`, a photo or a PDF, required; photos are re-encoded). Every check
 * applies, and the receipt is claimed in the register; a duplicate is refused. Over the type's
 * limit still saves (`overLimit` says by how much). One `create` entry.
 */
export async function addReimbursement(
  actor: TalentActor,
  input: CreateReimbursementInput,
  receipt: File | null | undefined,
): Promise<ReimbursementSaveResult> {
  assertHasEmployee(actor);
  const parsed = createReimbursementSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const values = parsed.data;
  const file = sentFile(receipt);
  if (!file) throw new ActionError(RECEIPT_REQUIRED, { field: 'receipt' });
  const timesheetId = new Types.ObjectId(values.timesheetId);
  await connectDb();

  // The same checks once before the file is saved.
  {
    const { identity } = await ownEmployee(actor);
    const timesheet = await ownTimesheet(identity, timesheetId);
    const today = businessToday();
    const checked = checkLine(
      { identity, timesheet, today, ...(await loadVersions()) },
      values,
      null,
    );
    await checkClient(values.clientId);
    await assertReceiptNotClaimed(checked.parts, identity.employeeId);
  }

  const lineId = new Types.ObjectId();
  const receiptFileId = await saveReceipt(actor, lineId, file);

  return withTransaction(async (session) => {
    const { current, identity } = await ownEmployee(actor, session);
    const timesheet = await ownTimesheet(identity, timesheetId, session);
    await touchTimesheet(timesheet._id, current.id, session);
    const { versions, payroll } = await loadVersions(session);
    const checked = checkLine(
      { identity, timesheet, versions, payroll, today: businessToday() },
      values,
      null,
    );
    const clientId = await checkClient(values.clientId);
    const employeeId = new Types.ObjectId(identity.employeeId);
    const claim = await claimReceipt(
      {
        merchantTin: checked.parts.merchantTin,
        receiptNumber: values.receiptNumber,
        claimType: REIMBURSEMENT_TYPE,
        claimId: lineId,
        employeeId,
      },
      { session, actorId: current.id },
    );
    const line = new ReimbursementModel({
      _id: lineId,
      employeeId,
      timesheetId: timesheet._id,
      receiptDate: instantOf(values.receiptDate),
      typeKey: values.typeKey,
      merchant: values.merchant,
      merchantTin: checked.parts.merchantTin,
      receiptNumber: values.receiptNumber,
      amountCentavos: values.amountCentavos,
      receiptFileId,
      clientId,
      pickUp: checked.pickUp,
      dropOff: checked.dropOff,
      description: checked.description,
      receiptClaimId: new Types.ObjectId(claim.id),
      version: 1,
      createdBy: current.id,
      updatedBy: current.id,
    });
    await line.save({ session });
    await auditLine(
      current,
      'create',
      lineId,
      lineLabel(identity.employeeNumber, values.receiptDate),
      null,
      snapshotForAudit(ReimbursementModel, line),
      session,
    );
    return {
      id: lineId.toHexString(),
      version: 1,
      overLimit: await overLimitOf(line.toObject() as ReimbursementDocument, versions, session),
    };
  });
}

/**
 * The edit sheet: saves the whole line against its `version`, on its own open timesheet (the
 * timesheet never changes; editing doesn't need the timesheet to take new lines). A new receipt
 * (form field `receipt`) replaces the old one, which is kept but no longer opens. Changing the
 * TIN or the receipt number releases the old claim and claims the new receipt in the same
 * transaction; keeping both keeps the claim. Own lines only: anyone else's is not found. One
 * `update` entry.
 */
export async function updateReimbursement(
  actor: TalentActor,
  input: UpdateReimbursementInput,
  receipt?: File | null,
): Promise<ReimbursementSaveResult> {
  assertHasEmployee(actor);
  const parsed = updateReimbursementSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const values = parsed.data;
  const file = sentFile(receipt);
  await connectDb();

  let lineId: Types.ObjectId;
  {
    const { identity } = await ownEmployee(actor);
    const stored = await ownLine(identity, values.reimbursementId);
    if (stored.version !== values.version) throw new ActionError(STALE_REIMBURSEMENT_MESSAGE);
    const timesheet = await ownTimesheet(identity, stored.timesheetId);
    const checked = checkLine(
      { identity, timesheet, today: businessToday(), ...(await loadVersions()) },
      values,
      stored.typeKey,
    );
    await checkClient(values.clientId, stored.clientId);
    if (!sameParts(checked.parts, storedParts(stored))) {
      await assertReceiptNotClaimed(checked.parts, identity.employeeId, {
        exceptClaimId: stored.receiptClaimId,
      });
    }
    lineId = stored._id;
  }

  const newFileId = file ? await saveReceipt(actor, lineId, file) : null;

  return withTransaction(async (session) => {
    const { current, identity } = await ownEmployee(actor, session);
    const existing = await ownLine(identity, values.reimbursementId, session);
    if (existing.version !== values.version) throw new ActionError(STALE_REIMBURSEMENT_MESSAGE);
    const timesheet = await ownTimesheet(identity, existing.timesheetId, session);
    await touchTimesheet(timesheet._id, current.id, session);
    const { versions, payroll } = await loadVersions(session);
    const checked = checkLine(
      { identity, timesheet, versions, payroll, today: businessToday() },
      values,
      existing.typeKey,
    );
    const clientId = await checkClient(values.clientId, existing.clientId);

    let receiptClaimId = existing.receiptClaimId;
    if (!sameParts(checked.parts, storedParts(existing))) {
      await releaseReceiptClaim(
        { claimType: REIMBURSEMENT_TYPE, claimId: existing._id },
        { session, actorId: current.id },
      );
      const claim = await claimReceipt(
        {
          merchantTin: checked.parts.merchantTin,
          receiptNumber: values.receiptNumber,
          claimType: REIMBURSEMENT_TYPE,
          claimId: existing._id,
          employeeId: existing.employeeId,
        },
        { session, actorId: current.id },
      );
      receiptClaimId = new Types.ObjectId(claim.id);
    }

    const updated = await ReimbursementModel.findOneAndUpdate(
      { _id: existing._id, version: existing.version },
      {
        $set: {
          receiptDate: instantOf(values.receiptDate),
          typeKey: values.typeKey,
          merchant: values.merchant,
          merchantTin: checked.parts.merchantTin,
          receiptNumber: values.receiptNumber,
          amountCentavos: values.amountCentavos,
          receiptFileId: newFileId ?? existing.receiptFileId,
          clientId,
          pickUp: checked.pickUp,
          dropOff: checked.dropOff,
          description: checked.description,
          receiptClaimId,
          updatedBy: new Types.ObjectId(current.id),
        },
        $inc: { version: 1 },
      },
      { session, returnDocument: 'after', runValidators: true },
    ).lean<ReimbursementDocument>();
    if (!updated) throw new ActionError(STALE_REIMBURSEMENT_MESSAGE);
    const { before, after } = snapshotsForAudit(ReimbursementModel, existing, updated);
    await auditLine(
      current,
      'update',
      existing._id,
      lineLabel(identity.employeeNumber, values.receiptDate),
      before,
      after,
      session,
    );
    return {
      id: existing._id.toHexString(),
      version: updated.version,
      overLimit: await overLimitOf(updated, versions, session),
    };
  });
}

/**
 * "Delete reimbursement", after the confirmation: a soft delete against the line's `version`, on
 * its own open timesheet, which releases its receipt claim in the same transaction. Own lines
 * only. One `delete` entry.
 */
export async function deleteReimbursement(
  actor: TalentActor,
  input: DeleteReimbursementInput,
): Promise<void> {
  assertHasEmployee(actor);
  const parsed = deleteReimbursementSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const values = parsed.data;
  await connectDb();
  await withTransaction(async (session) => {
    const { current, identity } = await ownEmployee(actor, session);
    const existing = await ownLine(identity, values.reimbursementId, session);
    if (existing.version !== values.version) throw new ActionError(STALE_REIMBURSEMENT_MESSAGE);
    const timesheet = await ownTimesheet(identity, existing.timesheetId, session);
    if (timesheet.status !== 'open') throw new ActionError(REIMBURSEMENT_TIMESHEET_NOT_OPEN);
    await touchTimesheet(timesheet._id, current.id, session);
    const deleted = await ReimbursementModel.findOneAndUpdate(
      { _id: existing._id, version: existing.version },
      {
        $set: { deletedAt: now(), updatedBy: new Types.ObjectId(current.id) },
        $inc: { version: 1 },
      },
      { session, returnDocument: 'after' },
    ).lean<ReimbursementDocument>();
    if (!deleted) throw new ActionError(STALE_REIMBURSEMENT_MESSAGE);
    await releaseReceiptClaim(
      { claimType: REIMBURSEMENT_TYPE, claimId: existing._id },
      { session, actorId: current.id },
    );
    await auditLine(
      current,
      'delete',
      existing._id,
      lineLabel(identity.employeeNumber, dayOf(existing.receiptDate)),
      snapshotForAudit(ReimbursementModel, existing),
      null,
      session,
    );
  });
}

// ---------------------------------------------------------------------------------------------
// The read: the timesheet's Reimbursements segment

export interface ReimbursementsSectionOptions {
  /** The employee's own timesheet: the window, the types and the controls. */
  own: boolean;
  today?: BusinessDate;
  payrollVersions?: PayrollVersions;
}

const emptySection = (): ReimbursementsSectionView => ({
  groups: [],
  totalCentavos: 0,
  count: 0,
  canAdd: false,
  canEdit: false,
  window: null,
});

/**
 * The Reimbursements segment of a timesheet the caller has already checked the viewer may open
 * (the timesheet view does). Server-only, not exported from the package: the pages get it on the
 * timesheet view. Lines grouped by receipt date, newest first, each with its receipt links and
 * its over-limit amount (the per-day limit counts the employee's lines on every timesheet). The
 * filing window and the types go to the employee's own timesheet only: the window would show the
 * date hired to anyone else.
 */
export async function reimbursementsSectionFor(
  employee: WindowEmployee & { employeeId: string },
  timesheet: TimesheetRecordView,
  { own, today = businessToday(), payrollVersions }: ReimbursementsSectionOptions,
): Promise<ReimbursementsSectionView> {
  if (!timesheet.id) return emptySection();
  await connectDb();
  const employeeId = new Types.ObjectId(employee.employeeId);
  const [lines, versions, clients, payroll] = await Promise.all([
    ReimbursementModel.find({ timesheetId: new Types.ObjectId(timesheet.id), employeeId })
      .sort({ receiptDate: -1, createdAt: -1, _id: -1 })
      .lean<ReimbursementDocument[]>(),
    listConfigVersions(REIMBURSEMENT_SETTINGS_SETTING),
    listClientOptions(),
    payrollVersions ? Promise.resolve(payrollVersions) : loadPayrollVersions(),
  ]);

  const dates = [...new Set(lines.map((line) => dayOf(line.receiptDate)))];
  const [employeeLines, files] = await Promise.all([
    linesOn(employeeId, dates),
    Promise.all(lines.map((line) => findStoredFile(line.receiptFileId.toHexString()))),
  ]);
  const over = overLimitByLine(lines.map(limitLineOf), versions, employeeLines);
  const clientNames = new Map(clients.map((client) => [client.id, client.name]));

  const groups: ReimbursementDayGroup[] = [];
  let totalCentavos = 0;
  lines.forEach((line, index) => {
    const id = line._id.toHexString();
    const receiptDate = dayOf(line.receiptDate);
    const clientId = line.clientId?.toHexString() ?? null;
    totalCentavos += line.amountCentavos;
    const view: ReimbursementLineView = {
      id,
      receiptDate,
      typeKey: line.typeKey,
      typeName:
        reimbursementTypeOf(versionOn(versions, receiptDate)?.value, line.typeKey)?.name ??
        line.typeKey,
      merchant: line.merchant,
      merchantTin: line.merchantTin,
      receiptNumber: line.receiptNumber,
      amountCentavos: line.amountCentavos,
      client: clientId
        ? { id: clientId, name: clientNames.get(clientId) ?? 'Removed client' }
        : null,
      pickUp: line.pickUp,
      dropOff: line.dropOff,
      description: line.description,
      receipt: {
        url: fileUrlOf(line.receiptFileId),
        inlineUrl: inlineFileUrlOf(line.receiptFileId),
        isPdf: files[index]?.contentType === 'application/pdf',
      },
      overLimit: over.get(id) ?? null,
      version: line.version,
    };
    const last = groups[groups.length - 1];
    if (last && last.receiptDate === receiptDate) last.lines.push(view);
    else groups.push({ receiptDate, lines: [view] });
  });

  const section: ReimbursementsSectionView = {
    groups,
    totalCentavos,
    count: lines.length,
    canAdd: false,
    canEdit: false,
    window: null,
  };
  if (!own) return section;

  const todayVersion = versionOn(versions, today);
  section.types = (todayVersion?.value.types ?? []).map((type) => ({
    key: type.key,
    name: type.name,
    active: type.active,
    requiresRoute: type.requiresRoute,
    requiresDescription: type.requiresDescription,
    requiresClient: type.requiresClient,
    limit: type.limit,
  }));
  if (!todayVersion || timesheet.status !== 'open') return section;
  const n = todayVersion.value.filingWindowPreviousCutOffs;
  section.canEdit = true;
  section.window = receiptWindow(timesheet, employee, n, payroll, today);
  section.canAdd =
    section.window !== null && takesNewLines(timesheet.periodStart, n, payroll, today);
  return section;
}
