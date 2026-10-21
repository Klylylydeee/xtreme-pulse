import { type ClientSession, Types } from 'mongoose';
import { connectDb, withTransaction } from '@pulse/db';
import {
  ActionError,
  type BusinessDate,
  businessToday,
  type Centavos,
  isBusinessDate,
  type TimesheetType,
} from '@pulse/core';
import {
  activeHrUserIds,
  activeSystemAdministrators,
  decryptSensitive,
  type EmployeeIdentity,
  encryptSensitive,
  listEmployeeIdentities,
  nextDocumentNumber,
  notify,
  recordAudit,
  reloadActorAccess,
  snapshotForAudit,
  snapshotsForAudit,
  userNames,
} from '@pulse/core/server';
import type { CutOffPeriod } from '../../payroll/lookups';
import type { CutOffKey } from '../../payroll/schemas';
import { leaveSettingsOn } from '../payroll-settings/settings';
import {
  countPayrollFlags,
  groupPayrollLines,
  isAcknowledgeableFlag,
  isEditablePayrollRunStatus,
  livePayrollManualEntries,
  overrideTargetRefusal,
  PAYROLL_BREAKDOWN_VERSION,
  PAYROLL_FLAG_LABELS,
  PAYROLL_GO_LIVE_REQUIRED_MESSAGE,
  PAYROLL_LEFT_OUT_REASON_LABELS,
  PAYROLL_LINE_KIND_LABELS,
  PAYROLL_MANUAL_ENTRY_KIND_LABELS,
  PAYROLL_MANUAL_STALE_REASON_LABELS,
  PAYROLL_OVERRIDE_CONTRIBUTION_KEYS,
  PAYROLL_RUN_CHANGED_MESSAGE,
  PAYROLL_RUN_NUMBER_PREFIX,
  PAYROLL_RUN_STATUS_LABELS,
  parsePayrollBreakdown,
  type PayrollAcknowledgeableFlag,
  payrollAcknowledgedText,
  type PayrollBreakdown,
  payrollDraftReadyText,
  type PayrollFlagCounts,
  type PayrollFlagKind,
  payrollFlagText,
  type PayrollLeftOutReason,
  type PayrollLineFlag,
  type PayrollManualEntryKind,
  payrollManualEntryHistory,
  type PayrollManualStaleReason,
  payrollPeriodText,
  type PayrollRunKind,
  type PayrollRunStatus,
  type PayrollTotals,
  previousCutOff,
  serializePayrollBreakdown,
  unresolvedPayrollFlags,
} from '../../payroll-run';
import type { TimesheetStatus } from '../../timesheets/schemas';
import { PayrollFlagAcknowledgementModel } from '../payroll-review/model';
import {
  assertCanComputePayrollRuns,
  assertCanSeePayrollRuns,
  canAcknowledgePayrollFlags,
  canComputePayrollRuns,
  payrollManualEntryRefusal,
  type TalentActor,
} from '../policy';
import { dayOf, instantOf, isDuplicateKey, objectIdOf, targetOf } from '../shared';
import { latestEndedCutOff } from '../timesheets/status';
import { type TimesheetDocument, TimesheetModel } from '../timesheets/model';
import { periodOrNull } from '../timesheets/periods';
import {
  type ComputedPayrollLine,
  type ComputedPayrollRun,
  computePayrollRun,
  cutOffStartingOn,
  loadFirstPayrollCutOff,
  loadPayrollManualEntries,
  loadPayrollRunVersions,
  PAYROLL_READER,
  type PayrollRunVersions,
  type StoredPayrollManualEntry,
} from './compute';
import {
  PAYROLL_RUN_EDITABLE_STATUSES,
  PAYROLL_RUN_EMPLOYEE_RECORD_TYPE,
  PAYROLL_RUN_RECORD_TYPE,
  PAYROLL_RUN_TOTAL_PATHS,
  type PayrollFiscalPostingStatus,
  type PayrollRunDocument,
  type PayrollRunEmployeeDocument,
  PayrollRunEmployeeModel,
  PayrollRunModel,
} from './model';

// Spec: docs/modules/talent.md#payroll-run-computation-build-step-29 ("Creating a draft",
// "Recomputing a draft", "Who may see and do what", "Screens"), SECURITY.md#sensitive-data
// ("Payroll runs") and SECURITY.md#audit-logging (decisions 327, 341–343 in docs/BUILD_PLAN.md).
//
// - Creating a draft (HR's "Compute draft run", and the job): one transaction issues the
//   `PAY-YYYY-NNNN` number (Core's counter, the pay date's year), inserts the run and its lines
//   and writes `create` on `talent.payrollRun` (labelled `<number> · <period>`, no amount). The
//   job's creation also notifies HR in it (`talent.payrollDraftReady`, once per run).
// - Recomputing a draft ("Recompute", the job, the holidays-changed listener): computed from the
//   sources as they are now, then in one transaction the run is updated only if it is still a
//   draft at the version read (raising `version`), its lines replaced, and `update` ("Recomputed")
//   written. A recompute that loses the race to another starts again from the new version, so the
//   result is the same as one recompute: idempotent. A run that has left draft is refused.
// - Seeing runs: Talent Read and HR, Accounting or the System Administrator. The list and the run
//   page carry no amount; "Show amounts" writes and commits a `reveal` on the run (field
//   `amounts`) before anything is decrypted, and a breakdown a `reveal` on its line (field
//   `breakdown`). If the entry can't be written, nothing is sent.
// - Creating and recomputing: Talent Write and HR or the System Administrator, checked again in
//   the transaction against the account as it is then.
// - No amount, name or breakdown is ever logged, audited or put in a notification.
//
// Step 2.10 (docs/modules/talent.md#payroll-review-approval-and-payslips-build-step-210; decisions
// 351–359): a `returned` run is recomputed like a draft (`recomputeEditablePayrollRun`, filtered on
// `status: { $in: ['draft', 'returned'] }`), applying the live manual entries and storing each
// line's flags and manual entry count and the run's `flagCounts`; a `pendingApproval` or
// `finalized` run is refused. The run page adds the flags per person with their acknowledgements,
// the flag tiles, and the live manual entries (labels, reasons, who), with each entry's amount only
// after "Show amounts"; the breakdown adds each entry chain with its History and the override
// targets. Manual entries and acknowledgements are written by ../payroll-review/.

export const PAYROLL_RUN_GONE = 'This payroll run no longer exists. Reload the page.';
/**
 * A run that is waiting for Board approval or finalized can't be recomputed, given manual entries
 * or have its flags acknowledged (decision 351).
 */
export const PAYROLL_RUN_NOT_EDITABLE =
  'This run has been submitted for approval or finalized, so it can’t be changed. Reload the page.';
/** Step 2.9's name for {@link PAYROLL_RUN_NOT_EDITABLE}. */
export const PAYROLL_RUN_NOT_DRAFT = PAYROLL_RUN_NOT_EDITABLE;
export const PAYROLL_RUN_EXISTS =
  'A payroll run for this cut-off already exists. Reload the page to open it.';
export const PAYROLL_CUT_OFF_INVALID =
  'Choose a cut-off from the list: one that has ended, starts on or after the first payroll cut-off and has no run yet.';
export const PAYROLL_RUN_BUSY =
  'The run kept changing while it was being recomputed. Wait a moment and try again.';
export const PAYROLL_LINE_GONE = 'This employee’s line is no longer in the run. Reload the page.';

/** The event of the job's notification to HR. */
export const PAYROLL_DRAFT_READY_EVENT = 'talent.payrollDraftReady';
/** Once per run (`notify()`'s `dedupeKey`). */
export const payrollDraftReadyDedupeKey = (runId: string) =>
  `${PAYROLL_DRAFT_READY_EVENT}:${runId}`;
/** The run page. */
export const payrollRunHref = (runId: string) => `/talent/payroll/${runId}`;
/** The reveal field names (SECURITY.md#sensitive-data). */
export const PAYROLL_RUN_AMOUNTS_FIELD = 'amounts';
export const PAYROLL_LINE_BREAKDOWN_FIELD = 'breakdown';

/** Attempts at a recompute that keeps losing the version race before it gives up. */
const RECOMPUTE_ATTEMPTS = 3;

/** Who computes: a signed-in user, or null for the job and the listener. */
type ComputeActor = Pick<TalentActor, 'id' | 'email'> | null;

function cutOffOfRun(
  run: Pick<PayrollRunDocument, 'cutOffKey' | 'periodStart' | 'periodEnd' | 'payDate'>,
): CutOffPeriod {
  return {
    key: run.cutOffKey,
    start: dayOf(run.periodStart),
    end: dayOf(run.periodEnd),
    payDate: dayOf(run.payDate),
  };
}

const runLabel = (number: string, start: BusinessDate, end: BusinessDate) =>
  `${number} · ${payrollPeriodText(start, end)}`;

async function encryptedTotals(totals: PayrollTotals): Promise<Record<string, unknown>> {
  return Object.fromEntries(
    await Promise.all(
      PAYROLL_RUN_TOTAL_PATHS.map(
        async (path) => [path, await encryptSensitive(totals[path])] as const,
      ),
    ),
  );
}

async function encryptedLine(
  line: ComputedPayrollLine,
  runId: Types.ObjectId,
  periodStart: BusinessDate,
  actorId: string | null,
) {
  const { totals } = line.breakdown;
  const by = actorId ? new Types.ObjectId(actorId) : null;
  return {
    runId,
    employeeId: new Types.ObjectId(line.employeeId),
    periodStart: instantOf(periodStart),
    timesheetId: line.timesheetId ? new Types.ObjectId(line.timesheetId) : null,
    timesheetStatus: line.timesheetStatus,
    timesheetApproved: line.timesheetApproved,
    settledPeriods: line.settledPeriods.map(instantOf),
    negativeNet: line.breakdown.negativeNet,
    flags: line.flags.map((flag) => ({ kind: flag.kind, items: [...flag.items] })),
    manualEntryCount: line.manualEntryCount,
    grossCentavos: await encryptSensitive(totals.grossCentavos),
    deductionsCentavos: await encryptSensitive(totals.deductionsCentavos),
    netPayCentavos: await encryptSensitive(totals.netPayCentavos),
    reimbursementsCentavos: await encryptSensitive(totals.reimbursementsCentavos),
    breakdown: await encryptSensitive(serializePayrollBreakdown(line.breakdown)),
    breakdownVersion: PAYROLL_BREAKDOWN_VERSION,
    createdBy: by,
    updatedBy: by,
  };
}

/** Encrypts a computed run outside any transaction (a retried transaction reuses it). */
async function encryptRun(
  computed: ComputedPayrollRun,
  runId: Types.ObjectId,
  actorId: string | null,
) {
  const [totals, lines] = await Promise.all([
    encryptedTotals(computed.totals),
    Promise.all(
      computed.lines.map((line) => encryptedLine(line, runId, computed.cutOff.start, actorId)),
    ),
  ]);
  return {
    totals,
    lines,
    recompute: {
      settingVersions: computed.settingVersions,
      employeeCount: computed.lines.length,
      leftOut: computed.leftOut.map((row) => ({
        employeeId: new Types.ObjectId(row.employeeId),
        reason: row.reason,
      })),
      flagCounts: { ...computed.flagCounts },
    },
  };
}

async function insertLines(
  lines: Awaited<ReturnType<typeof encryptedLine>>[],
  session: ClientSession,
): Promise<void> {
  if (lines.length === 0) return;
  await PayrollRunEmployeeModel.bulkWrite(
    lines.map((document) => ({ insertOne: { document } })),
    { session, ordered: true },
  );
}

/** Re-reads the account in the transaction and checks it may still compute. */
async function recheckActor(actor: ComputeActor, session: ClientSession): Promise<void> {
  if (!actor) return;
  assertCanComputePayrollRuns(await reloadActorAccess({ id: actor.id }, session));
}

/** Every active HR user, or the active System Administrators when none is (decision 342). */
async function hrRecipients(session: ClientSession): Promise<string[]> {
  const hr = await activeHrUserIds({ session });
  if (hr.length > 0) return hr;
  return (await activeSystemAdministrators(session)).map((admin) => admin.userId.toHexString());
}

export interface StoreDraftOptions {
  actor: ComputeActor;
  today?: BusinessDate;
  versions?: PayrollRunVersions;
  /** The job: notify HR in the same transaction (`talent.payrollDraftReady`). */
  notifyHr?: boolean;
}

/**
 * Computes and stores the draft of `cutOff` (no checks of the cut-off itself: the callers make
 * them). Refuses with {@link PAYROLL_RUN_EXISTS} when the cut-off already has a run.
 */
export async function storePayrollDraft(
  cutOff: CutOffPeriod,
  first: CutOffPeriod,
  { actor, today = businessToday(), versions, notifyHr = false }: StoreDraftOptions,
): Promise<{ id: string; number: string; employeeCount: number }> {
  const computed = await computePayrollRun(cutOff, first, { today, versions });
  const runId = new Types.ObjectId();
  const actorId = actor?.id ?? null;
  const encrypted = await encryptRun(computed, runId, actorId);
  try {
    return await withTransaction(async (session) => {
      await recheckActor(actor, session);
      const { number } = await nextDocumentNumber(PAYROLL_RUN_NUMBER_PREFIX, {
        session,
        at: instantOf(cutOff.payDate),
      });
      const by = actorId ? new Types.ObjectId(actorId) : null;
      const [run] = await PayrollRunModel.create(
        [
          {
            _id: runId,
            number,
            kind: 'regular',
            cutOffKey: cutOff.key,
            periodStart: instantOf(cutOff.start),
            periodEnd: instantOf(cutOff.end),
            payDate: instantOf(cutOff.payDate),
            contributionMonth: computed.contributionMonth,
            status: 'draft',
            computedAt: new Date(),
            computedBy: by,
            ...encrypted.recompute,
            totals: encrypted.totals,
            version: 1,
            createdBy: by,
            updatedBy: by,
          },
        ],
        { session },
      );
      if (!run) throw new Error('The payroll run was not saved.');
      await insertLines(encrypted.lines, session);
      await recordAudit(
        {
          actorId,
          actorEmail: actor?.email ?? null,
          module: 'talent',
          action: 'create',
          record: {
            type: PAYROLL_RUN_RECORD_TYPE,
            id: runId,
            label: runLabel(number, cutOff.start, cutOff.end),
          },
          before: null,
          after: snapshotForAudit(PayrollRunModel, run.toObject()),
        },
        { session },
      );
      if (notifyHr) {
        await notify(
          {
            recipients: await hrRecipients(session),
            module: 'talent',
            event: PAYROLL_DRAFT_READY_EVENT,
            title: payrollDraftReadyText(cutOff.start, cutOff.end),
            href: payrollRunHref(runId.toHexString()),
            record: { type: PAYROLL_RUN_RECORD_TYPE, id: runId },
            dedupeKey: payrollDraftReadyDedupeKey(runId.toHexString()),
          },
          { session },
        );
      }
      return { id: runId.toHexString(), number, employeeCount: computed.lines.length };
    });
  } catch (error) {
    if (isDuplicateKey(error)) throw new ActionError(PAYROLL_RUN_EXISTS);
    throw error;
  }
}

export interface RecomputeDraftOptions {
  actor: ComputeActor;
  today?: BusinessDate;
  versions?: PayrollRunVersions;
}

/** What a recompute's transaction hook is given. */
export interface PayrollRecomputeContext {
  session: ClientSession;
  /** The run as read before the recompute, and as updated (its version raised). */
  before: PayrollRunDocument;
  updated: PayrollRunDocument;
  computed: ComputedPayrollRun;
}

export interface RecomputeEditableRunOptions<T> extends RecomputeDraftOptions {
  /**
   * Called on each attempt with the run as read (already checked editable), outside the
   * transaction: throws to refuse, or returns the entries not stored yet that the compute applies
   * (a manual entry save's own entry).
   */
  prepare?: (run: PayrollRunDocument) => Promise<readonly StoredPayrollManualEntry[]>;
  /** Rechecks the actor in the transaction; by default "may compute payroll runs". */
  recheck?: (session: ClientSession) => Promise<void>;
  /** In the transaction, after the run, its lines and the run's audit entry are written. */
  inTransaction?: (context: PayrollRecomputeContext) => Promise<T>;
  /** The run's audit entry's reason; "Recomputed" by default. */
  auditReason?: string;
  /** Refuses with {@link PAYROLL_RUN_CHANGED_MESSAGE} unless the run is still at this version. */
  expectedVersion?: number;
}

/**
 * Recomputes the editable (`draft` or `returned`) run `runId` as a whole (decisions 341 and 351):
 * computed from its sources and live manual entries outside the transaction, then in one
 * transaction the run is updated only if it is still editable at the version read (filter
 * `status: { $in: ['draft', 'returned'] }`, `$inc` of `version`), its lines replaced, `update`
 * written on the run, and `inTransaction` run. Refuses a run that is gone, pending approval or
 * finalized; a recompute that loses the version race starts again (three attempts).
 */
export async function recomputeEditablePayrollRun<T = undefined>(
  runId: Types.ObjectId,
  {
    actor,
    today = businessToday(),
    versions: given,
    prepare,
    recheck,
    inTransaction,
    auditReason = 'Recomputed',
    expectedVersion,
  }: RecomputeEditableRunOptions<T>,
): Promise<{
  id: string;
  version: number;
  employeeCount: number;
  computed: ComputedPayrollRun;
  result: T | undefined;
}> {
  await connectDb();
  const versions = given ?? (await loadPayrollRunVersions());
  const actorId = actor?.id ?? null;
  for (let attempt = 0; attempt < RECOMPUTE_ATTEMPTS; attempt += 1) {
    const run = await PayrollRunModel.findById(runId).lean<PayrollRunDocument>();
    if (!run) throw new ActionError(PAYROLL_RUN_GONE);
    if (!isEditablePayrollRunStatus(run.status)) throw new ActionError(PAYROLL_RUN_NOT_EDITABLE);
    if (expectedVersion !== undefined && run.version !== expectedVersion) {
      throw new ActionError(PAYROLL_RUN_CHANGED_MESSAGE);
    }
    const pendingEntries = (await prepare?.(run)) ?? [];
    const first = await loadFirstPayrollCutOff(versions, today);
    if (!first) throw new ActionError(PAYROLL_GO_LIVE_REQUIRED_MESSAGE);
    const computed = await computePayrollRun(cutOffOfRun(run), first, {
      today,
      versions,
      runId,
      pendingEntries,
    });
    const encrypted = await encryptRun(computed, runId, actorId);
    const by = actorId ? new Types.ObjectId(actorId) : null;
    const done = await withTransaction(async (session) => {
      if (recheck) await recheck(session);
      else await recheckActor(actor, session);
      const updated = await PayrollRunModel.findOneAndUpdate(
        { _id: runId, status: { $in: [...PAYROLL_RUN_EDITABLE_STATUSES] }, version: run.version },
        {
          $set: {
            computedAt: new Date(),
            computedBy: by,
            ...encrypted.recompute,
            totals: encrypted.totals,
            updatedBy: by,
          },
          $inc: { version: 1 },
        },
        { session, returnDocument: 'after' },
      ).lean<PayrollRunDocument>();
      if (!updated) {
        const current = await PayrollRunModel.findById(runId, { status: 1 })
          .session(session)
          .lean<Pick<PayrollRunDocument, 'status'>>();
        if (!current) throw new ActionError(PAYROLL_RUN_GONE);
        if (!isEditablePayrollRunStatus(current.status)) {
          throw new ActionError(PAYROLL_RUN_NOT_EDITABLE);
        }
        if (expectedVersion !== undefined) throw new ActionError(PAYROLL_RUN_CHANGED_MESSAGE);
        return null; // Another recompute won: start again from its version.
      }
      await PayrollRunEmployeeModel.deleteMany({ runId }, { session });
      await insertLines(encrypted.lines, session);
      const { before, after } = snapshotsForAudit(PayrollRunModel, run, updated);
      await recordAudit(
        {
          actorId,
          actorEmail: actor?.email ?? null,
          module: 'talent',
          action: 'update',
          record: {
            type: PAYROLL_RUN_RECORD_TYPE,
            id: runId,
            label: runLabel(run.number, dayOf(run.periodStart), dayOf(run.periodEnd)),
          },
          before,
          after,
          reason: auditReason,
        },
        { session },
      );
      const result = inTransaction
        ? await inTransaction({ session, before: run, updated, computed })
        : undefined;
      return {
        id: runId.toHexString(),
        version: updated.version,
        employeeCount: computed.lines.length,
        computed,
        result,
      };
    });
    if (done) return done;
  }
  throw new ActionError(PAYROLL_RUN_BUSY);
}

/**
 * Recomputes the editable run `runId` (step 2.9's name; a `draft` or, from step 2.10, a
 * `returned` run): see {@link recomputeEditablePayrollRun}.
 */
export async function recomputePayrollDraft(
  runId: Types.ObjectId,
  options: RecomputeDraftOptions,
): Promise<{ id: string; version: number; employeeCount: number }> {
  const { id, version, employeeCount } = await recomputeEditablePayrollRun(runId, options);
  return { id, version, employeeCount };
}

/**
 * Server-only, for the submit (step 2.10's chunk C2): computes the stored run `runId` from its
 * sources and live manual entries as they are now, writing nothing. No access check.
 */
export async function computeStoredPayrollRun(
  run: Pick<PayrollRunDocument, '_id' | 'cutOffKey' | 'periodStart' | 'periodEnd' | 'payDate'>,
  {
    today = businessToday(),
    versions: given,
  }: { today?: BusinessDate; versions?: PayrollRunVersions } = {},
): Promise<ComputedPayrollRun> {
  await connectDb();
  const versions = given ?? (await loadPayrollRunVersions());
  const first = await loadFirstPayrollCutOff(versions, today);
  if (!first) throw new ActionError(PAYROLL_GO_LIVE_REQUIRED_MESSAGE);
  return computePayrollRun(cutOffOfRun(run), first, { today, versions, runId: run._id });
}

// ---------------------------------------------------------------------------------------------
// HR's actions

/**
 * "Compute draft run" (`/talent/payroll`): Talent Write and HR or the System Administrator. The
 * cut-off starting on `periodStart` must have ended (today after its end), start on or after the
 * first payroll cut-off and have no run; refused while the go-live date is null.
 */
export async function createPayrollDraftRun(
  actor: TalentActor,
  input: { periodStart: string },
): Promise<{ id: string; number: string }> {
  assertCanComputePayrollRuns(actor);
  if (typeof input?.periodStart !== 'string' || !isBusinessDate(input.periodStart)) {
    throw new ActionError(PAYROLL_CUT_OFF_INVALID);
  }
  await connectDb();
  const today = businessToday();
  const versions = await loadPayrollRunVersions();
  const first = await loadFirstPayrollCutOff(versions, today);
  if (!first) throw new ActionError(PAYROLL_GO_LIVE_REQUIRED_MESSAGE);
  const cutOff = cutOffStartingOn(input.periodStart, versions);
  if (!cutOff || cutOff.end >= today || cutOff.start < first.start) {
    throw new ActionError(PAYROLL_CUT_OFF_INVALID);
  }
  if (await PayrollRunModel.exists({ kind: 'regular', periodStart: instantOf(cutOff.start) })) {
    throw new ActionError(PAYROLL_RUN_EXISTS);
  }
  const { id, number } = await storePayrollDraft(cutOff, first, { actor, today, versions });
  return { id, number };
}

/** "Recompute" on a draft run: Talent Write and HR or the System Administrator. */
export async function recomputePayrollRun(
  actor: TalentActor,
  input: { runId: string },
): Promise<{ id: string; version: number }> {
  assertCanComputePayrollRuns(actor);
  const runId = objectIdOf(input?.runId);
  if (!runId) throw new ActionError(PAYROLL_RUN_GONE);
  const { id, version } = await recomputePayrollDraft(runId, { actor });
  return { id, version };
}

// ---------------------------------------------------------------------------------------------
// Views

/** One run on `/talent/payroll` (no amount). */
export interface PayrollRunListRow {
  id: string;
  number: string;
  kind: PayrollRunKind;
  status: PayrollRunStatus;
  statusLabel: string;
  cutOffKey: CutOffKey;
  periodStart: BusinessDate;
  periodEnd: BusinessDate;
  periodText: string;
  payDate: BusinessDate;
  employeeCount: number;
  leftOutCount: number;
  computedAt: Date;
  /** The user who last computed it, or null for the nightly job and the listener. */
  computedByName: string | null;
}

/** An ended cut-off with no run, for "Compute draft run". */
export interface PayrollCreatableCutOff {
  cutOffKey: CutOffKey;
  periodStart: BusinessDate;
  periodEnd: BusinessDate;
  periodText: string;
  payDate: BusinessDate;
}

export interface PayrollRunListView {
  /** Newest first. */
  runs: PayrollRunListRow[];
  /** "Compute draft run" is offered (Talent Write and HR or the System Administrator). */
  canCompute: boolean;
  goLiveDate: BusinessDate | null;
  /** The message to show while the go-live date is null; null once set. */
  goLiveMissingMessage: string | null;
  /** The first payroll cut-off's start, or null. */
  firstPeriodStart: BusinessDate | null;
  /** Ended cut-offs on or after the first payroll cut-off with no run, newest first. */
  creatable: PayrollCreatableCutOff[];
}

/** The most cut-offs "Compute draft run" lists. */
const CREATABLE_MAX = 48;

async function computedByNames(runs: readonly Pick<PayrollRunDocument, 'computedBy'>[]) {
  const ids = runs.flatMap((run) => (run.computedBy ? [run.computedBy] : []));
  return userNames(ids);
}

function listRowOf(run: PayrollRunDocument, names: Map<string, string>): PayrollRunListRow {
  const periodStart = dayOf(run.periodStart);
  const periodEnd = dayOf(run.periodEnd);
  return {
    id: run._id.toHexString(),
    number: run.number,
    kind: run.kind,
    status: run.status,
    statusLabel: PAYROLL_RUN_STATUS_LABELS[run.status],
    cutOffKey: run.cutOffKey,
    periodStart,
    periodEnd,
    periodText: payrollPeriodText(periodStart, periodEnd),
    payDate: dayOf(run.payDate),
    employeeCount: run.employeeCount,
    leftOutCount: run.leftOut.length,
    computedAt: run.computedAt,
    computedByName: run.computedBy ? (names.get(run.computedBy.toHexString()) ?? null) : null,
  };
}

/**
 * `/talent/payroll`: every run, newest first, with no amount, and the ended cut-offs HR may
 * compute. Talent Read and HR, Accounting or the System Administrator.
 */
export async function listPayrollRuns(actor: TalentActor): Promise<PayrollRunListView> {
  assertCanSeePayrollRuns(actor);
  await connectDb();
  const today = businessToday();
  const versions = await loadPayrollRunVersions();
  const [runs, first] = await Promise.all([
    PayrollRunModel.find({}).sort({ periodStart: -1, _id: -1 }).lean<PayrollRunDocument[]>(),
    loadFirstPayrollCutOff(versions, today),
  ]);
  const names = await computedByNames(runs);
  const taken = new Set(
    runs.filter((run) => run.kind === 'regular').map((run) => dayOf(run.periodStart)),
  );
  const creatable: PayrollCreatableCutOff[] = [];
  if (first) {
    const latest = latestEndedCutOff(today, versions.payroll);
    let period = latest ? periodOrNull(latest.start, versions.payroll) : null;
    while (period && period.start >= first.start && creatable.length < CREATABLE_MAX) {
      if (!taken.has(period.start)) {
        creatable.push({
          cutOffKey: period.key,
          periodStart: period.start,
          periodEnd: period.end,
          periodText: payrollPeriodText(period.start, period.end),
          payDate: period.payDate,
        });
      }
      if (period.start === first.start) break;
      period = previousCutOff(period, versions.payroll);
    }
  }
  const { goLiveDate } = await leaveSettingsOn(today);
  return {
    runs: runs.map((run) => listRowOf(run, names)),
    canCompute: canComputePayrollRuns(actor),
    goLiveDate,
    goLiveMissingMessage: goLiveDate ? null : PAYROLL_GO_LIVE_REQUIRED_MESSAGE,
    firstPeriodStart: first?.start ?? null,
    creatable,
  };
}

/** One review flag on a person (plain, no amount). */
export interface PayrollRunFlagRow {
  kind: PayrollFlagKind;
  /** "Onboarding incomplete". */
  label: string;
  /** The badge: "Onboarding incomplete: payroll bank account not verified", or the label. */
  text: string;
  /** `<item>:<state>` for onboarding, the days for minimum wage, the entry ids for stale. */
  items: string[];
  /** "Acknowledge" applies (never net pay below zero or a stale manual entry). */
  acknowledgeable: boolean;
  /** HR's acknowledgement of this flag for this run and employee, or null. */
  acknowledgement: {
    reason: string;
    /** "Acknowledged: <reason>". */
    text: string;
    byName: string | null;
    at: Date;
  } | null;
  /** Still in the way of a submit: not acknowledgeable, or not acknowledged. */
  unresolved: boolean;
}

/** One person on the run page. `netPayCentavos` is null until "Show amounts". */
export interface PayrollRunPersonRow {
  lineId: string;
  employeeId: string;
  name: string;
  employeeNumber: string;
  department: string | null;
  timesheetType: TimesheetType | null;
  timesheetStatus: TimesheetStatus | null;
  timesheetApproved: boolean;
  /** "Timesheet not approved · basic pay only". */
  provisional: boolean;
  /** "Settles earlier cut-offs". */
  settles: boolean;
  /** "Net pay below zero". */
  negativeNet: boolean;
  netPayCentavos: Centavos | null;
  /** Step 2.10: the line's review flags, in the engine's order. */
  flags: PayrollRunFlagRow[];
  /** Step 2.10: any flag still in the way of a submit. */
  unresolved: boolean;
  /** Step 2.10: the live manual entries on the line ("Manual" when above 0). */
  manualEntryCount: number;
  /**
   * Step 2.10: the viewer may add, edit and remove this line's manual entries (an editable run;
   * Talent Write and HR or the System Administrator, or for HR staff the System Administrator or a
   * Board member; never their own line).
   */
  canEnterManualEntries: boolean;
}

export interface PayrollRunLeftOutRow {
  employeeId: string;
  name: string;
  employeeNumber: string;
  reason: PayrollLeftOutReason;
  reasonLabel: string;
}

/** One live manual entry on the run page's "Manual entries" list. */
export interface PayrollRunManualEntryRow {
  id: string;
  /** The employee's line, or null when they are no longer in the run. */
  lineId: string | null;
  employeeId: string;
  name: string;
  employeeNumber: string;
  kind: PayrollManualEntryKind;
  kindLabel: string;
  /** Printed on the payslip; an override's is its line's label. */
  label: string;
  targetLineKey: string | null;
  taxable: boolean | null;
  reducesTaxablePay: boolean | null;
  authorizedInWriting: boolean | null;
  countsAsBasicSalary: boolean | null;
  reason: string;
  enteredByName: string | null;
  enteredAt: Date;
  /** True when the entry replaced an earlier version (its History). */
  edited: boolean;
  /** Why it needs review (`manualEntryStale`), or null when applied. */
  staleReason: PayrollManualStaleReason | null;
  staleText: string | null;
  /** Null until "Show amounts". */
  amountCentavos: Centavos | null;
  /** An override's computed amount; null until "Show amounts", and for other kinds. */
  computedAmountCentavos: Centavos | null;
}

export interface PayrollRunView extends PayrollRunListRow {
  contributionMonth: string;
  version: number;
  /** Step 2.10: `draft` or `returned`, so it may be recomputed, given entries and acknowledged. */
  editable: boolean;
  /** "Recompute" is offered: an editable run, and the viewer may compute. */
  canRecompute: boolean;
  /** Step 2.10: "Acknowledge" and "Acknowledge all" are offered. */
  canAcknowledge: boolean;
  tiles: {
    employees: number;
    timesheetNotApproved: number;
    negativeNet: number;
    leftOut: number;
    /** Step 2.10. */
    onboardingIncomplete: number;
    belowMinimumWage: number;
    /** Lines with a stale entry, plus employees with live entries but no line. */
    manualEntryStale: number;
  };
  /** Step 2.10: the stored per-flag counts of the last compute. */
  flagCounts: PayrollFlagCounts;
  /** Step 2.10: employees with a flag still in the way of a submit (no line ones included). */
  unresolvedFlaggedEmployees: number;
  /** Step 2.10: acknowledgements whose flag is on its line now. */
  acknowledgedFlagCount: number;
  /** Step 2.10: live manual entries (the submit sheet's count). */
  manualEntryCount: number;
  /** Step 2.10: the live manual entries, by person then oldest first. */
  manualEntries: PayrollRunManualEntryRow[];
  /** By last name, then first name. */
  people: PayrollRunPersonRow[];
  leftOut: PayrollRunLeftOutRow[];
  /** True after "Show amounts" (the reveal written first). */
  amountsShown: boolean;
  /** The run's totals; null until "Show amounts". */
  totals: PayrollTotals | null;
  /** Step 2.10: the latest submit, return and the finalize, plain. */
  submittedAt: Date | null;
  submittedByName: string | null;
  returnedAt: Date | null;
  returnedByName: string | null;
  /** The Board member's remarks of the latest return (shown on a `returned` run). */
  returnRemarks: string | null;
  finalizedAt: Date | null;
  finalizedByName: string | null;
  payslipsPending: boolean;
  /** How many lines have their payslip PDF rendered ("Payslips: 2 of 2 ready"); 0 until finalized. */
  payslipsReadyCount: number;
  /** `notPosted` on a finalized run (the Fiscal placeholder), else null. */
  fiscalPostingStatus: PayrollFiscalPostingStatus | null;
}

type LineRow = Pick<
  PayrollRunEmployeeDocument,
  | '_id'
  | 'employeeId'
  | 'timesheetId'
  | 'timesheetStatus'
  | 'timesheetApproved'
  | 'settledPeriods'
  | 'negativeNet'
  | 'flags'
  | 'manualEntryCount'
> & { netPayCentavos?: unknown; payslip?: { fileId?: Types.ObjectId | null } | null };

async function decryptNumber(value: unknown): Promise<Centavos> {
  const decrypted = await decryptSensitive(value);
  if (typeof decrypted !== 'number' || !Number.isSafeInteger(decrypted)) {
    // Never put the value in the message.
    throw new Error('A stored payroll amount is not whole centavos.');
  }
  return decrypted;
}

/** Writes and commits a `reveal` entry (field names only), before anything is decrypted. */
async function recordReveal(
  actor: TalentActor,
  record: { type: string; id: Types.ObjectId; label: string | null },
  field: string,
): Promise<void> {
  await recordAudit({
    actorId: actor.id,
    actorEmail: actor.email,
    module: 'talent',
    action: 'reveal',
    record,
    before: null,
    after: null,
    fields: [field],
  });
}

/**
 * Writes and commits the run's "Show amounts" `reveal` (field `amounts`, labelled
 * `<number> · <period>`). Server-only, for the Board's view (chunk C2), which checks the viewer
 * itself before calling it and before {@link buildPayrollRunView} with amounts.
 */
export async function recordPayrollRunAmountsReveal(
  actor: TalentActor,
  run: Pick<PayrollRunDocument, '_id' | 'number' | 'periodStart' | 'periodEnd'>,
): Promise<void> {
  await recordReveal(
    actor,
    {
      type: PAYROLL_RUN_RECORD_TYPE,
      id: run._id,
      label: runLabel(run.number, dayOf(run.periodStart), dayOf(run.periodEnd)),
    },
    PAYROLL_RUN_AMOUNTS_FIELD,
  );
}

/** A stored acknowledgement, plain. */
interface AcknowledgementRow {
  employeeId: Types.ObjectId;
  flag: PayrollAcknowledgeableFlag;
  reason: string;
  createdAt: Date;
  createdBy: Types.ObjectId | null;
}

/** Every acknowledgement of a run (`payrollFlagAcknowledgements`), oldest first. */
export async function loadPayrollFlagAcknowledgements(
  runId: Types.ObjectId,
  { session = null }: { session?: ClientSession | null } = {},
): Promise<AcknowledgementRow[]> {
  return PayrollFlagAcknowledgementModel.find(
    { runId },
    { employeeId: 1, flag: 1, reason: 1, createdAt: 1, createdBy: 1 },
  )
    .sort({ createdAt: 1, _id: 1 })
    .session(session)
    .lean<AcknowledgementRow[]>();
}

/**
 * The employees whose flags are still in the way of a submit (decision 361): a line with net pay
 * below zero or a stale manual entry, or a flag not acknowledged; and each employee with a live
 * manual entry but no line (stale, `employeeNotInRun`). Pure: from the lines' stored flags, the
 * acknowledgements and the live entries' employees.
 */
export function unresolvedFlaggedEmployeesOf(
  lines: readonly { employeeId: Types.ObjectId | string; flags: readonly PayrollLineFlag[] }[],
  acknowledgements: readonly { employeeId: Types.ObjectId | string; flag: string }[],
  liveEntryEmployeeIds: readonly string[] = [],
): string[] {
  const idOf = (id: Types.ObjectId | string) => (typeof id === 'string' ? id : id.toHexString());
  const acknowledged = new Map<string, PayrollFlagKind[]>();
  for (const row of acknowledgements) {
    const key = idOf(row.employeeId);
    acknowledged.set(key, [...(acknowledged.get(key) ?? []), row.flag as PayrollFlagKind]);
  }
  const withLine = new Set<string>();
  const result = new Set<string>();
  for (const line of lines) {
    const employeeId = idOf(line.employeeId);
    withLine.add(employeeId);
    if (unresolvedPayrollFlags(line.flags, acknowledged.get(employeeId) ?? []).length > 0) {
      result.add(employeeId);
    }
  }
  for (const employeeId of liveEntryEmployeeIds) {
    if (!withLine.has(employeeId)) result.add(employeeId);
  }
  return [...result];
}

const nameOf = (identity: EmployeeIdentity | undefined) =>
  identity ? `${identity.firstName} ${identity.lastName}` : 'Unknown employee';

function nameFrom(names: Map<string, string>, id: Types.ObjectId | string | null | undefined) {
  if (!id) return null;
  return names.get(typeof id === 'string' ? id : id.toHexString()) ?? null;
}

/**
 * The run page's view of `run` with no access check (the callers check it): with `showAmounts`,
 * the caller has written and committed the `reveal` first, and each person's net pay, the totals,
 * each manual entry's amount and an override's computed amount are decrypted. Server-only:
 * `getPayrollRunView` here, and the Board's view (chunk C2) with `viewer` null-able controls.
 */
export async function buildPayrollRunView(
  run: PayrollRunDocument,
  {
    viewer,
    showAmounts = false,
    readOnly = false,
  }: {
    /** The viewer, for the controls they are offered. */
    viewer: TalentActor;
    showAmounts?: boolean;
    /** No control at all (the Board's view). */
    readOnly?: boolean;
  },
): Promise<PayrollRunView> {
  const id = run._id;
  const linesQuery = PayrollRunEmployeeModel.find(
    { runId: id },
    {
      employeeId: 1,
      timesheetId: 1,
      timesheetStatus: 1,
      timesheetApproved: 1,
      settledPeriods: 1,
      negativeNet: 1,
      flags: 1,
      manualEntryCount: 1,
      'payslip.fileId': 1,
    },
  );
  if (showAmounts) linesQuery.select('+netPayCentavos');
  const totalsQuery = showAmounts
    ? PayrollRunModel.findById(id)
        .select(PAYROLL_RUN_TOTAL_PATHS.map((path) => `+totals.${path}`).join(' '))
        .lean<Pick<PayrollRunDocument, 'totals'>>()
    : Promise.resolve(null);
  const [lines, withTotals, identities, entries, acknowledgements] = await Promise.all([
    linesQuery.lean<LineRow[]>(),
    totalsQuery,
    listEmployeeIdentities(PAYROLL_READER, { separated: true }),
    loadPayrollManualEntries(id, { withAmounts: showAmounts }),
    loadPayrollFlagAcknowledgements(id),
  ]);
  const live = livePayrollManualEntries(entries);
  const names = await userNames([
    ...[run.computedBy, run.submittedBy, run.returnedBy, run.finalizedBy].flatMap((user) =>
      user ? [user] : [],
    ),
    ...live.flatMap((entry) => (entry.createdBy ? [new Types.ObjectId(entry.createdBy)] : [])),
    ...acknowledgements.flatMap((row) => (row.createdBy ? [row.createdBy] : [])),
  ]);
  const timesheetIds = lines.flatMap((line) => (line.timesheetId ? [line.timesheetId] : []));
  const timesheets = timesheetIds.length
    ? await TimesheetModel.find({ _id: { $in: timesheetIds } }, { timesheetType: 1 }).lean<
        Pick<TimesheetDocument, '_id' | 'timesheetType'>[]
      >()
    : [];
  const typeOf = new Map(timesheets.map((row) => [row._id.toHexString(), row.timesheetType]));
  const order = new Map(identities.map((identity, index) => [identity.employeeId, index]));
  const byId = new Map(identities.map((identity) => [identity.employeeId, identity]));
  const lineOf = new Map(lines.map((line) => [line.employeeId.toHexString(), line]));

  // The applied entries' stale reasons and an override's computed amount live in the line's
  // breakdown: read only for lines with a stale entry, and with amounts shown for lines with
  // entries. Nothing but the reason (and, after the reveal, the computed amount) is sent.
  const applied = new Map<string, PayrollBreakdown['manualEntries'][number]>();
  const breakdownLines = lines.filter((line) =>
    showAmounts
      ? (line.manualEntryCount ?? 0) > 0
      : (line.flags ?? []).some((flag) => flag.kind === 'manualEntryStale'),
  );
  if (breakdownLines.length > 0) {
    const stored = await PayrollRunEmployeeModel.find({
      _id: { $in: breakdownLines.map((line) => line._id) },
    })
      .select('+breakdown')
      .lean<{ breakdown?: unknown }[]>();
    for (const row of stored) {
      if (!row.breakdown) continue;
      const breakdown = parsePayrollBreakdown(String(await decryptSensitive(row.breakdown)));
      for (const entry of breakdown.manualEntries) applied.set(entry.entryId, entry);
    }
  }

  const editable = isEditablePayrollRunStatus(run.status);
  const canCompute = !readOnly && canComputePayrollRuns(viewer);
  const canAcknowledge = editable && !readOnly && canAcknowledgePayrollFlags(viewer);
  const acknowledgementOf = new Map(
    acknowledgements.map((row) => [`${row.employeeId.toHexString()}:${row.flag}`, row]),
  );

  const people: PayrollRunPersonRow[] = await Promise.all(
    [...lines]
      .sort(
        (a, b) =>
          (order.get(a.employeeId.toHexString()) ?? Number.MAX_SAFE_INTEGER) -
          (order.get(b.employeeId.toHexString()) ?? Number.MAX_SAFE_INTEGER),
      )
      .map(async (line) => {
        const employeeId = line.employeeId.toHexString();
        const identity = byId.get(employeeId);
        const flags: PayrollRunFlagRow[] = (line.flags ?? []).map((flag) => {
          const acknowledgeable = isAcknowledgeableFlag(flag.kind);
          const found = acknowledgeable
            ? acknowledgementOf.get(`${employeeId}:${flag.kind}`)
            : undefined;
          return {
            kind: flag.kind,
            label: PAYROLL_FLAG_LABELS[flag.kind],
            text: payrollFlagText(flag),
            items: [...flag.items],
            acknowledgeable,
            acknowledgement: found
              ? {
                  reason: found.reason,
                  text: payrollAcknowledgedText(found.reason),
                  byName: nameFrom(names, found.createdBy),
                  at: found.createdAt,
                }
              : null,
            unresolved: !acknowledgeable || !found,
          };
        });
        return {
          lineId: line._id.toHexString(),
          employeeId,
          name: nameOf(identity),
          employeeNumber: identity?.employeeNumber ?? '',
          department: identity?.department?.name ?? null,
          timesheetType:
            (line.timesheetId ? typeOf.get(line.timesheetId.toHexString()) : undefined) ??
            identity?.position?.timesheetType ??
            null,
          timesheetStatus: line.timesheetStatus,
          timesheetApproved: line.timesheetApproved,
          provisional: !line.timesheetApproved,
          settles: line.settledPeriods.length > 1,
          negativeNet: line.negativeNet,
          netPayCentavos: showAmounts ? await decryptNumber(line.netPayCentavos) : null,
          flags,
          unresolved: flags.some((flag) => flag.unresolved),
          manualEntryCount: line.manualEntryCount ?? 0,
          canEnterManualEntries:
            editable &&
            !readOnly &&
            identity !== undefined &&
            payrollManualEntryRefusal(viewer, targetOf(identity)) === null,
        };
      }),
  );

  const manualEntries: PayrollRunManualEntryRow[] = [...live]
    .sort(
      (a, b) =>
        (order.get(a.employeeId) ?? Number.MAX_SAFE_INTEGER) -
          (order.get(b.employeeId) ?? Number.MAX_SAFE_INTEGER) ||
        a.createdAt.getTime() - b.createdAt.getTime(),
    )
    .map((entry) => {
      const identity = byId.get(entry.employeeId);
      const line = lineOf.get(entry.employeeId);
      const record = applied.get(entry.id);
      const staleReason: PayrollManualStaleReason | null = line
        ? (record?.staleReason ?? null)
        : 'employeeNotInRun';
      return {
        id: entry.id,
        lineId: line ? line._id.toHexString() : null,
        employeeId: entry.employeeId,
        name: nameOf(identity),
        employeeNumber: identity?.employeeNumber ?? '',
        kind: entry.kind,
        kindLabel: PAYROLL_MANUAL_ENTRY_KIND_LABELS[entry.kind],
        label: entry.label,
        targetLineKey: entry.targetLineKey,
        taxable: entry.taxable,
        reducesTaxablePay: entry.reducesTaxablePay,
        authorizedInWriting: entry.authorizedInWriting,
        countsAsBasicSalary: entry.countsAsBasicSalary,
        reason: entry.reason,
        enteredByName: nameFrom(names, entry.createdBy),
        enteredAt: entry.createdAt,
        edited: entry.supersedesId !== null,
        staleReason,
        staleText: staleReason ? PAYROLL_MANUAL_STALE_REASON_LABELS[staleReason] : null,
        amountCentavos: showAmounts ? entry.amountCentavos : null,
        computedAmountCentavos:
          showAmounts && entry.kind === 'override'
            ? (record?.computedAmountCentavos ?? null)
            : null,
      };
    });

  let totals: PayrollTotals | null = null;
  if (withTotals) {
    const decrypted = await Promise.all(
      PAYROLL_RUN_TOTAL_PATHS.map(
        async (path) => [path, await decryptNumber(withTotals.totals[path])] as const,
      ),
    );
    totals = Object.fromEntries(decrypted) as unknown as PayrollTotals;
  }
  const flagLines = lines.map((line) => ({
    employeeId: line.employeeId,
    flags: line.flags ?? [],
  }));
  const linesWith = (kind: PayrollFlagKind) =>
    flagLines.filter((line) => line.flags.some((flag) => flag.kind === kind)).length;
  const orphanEmployees = new Set(
    live.filter((entry) => !lineOf.has(entry.employeeId)).map((entry) => entry.employeeId),
  ).size;
  const row = listRowOf(run, names);
  return {
    ...row,
    contributionMonth: run.contributionMonth,
    version: run.version,
    editable,
    canRecompute: editable && canCompute,
    canAcknowledge,
    tiles: {
      employees: lines.length,
      timesheetNotApproved: lines.filter((line) => !line.timesheetApproved).length,
      negativeNet: lines.filter((line) => line.negativeNet).length,
      leftOut: run.leftOut.length,
      onboardingIncomplete: linesWith('onboardingIncomplete'),
      belowMinimumWage: linesWith('belowMinimumWage'),
      manualEntryStale: linesWith('manualEntryStale') + orphanEmployees,
    },
    flagCounts: { ...countPayrollFlags([]), ...(run.flagCounts ?? {}) },
    unresolvedFlaggedEmployees: unresolvedFlaggedEmployeesOf(
      flagLines,
      acknowledgements.map((ack) => ({ employeeId: ack.employeeId, flag: ack.flag })),
      live.map((entry) => entry.employeeId),
    ).length,
    acknowledgedFlagCount: acknowledgements.filter((ack) =>
      (lineOf.get(ack.employeeId.toHexString())?.flags ?? []).some(
        (flag) => flag.kind === ack.flag,
      ),
    ).length,
    manualEntryCount: live.length,
    manualEntries,
    people,
    leftOut: run.leftOut.map((entry) => {
      const employeeId = entry.employeeId.toHexString();
      const identity = byId.get(employeeId);
      return {
        employeeId,
        name: nameOf(identity),
        employeeNumber: identity?.employeeNumber ?? '',
        reason: entry.reason,
        reasonLabel: PAYROLL_LEFT_OUT_REASON_LABELS[entry.reason],
      };
    }),
    amountsShown: showAmounts,
    totals,
    submittedAt: run.submittedAt ?? null,
    submittedByName: nameFrom(names, run.submittedBy),
    returnedAt: run.returnedAt ?? null,
    returnedByName: nameFrom(names, run.returnedBy),
    returnRemarks: run.returnRemarks ?? null,
    finalizedAt: run.finalizedAt ?? null,
    finalizedByName: nameFrom(names, run.finalizedBy),
    payslipsPending: run.payslipsPending ?? false,
    payslipsReadyCount: lines.filter((line) => Boolean(line.payslip?.fileId)).length,
    fiscalPostingStatus: run.fiscalPosting?.status ?? null,
  };
}

/**
 * A run (`/talent/payroll/<runId>`): its period, status, tiles, flags, manual entries, people and
 * the people left out, with no amount. With `showAmounts` ("Show amounts"), a `reveal` entry on
 * the run (field `amounts`) is written and committed first, then each person's net pay, the
 * totals and each manual entry's amount are decrypted. Talent Read and HR, Accounting or the
 * System Administrator. Null when there is no such run.
 */
export async function getPayrollRunView(
  actor: TalentActor,
  runId: string,
  { showAmounts = false }: { showAmounts?: boolean } = {},
): Promise<PayrollRunView | null> {
  assertCanSeePayrollRuns(actor);
  const id = objectIdOf(runId);
  if (!id) return null;
  await connectDb();
  const run = await PayrollRunModel.findById(id).lean<PayrollRunDocument>();
  if (!run) return null;
  if (showAmounts) await recordPayrollRunAmountsReveal(actor, run);
  return buildPayrollRunView(run, { viewer: actor, showAmounts });
}

// ---------------------------------------------------------------------------------------------
// The breakdown sheet

/** A line an override may replace, for the manual entry sheet (decision 356). */
export interface PayrollOverrideTarget {
  key: string;
  label: string;
  /** The amount the engine computed (an overridden line's computed amount), or 0 when none. */
  computedAmountCentavos: Centavos;
  /** True when a live override applies to it now. */
  overridden: boolean;
}

/**
 * The lines of `breakdown` an override may replace: basic pay and each per cut-off allowance on
 * the line, then the contribution, EC and tax keys, which are always targets (at ₱0.00 when not
 * on the line). Each with its label (an override's label) and computed amount.
 */
export function payrollOverrideTargets(
  breakdown: Pick<PayrollBreakdown, 'lines'>,
): PayrollOverrideTarget[] {
  const own = breakdown.lines.filter(
    (line) =>
      line.group === 'earnings' &&
      line.side === 'earning' &&
      line.kind !== 'manual' &&
      overrideTargetRefusal(line.key) === null,
  );
  const targetOfLine = (line: PayrollBreakdown['lines'][number]): PayrollOverrideTarget => ({
    key: line.key,
    label: line.label,
    computedAmountCentavos: line.override?.computedAmountCentavos ?? line.amountCentavos,
    overridden: line.override !== null && line.override !== undefined,
  });
  const contributions = PAYROLL_OVERRIDE_CONTRIBUTION_KEYS.map((key) => {
    const line = breakdown.lines.find(
      (candidate) => candidate.key === key && candidate.group !== 'settlements',
    );
    return line
      ? targetOfLine(line)
      : {
          key,
          label: PAYROLL_LINE_KIND_LABELS[key],
          computedAmountCentavos: 0,
          overridden: false,
        };
  });
  return [...own.map(targetOfLine), ...contributions];
}

/** One version of a manual entry in the breakdown's History (amounts after the reveal). */
export interface PayrollManualEntryVersion {
  id: string;
  kind: PayrollManualEntryKind;
  label: string;
  amountCentavos: Centavos | null;
  taxable: boolean | null;
  reducesTaxablePay: boolean | null;
  authorizedInWriting: boolean | null;
  countsAsBasicSalary: boolean | null;
  reason: string;
  /** True on a removal. */
  removed: boolean;
  enteredByName: string | null;
  enteredAt: Date;
}

/** One manual entry chain of a person in the breakdown sheet. */
export interface PayrollBreakdownManualEntry extends PayrollManualEntryVersion {
  targetLineKey: string | null;
  /** The entry is live (the latest of its chain and not removed). */
  live: boolean;
  staleReason: PayrollManualStaleReason | null;
  staleText: string | null;
  /** An override's computed amount, when applied. */
  computedAmountCentavos: Centavos | null;
  /** Earlier versions, newest first (the entry itself left out). */
  history: PayrollManualEntryVersion[];
}

/** One employee's breakdown sheet. */
export interface PayrollRunBreakdownView {
  lineId: string;
  runId: string;
  runNumber: string;
  runStatus: PayrollRunStatus;
  periodText: string;
  employee: {
    employeeId: string;
    name: string;
    employeeNumber: string;
    department: string | null;
  };
  timesheetStatus: TimesheetStatus | null;
  breakdown: PayrollBreakdown;
  /** Earnings, deductions, settlements and employer shares (empty groups left out). */
  groups: ReturnType<typeof groupPayrollLines>;
  /** Step 2.10: each manual entry chain on the line, live first, then removed ones. */
  manualEntries: PayrollBreakdownManualEntry[];
  /** Step 2.10: "Add manual entry", "Edit" and "Remove" are offered. */
  canEnterManualEntries: boolean;
  /** Step 2.10: the lines an override may replace (the manual entry sheet's choices). */
  overrideTargets: PayrollOverrideTarget[];
}

/**
 * Opens one employee's breakdown: a `reveal` entry on the line (field `breakdown`) is written and
 * committed first, then the breakdown and the line's manual entries (with their History) are
 * decrypted. Talent Read and HR, Accounting or the System Administrator. Null when there is no
 * such line, or (with `runId`) when the line belongs to another run; either is decided before any
 * reveal is written.
 */
export async function getPayrollRunBreakdown(
  actor: TalentActor,
  lineId: string,
  { runId }: { runId?: string } = {},
): Promise<PayrollRunBreakdownView | null> {
  assertCanSeePayrollRuns(actor);
  const id = objectIdOf(lineId);
  if (!id) return null;
  const expectedRunId = runId === undefined ? null : objectIdOf(runId);
  if (runId !== undefined && !expectedRunId) return null;
  await connectDb();
  const line = await PayrollRunEmployeeModel.findById(id, {
    runId: 1,
    employeeId: 1,
    timesheetStatus: 1,
  }).lean<Pick<PayrollRunEmployeeDocument, '_id' | 'runId' | 'employeeId' | 'timesheetStatus'>>();
  if (!line) return null;
  if (expectedRunId && !line.runId.equals(expectedRunId)) return null;
  const run = await PayrollRunModel.findById(line.runId, {
    number: 1,
    status: 1,
    periodStart: 1,
    periodEnd: 1,
  }).lean<Pick<PayrollRunDocument, '_id' | 'number' | 'status' | 'periodStart' | 'periodEnd'>>();
  if (!run) return null;
  const identities = await listEmployeeIdentities(PAYROLL_READER, { separated: true });
  const identity = identities.find((row) => row.employeeId === line.employeeId.toHexString());

  await recordReveal(
    actor,
    {
      type: PAYROLL_RUN_EMPLOYEE_RECORD_TYPE,
      id,
      label: `${run.number} · ${identity?.employeeNumber ?? line.employeeId.toHexString()}`,
    },
    PAYROLL_LINE_BREAKDOWN_FIELD,
  );
  const [stored, entries] = await Promise.all([
    PayrollRunEmployeeModel.findById(id).select('+breakdown').lean<{ breakdown?: unknown }>(),
    loadPayrollManualEntries(run._id, {
      withAmounts: true,
      employeeId: line.employeeId.toHexString(),
    }),
  ]);
  if (!stored?.breakdown) throw new ActionError(PAYROLL_LINE_GONE);
  const breakdown = parsePayrollBreakdown(String(await decryptSensitive(stored.breakdown)));
  const names = await userNames(
    entries.flatMap((entry) => (entry.createdBy ? [new Types.ObjectId(entry.createdBy)] : [])),
  );
  const editable = isEditablePayrollRunStatus(run.status);
  return {
    lineId: id.toHexString(),
    runId: run._id.toHexString(),
    runNumber: run.number,
    runStatus: run.status,
    periodText: payrollPeriodText(dayOf(run.periodStart), dayOf(run.periodEnd)),
    employee: {
      employeeId: line.employeeId.toHexString(),
      name: nameOf(identity),
      employeeNumber: identity?.employeeNumber ?? '',
      department: identity?.department?.name ?? null,
    },
    timesheetStatus: line.timesheetStatus,
    breakdown,
    groups: groupPayrollLines(breakdown.lines),
    manualEntries: manualEntryChains(entries, breakdown, names),
    canEnterManualEntries:
      editable &&
      identity !== undefined &&
      payrollManualEntryRefusal(actor, targetOf(identity)) === null,
    overrideTargets: payrollOverrideTargets(breakdown),
  };
}

/** Each chain of `entries` (one employee's), its head with its History; live ones first. */
function manualEntryChains(
  entries: readonly StoredPayrollManualEntry[],
  breakdown: Pick<PayrollBreakdown, 'manualEntries'>,
  names: Map<string, string>,
): PayrollBreakdownManualEntry[] {
  const superseded = new Set(
    entries.flatMap((entry) => (entry.supersedesId ? [entry.supersedesId] : [])),
  );
  const heads = entries.filter((entry) => !superseded.has(entry.id));
  const applied = new Map(breakdown.manualEntries.map((entry) => [entry.entryId, entry]));
  const versionOf = (entry: StoredPayrollManualEntry): PayrollManualEntryVersion => ({
    id: entry.id,
    kind: entry.kind,
    label: entry.label,
    amountCentavos: entry.amountCentavos,
    taxable: entry.taxable,
    reducesTaxablePay: entry.reducesTaxablePay,
    authorizedInWriting: entry.authorizedInWriting,
    countsAsBasicSalary: entry.countsAsBasicSalary,
    reason: entry.reason,
    removed: entry.removed,
    enteredByName: nameFrom(names, entry.createdBy),
    enteredAt: entry.createdAt,
  });
  return heads
    .map((head) => {
      const record = applied.get(head.id);
      const staleReason = head.removed ? null : (record?.staleReason ?? null);
      return {
        ...versionOf(head),
        targetLineKey: head.targetLineKey,
        live: !head.removed,
        staleReason,
        staleText: staleReason ? PAYROLL_MANUAL_STALE_REASON_LABELS[staleReason] : null,
        computedAmountCentavos: record?.computedAmountCentavos ?? null,
        history: payrollManualEntryHistory(entries, head.id).slice(1).map(versionOf),
      };
    })
    .sort(
      (a, b) => Number(b.live) - Number(a.live) || a.enteredAt.getTime() - b.enteredAt.getTime(),
    );
}

/**
 * Server-only, for later steps' services (2.10 review and payslips, 2.11 remittances, 2.12 basic
 * salary earned, 2.14 final pay), never for a page: one employee's stored line in a run, its
 * breakdown decrypted. No access check and no audit entry; the caller checks and audits. Null
 * when the run has no line for the employee.
 */
export async function getPayrollRunLine(
  runId: string,
  employeeId: string,
  { session = null }: { session?: ClientSession | null } = {},
): Promise<{
  lineId: string;
  runId: string;
  runStatus: PayrollRunStatus;
  employeeId: string;
  breakdown: PayrollBreakdown;
} | null> {
  const run = objectIdOf(runId);
  const employee = objectIdOf(employeeId);
  if (!run || !employee) return null;
  await connectDb();
  const [stored, runRow] = await Promise.all([
    PayrollRunEmployeeModel.findOne({ runId: run, employeeId: employee })
      .select('+breakdown')
      .session(session)
      .lean<{ _id: Types.ObjectId; breakdown?: unknown }>(),
    PayrollRunModel.findById(run, { status: 1 })
      .session(session)
      .lean<Pick<PayrollRunDocument, 'status'>>(),
  ]);
  if (!stored?.breakdown || !runRow) return null;
  return {
    lineId: stored._id.toHexString(),
    runId,
    runStatus: runRow.status,
    employeeId,
    breakdown: parsePayrollBreakdown(String(await decryptSensitive(stored.breakdown))),
  };
}
