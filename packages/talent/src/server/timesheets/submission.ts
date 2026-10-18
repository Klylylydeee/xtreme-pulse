import type { ClientSession } from 'mongoose';
import { Types } from 'mongoose';
import { connectDb, withTransaction } from '@pulse/db';
import { AccessDeniedError, ActionError, type BusinessDate, businessToday, now } from '@pulse/core';
import {
  type EmployeeIdentity,
  employeeOnboardingFacts,
  getEmployeeIdentity,
  recordAudit,
  reloadActorAccess,
  snapshotsForAudit,
  submitApproval,
} from '@pulse/core/server';
import type { Dtr } from '../../dtr/compute';
import {
  checkOnboardingGate,
  OnboardingGateError,
  type OnboardingGateStatus,
} from '../../onboarding/gates';
import { reportingToItemState } from '../../onboarding/status';
import { isTimesheetEditable, type TimesheetStatus } from '../../timesheets/schemas';
import {
  canSubmitOn,
  nextTimesheetStatus,
  ownTimesheetHref,
  submitAuditReason,
  submitButtonLabel,
  TIMESHEET_APPROVAL_TYPE,
  timesheetApprovalSummary,
  timesheetApprovalTitle,
  timesheetAuditLabel,
  timesheetHref,
  type TimesheetSubmitFacts,
  type TimesheetSubmitProblem,
  timesheetSubmitProblemMessage,
  timesheetSubmitProblems,
} from '../../timesheets/submission';
import type {
  TimesheetSubmitProblemView,
  TimesheetSubmitSummaryView,
} from '../../timesheets/views';
import { timesheetDtr } from '../dtr/service';
import { EmployeeRecordModel } from '../employee-records/model';
import { NO_EMPLOYEE_TIMESHEET, type TalentActor } from '../policy';
import { type ReimbursementSubmitFacts, reimbursementSubmitFacts } from '../reimbursements/service';
import { dayOf, EMPLOYEE_GONE, objectIdOf } from '../shared';
import { registerTimesheetApprovalType } from './approval';
import { type TimeEntryDocument, type TimesheetDocument, TimesheetModel } from './model';
import { deadlineOf, loadTimesheetSettings, submittedLateOf } from './status';

// Spec: docs/modules/talent.md#timesheet-approval-the-dtr-and-the-offset-balance-build-step-27
// ("Submitting", "Approval", "Screens"; decisions 280–283 in docs/BUILD_PLAN.md).
//
// - Self-service: the signed-in user's own timesheet only, read from the database in the
//   transaction; another person's timesheet is simply not found. No employee id is taken.
// - In one transaction, after step 2.4's touch (so a time entry or reimbursement save in flight
//   conflicts, and the transaction retries with it visible): the timesheet is `open` or
//   `returned` and its cut-off has ended; the account is active; the onboarding gate
//   `fileTimeRequest` passes (the `reportingTo` item); no entry is still open and every closed one
//   has an activity; every live reimbursement line still holds its live receipt claim. A timesheet
//   with no entries may be submitted (the confirmation sheet warns, HANDOFF item 131).
// - The submit sets `status` (`pendingSupervisor`, or `pendingHr` when the Supervisor step is
//   skipped), `submittedAt` and `approvalRequestId`, submits the Core approval request in the same
//   transaction (a resubmission links the returned one), and writes an `update` entry on
//   `talent.timesheet` ("Submitted" or "Resubmitted"). Late submissions are accepted and read
//   "Submitted late".

export const TIMESHEET_GONE = 'This timesheet can’t be found. Reload to see it.';

/** What the submit and its confirmation sheet read about a timesheet. */
export interface GatheredSubmit {
  facts: TimesheetSubmitFacts;
  problems: TimesheetSubmitProblem[];
  onboarding: OnboardingGateStatus;
  dtr: Dtr;
  entries: TimeEntryDocument[];
  reimbursements: ReimbursementSubmitFacts;
}

/** The `reportingTo` item for the `fileTimeRequest` gate, as it is now (or in `session`). */
async function onboardingGateStatus(
  employeeId: string,
  session: ClientSession | null,
): Promise<OnboardingGateStatus> {
  const [facts, record] = await Promise.all([
    employeeOnboardingFacts([employeeId], { session }),
    EmployeeRecordModel.findOne(
      { employeeId: new Types.ObjectId(employeeId) },
      { noSupervisorConfirmation: 1 },
    )
      .session(session)
      .lean<{ noSupervisorConfirmation?: unknown }>(),
  ]);
  const fact = facts[0];
  return {
    states: {
      reportingTo: reportingToItemState({
        activeSupervisorCount: fact?.activeSupervisorCount ?? 0,
        isBoardMember: fact?.isBoardMember ?? false,
        noSupervisorConfirmed: record?.noSupervisorConfirmation != null,
      }),
    },
  };
}

/** Reads everything the submit checks and the confirmation sheet shows. Writes nothing. */
export async function gatherSubmit(
  identity: EmployeeIdentity,
  timesheet: TimesheetDocument,
  {
    session = null,
    today = businessToday(),
  }: { session?: ClientSession | null; today?: BusinessDate } = {},
): Promise<GatheredSubmit> {
  const [{ dtr, entries }, onboarding, reimbursements] = await Promise.all([
    timesheetDtr(timesheet, identity, { session, today }),
    onboardingGateStatus(identity.employeeId, session),
    reimbursementSubmitFacts(identity.employeeId, timesheet._id, session),
  ]);
  const facts: TimesheetSubmitFacts = {
    status: timesheet.status,
    periodEnd: dayOf(timesheet.periodEnd),
    today,
    openEntryDates: entries.filter((entry) => !entry.timeOut).map((entry) => dayOf(entry.date)),
    missingActivityDates: entries
      .filter((entry) => entry.timeOut && !entry.activity)
      .map((entry) => dayOf(entry.date)),
    onboardingMissing: checkOnboardingGate('fileTimeRequest', onboarding),
    unclaimedLines: reimbursements.unclaimedLines,
    accountActive: identity.active && !identity.separated,
  };
  return {
    facts,
    problems: timesheetSubmitProblems(facts),
    onboarding,
    dtr,
    entries,
    reimbursements,
  };
}

/** The number of typed times (`manual`) on the entries: each time in and time out counts once. */
function manualTimeCount(entries: readonly TimeEntryDocument[]): number {
  let count = 0;
  for (const entry of entries) {
    if (entry.timeInSource === 'manual') count += 1;
    if (entry.timeOut && entry.timeOutSource === 'manual') count += 1;
  }
  return count;
}

/** The DTR's total overtime (Overtime treatment) or offset (Offset treatment). */
function extraMinutesOf(dtr: Dtr): number {
  return dtr.treatment === 'offset' ? dtr.totals.offsetMinutes : dtr.totals.totalOvertimeMinutes;
}

/** Where the employee fixes a problem. */
function problemHref(problem: TimesheetSubmitProblem, periodStart: BusinessDate): string | null {
  switch (problem.kind) {
    case 'openEntry':
    case 'missingActivity':
      return `${ownTimesheetHref(periodStart)}#day-${problem.date}`;
    case 'onboarding':
      return '/talent/onboarding';
    case 'unclaimedLine':
      return `${ownTimesheetHref(periodStart)}#reimbursement-${problem.lineId}`;
    default:
      return null;
  }
}

/** The confirmation sheet of the employee's own `open` or `returned` timesheet. */
export function submitSummaryView(
  gathered: GatheredSubmit,
  timesheet: Pick<TimesheetDocument, 'status' | 'periodStart'>,
): TimesheetSubmitSummaryView {
  const { dtr, reimbursements } = gathered;
  const periodStart = dayOf(timesheet.periodStart);
  const problems: TimesheetSubmitProblemView[] = gathered.problems.map((problem) => ({
    problem,
    message:
      problem.kind === 'onboarding'
        ? new OnboardingGateError('fileTimeRequest', problem.items, gathered.onboarding).message
        : timesheetSubmitProblemMessage(problem),
    href: problemHref(problem, periodStart),
  }));
  return {
    buttonLabel: submitButtonLabel(timesheet.status),
    resubmit: timesheet.status === 'returned',
    daysPresent: dtr.totals.days.present,
    daysAbsent: dtr.totals.days.absentUnpaid,
    daysLate: dtr.totals.lateDays,
    treatment: dtr.treatment,
    extraMinutes: extraMinutesOf(dtr),
    reimbursementCount: reimbursements.count,
    reimbursementTotalCentavos: reimbursements.totalCentavos,
    manualTimeCount: manualTimeCount(gathered.entries),
    empty: gathered.entries.length === 0,
    problems,
  };
}

/** True when the own timesheet shows "Submit timesheet": `open` or `returned`, cut-off ended. */
export function showsSubmit(
  timesheet: Pick<TimesheetDocument, 'status' | 'periodEnd'>,
  today: BusinessDate,
): boolean {
  return isTimesheetEditable(timesheet.status) && canSubmitOn(dayOf(timesheet.periodEnd), today);
}

// ---------------------------------------------------------------------------------------------
// Submitting

export interface SubmitTimesheetInput {
  /** The employee's own timesheet (`TimesheetView.timesheet.id`). */
  timesheetId: string;
}

export interface SubmitTimesheetResult {
  timesheetId: string;
  /** `pendingSupervisor`, or `pendingHr` when the Supervisor step was skipped. */
  status: TimesheetStatus;
  approvalRequestId: string;
  submittedAt: Date;
  submittedLate: boolean;
}

/**
 * "Submit timesheet" (or "Resubmit"): self-service, the signed-in user's own `open` or `returned`
 * timesheet after its cut-off ends. Refuses with the first blocking problem's message (an
 * onboarding item with {@link OnboardingGateError}). See the file header for what it checks and
 * writes, all in one transaction.
 */
export async function submitTimesheet(
  actor: TalentActor,
  input: SubmitTimesheetInput,
): Promise<SubmitTimesheetResult> {
  if (!actor.employee) throw new AccessDeniedError(NO_EMPLOYEE_TIMESHEET);
  const timesheetId = objectIdOf(input?.timesheetId);
  if (!timesheetId) throw new ActionError(TIMESHEET_GONE);
  await connectDb();
  return withTransaction(async (session) => {
    const current = await reloadActorAccess({ id: actor.id }, session);
    if (!current.employee) throw new AccessDeniedError(NO_EMPLOYEE_TIMESHEET);
    const identity = await getEmployeeIdentity(current, current.employee.id, {
      separated: true,
      session,
    });
    if (!identity) throw new ActionError(EMPLOYEE_GONE);
    const employeeId = new Types.ObjectId(identity.employeeId);
    const own = { _id: timesheetId, employeeId };
    if (!(await TimesheetModel.exists(own).session(session))) {
      throw new ActionError(TIMESHEET_GONE);
    }

    // Step 2.4's touch: a time entry or reimbursement save of the same timesheet in flight
    // conflicts with this transaction, and the one that retries sees the other's result.
    await TimesheetModel.updateOne(
      own,
      { $set: { updatedBy: new Types.ObjectId(current.id) }, $inc: { __v: 1 } },
      { session },
    );
    const before = await TimesheetModel.findOne(own).session(session).lean<TimesheetDocument>();
    if (!before) throw new ActionError(TIMESHEET_GONE);

    const today = businessToday();
    const gathered = await gatherSubmit(identity, before, { session, today });
    const [problem] = gathered.problems;
    if (problem) {
      if (problem.kind === 'onboarding') {
        throw new OnboardingGateError('fileTimeRequest', problem.items, gathered.onboarding);
      }
      throw new ActionError(timesheetSubmitProblemMessage(problem));
    }

    const periodStart = dayOf(before.periodStart);
    const periodEnd = dayOf(before.periodEnd);
    const label = timesheetAuditLabel(identity.employeeNumber, periodStart);
    registerTimesheetApprovalType();
    const submitted = await submitApproval(
      {
        type: TIMESHEET_APPROVAL_TYPE,
        record: { type: TIMESHEET_APPROVAL_TYPE, id: before._id, label },
        title: timesheetApprovalTitle(
          identity.firstName,
          identity.lastName,
          periodStart,
          periodEnd,
        ),
        summary: timesheetApprovalSummary({
          timesheetType: before.timesheetType,
          treatment: gathered.dtr.treatment,
          workedMinutes: gathered.dtr.totals.workedMinutes,
          extraMinutes: extraMinutesOf(gathered.dtr),
          manualTimeCount: manualTimeCount(gathered.entries),
          reimbursementCount: gathered.reimbursements.count,
          reimbursementTotalCentavos: gathered.reimbursements.totalCentavos,
          overLimitCount: gathered.reimbursements.overLimitCount,
        }),
        href: timesheetHref(identity.employeeId, periodStart),
        requesterUserId: current.id,
        previousRequestId: before.status === 'returned' ? before.approvalRequestId : null,
      },
      { session },
    );
    // The HR step is never empty (it falls back to the System Administrators), so a submit is
    // always pending; anything else is a bug.
    if (submitted.status !== 'pending') {
      throw new Error('A timesheet approval request must wait for HR.');
    }
    const status = nextTimesheetStatus(before.status, 'submit', {
      supervisorStepSkipped: submitted.currentStep > 0,
    });
    if (!status) throw new Error(`A ${before.status} timesheet can't be submitted.`);

    const submittedAt = now();
    const after = await TimesheetModel.findOneAndUpdate(
      { ...own, status: before.status },
      {
        $set: {
          status,
          submittedAt,
          approvalRequestId: new Types.ObjectId(submitted.id),
          // A resubmission starts again at the Supervisor step.
          supervisorApprovedAt: null,
          supervisorApprovedBy: null,
          updatedBy: new Types.ObjectId(current.id),
        },
      },
      { session, returnDocument: 'after', runValidators: true },
    ).lean<TimesheetDocument>();
    if (!after) throw new Error('The timesheet changed while it was being submitted.');
    await recordAudit(
      {
        actorId: current.id,
        actorEmail: current.email,
        module: 'talent',
        action: 'update',
        record: { type: TIMESHEET_APPROVAL_TYPE, id: before._id, label },
        ...snapshotsForAudit(TimesheetModel, before, after),
        reason: submitAuditReason(before.status),
      },
      { session },
    );

    const deadline = deadlineOf(periodEnd, await loadTimesheetSettings(session));
    return {
      timesheetId: before._id.toHexString(),
      status,
      approvalRequestId: submitted.id,
      submittedAt,
      submittedLate: submittedLateOf(after, deadline),
    };
  });
}
