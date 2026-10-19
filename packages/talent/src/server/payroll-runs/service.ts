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
  groupPayrollLines,
  PAYROLL_BREAKDOWN_VERSION,
  PAYROLL_GO_LIVE_REQUIRED_MESSAGE,
  PAYROLL_LEFT_OUT_REASON_LABELS,
  PAYROLL_RUN_NUMBER_PREFIX,
  PAYROLL_RUN_STATUS_LABELS,
  parsePayrollBreakdown,
  type PayrollBreakdown,
  type PayrollLeftOutReason,
  payrollDraftReadyText,
  payrollPeriodText,
  type PayrollRunKind,
  type PayrollRunStatus,
  type PayrollTotals,
  previousCutOff,
  serializePayrollBreakdown,
} from '../../payroll-run';
import type { TimesheetStatus } from '../../timesheets/schemas';
import {
  assertCanComputePayrollRuns,
  assertCanSeePayrollRuns,
  canComputePayrollRuns,
  type TalentActor,
} from '../policy';
import { dayOf, instantOf, isDuplicateKey, objectIdOf } from '../shared';
import { latestEndedCutOff } from '../timesheets/status';
import { type TimesheetDocument, TimesheetModel } from '../timesheets/model';
import { periodOrNull } from '../timesheets/periods';
import {
  type ComputedPayrollLine,
  type ComputedPayrollRun,
  computePayrollRun,
  cutOffStartingOn,
  loadFirstPayrollCutOff,
  loadPayrollRunVersions,
  PAYROLL_READER,
  type PayrollRunVersions,
} from './compute';
import {
  PAYROLL_RUN_EMPLOYEE_RECORD_TYPE,
  PAYROLL_RUN_RECORD_TYPE,
  PAYROLL_RUN_TOTAL_PATHS,
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

export const PAYROLL_RUN_GONE = 'This payroll run no longer exists. Reload the page.';
export const PAYROLL_RUN_NOT_DRAFT =
  'Only a draft is recomputed, and this run has left draft. Reload the page.';
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

/**
 * Recomputes the draft `runId` as a whole (decision 341): refuses a run that is gone or has left
 * draft; a recompute that loses the version race to another starts again.
 */
export async function recomputePayrollDraft(
  runId: Types.ObjectId,
  { actor, today = businessToday(), versions: given }: RecomputeDraftOptions,
): Promise<{ id: string; version: number; employeeCount: number }> {
  await connectDb();
  const versions = given ?? (await loadPayrollRunVersions());
  const actorId = actor?.id ?? null;
  for (let attempt = 0; attempt < RECOMPUTE_ATTEMPTS; attempt += 1) {
    const run = await PayrollRunModel.findById(runId).lean<PayrollRunDocument>();
    if (!run) throw new ActionError(PAYROLL_RUN_GONE);
    if (run.status !== 'draft') throw new ActionError(PAYROLL_RUN_NOT_DRAFT);
    const first = await loadFirstPayrollCutOff(versions, today);
    if (!first) throw new ActionError(PAYROLL_GO_LIVE_REQUIRED_MESSAGE);
    const computed = await computePayrollRun(cutOffOfRun(run), first, { today, versions });
    const encrypted = await encryptRun(computed, runId, actorId);
    const by = actorId ? new Types.ObjectId(actorId) : null;
    const done = await withTransaction(async (session) => {
      await recheckActor(actor, session);
      const updated = await PayrollRunModel.findOneAndUpdate(
        { _id: runId, status: 'draft', version: run.version },
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
        if (current.status !== 'draft') throw new ActionError(PAYROLL_RUN_NOT_DRAFT);
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
          reason: 'Recomputed',
        },
        { session },
      );
      return {
        id: runId.toHexString(),
        version: updated.version,
        employeeCount: computed.lines.length,
      };
    });
    if (done) return done;
  }
  throw new ActionError(PAYROLL_RUN_BUSY);
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
}

export interface PayrollRunLeftOutRow {
  employeeId: string;
  name: string;
  employeeNumber: string;
  reason: PayrollLeftOutReason;
  reasonLabel: string;
}

export interface PayrollRunView extends PayrollRunListRow {
  contributionMonth: string;
  version: number;
  /** "Recompute" is offered: a draft, and the viewer may compute. */
  canRecompute: boolean;
  tiles: { employees: number; timesheetNotApproved: number; negativeNet: number; leftOut: number };
  /** By last name, then first name. */
  people: PayrollRunPersonRow[];
  leftOut: PayrollRunLeftOutRow[];
  /** True after "Show amounts" (the reveal written first). */
  amountsShown: boolean;
  /** The run's totals; null until "Show amounts". */
  totals: PayrollTotals | null;
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
> & { netPayCentavos?: unknown };

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
 * A run (`/talent/payroll/<runId>`): its period, status, tiles, people and the people left out,
 * with no amount. With `showAmounts` ("Show amounts"), a `reveal` entry on the run (field
 * `amounts`) is written and committed first, then each person's net pay and the totals are
 * decrypted. Talent Read and HR, Accounting or the System Administrator. Null when there is no
 * such run.
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

  if (showAmounts) {
    await recordReveal(
      actor,
      {
        type: PAYROLL_RUN_RECORD_TYPE,
        id,
        label: runLabel(run.number, dayOf(run.periodStart), dayOf(run.periodEnd)),
      },
      PAYROLL_RUN_AMOUNTS_FIELD,
    );
  }

  const linesQuery = PayrollRunEmployeeModel.find(
    { runId: id },
    {
      employeeId: 1,
      timesheetId: 1,
      timesheetStatus: 1,
      timesheetApproved: 1,
      settledPeriods: 1,
      negativeNet: 1,
    },
  );
  if (showAmounts) linesQuery.select('+netPayCentavos');
  const totalsQuery = showAmounts
    ? PayrollRunModel.findById(id)
        .select(PAYROLL_RUN_TOTAL_PATHS.map((path) => `+totals.${path}`).join(' '))
        .lean<Pick<PayrollRunDocument, 'totals'>>()
    : Promise.resolve(null);
  const [lines, withTotals, identities, names] = await Promise.all([
    linesQuery.lean<LineRow[]>(),
    totalsQuery,
    listEmployeeIdentities(PAYROLL_READER, { separated: true }),
    computedByNames([run]),
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
        return {
          lineId: line._id.toHexString(),
          employeeId,
          name: identity ? `${identity.firstName} ${identity.lastName}` : 'Unknown employee',
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
        };
      }),
  );
  let totals: PayrollTotals | null = null;
  if (withTotals) {
    const entries = await Promise.all(
      PAYROLL_RUN_TOTAL_PATHS.map(
        async (path) => [path, await decryptNumber(withTotals.totals[path])] as const,
      ),
    );
    totals = Object.fromEntries(entries) as unknown as PayrollTotals;
  }
  const row = listRowOf(run, names);
  return {
    ...row,
    contributionMonth: run.contributionMonth,
    version: run.version,
    canRecompute: run.status === 'draft' && canComputePayrollRuns(actor),
    tiles: {
      employees: lines.length,
      timesheetNotApproved: lines.filter((line) => !line.timesheetApproved).length,
      negativeNet: lines.filter((line) => line.negativeNet).length,
      leftOut: run.leftOut.length,
    },
    people,
    leftOut: run.leftOut.map((entry) => {
      const employeeId = entry.employeeId.toHexString();
      const identity = byId.get(employeeId);
      return {
        employeeId,
        name: identity ? `${identity.firstName} ${identity.lastName}` : 'Unknown employee',
        employeeNumber: identity?.employeeNumber ?? '',
        reason: entry.reason,
        reasonLabel: PAYROLL_LEFT_OUT_REASON_LABELS[entry.reason],
      };
    }),
    amountsShown: showAmounts,
    totals,
  };
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
}

/**
 * Opens one employee's breakdown: a `reveal` entry on the line (field `breakdown`) is written and
 * committed first, then the breakdown is decrypted. Talent Read and HR, Accounting or the System
 * Administrator. Null when there is no such line, or (with `runId`) when the line belongs to
 * another run; either is decided before any reveal is written.
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
  const stored = await PayrollRunEmployeeModel.findById(id)
    .select('+breakdown')
    .lean<{ breakdown?: unknown }>();
  if (!stored?.breakdown) throw new ActionError(PAYROLL_LINE_GONE);
  const breakdown = parsePayrollBreakdown(String(await decryptSensitive(stored.breakdown)));
  return {
    lineId: id.toHexString(),
    runId: run._id.toHexString(),
    runNumber: run.number,
    runStatus: run.status,
    periodText: payrollPeriodText(dayOf(run.periodStart), dayOf(run.periodEnd)),
    employee: {
      employeeId: line.employeeId.toHexString(),
      name: identity ? `${identity.firstName} ${identity.lastName}` : 'Unknown employee',
      employeeNumber: identity?.employeeNumber ?? '',
      department: identity?.department?.name ?? null,
    },
    timesheetStatus: line.timesheetStatus,
    breakdown,
    groups: groupPayrollLines(breakdown.lines),
  };
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
