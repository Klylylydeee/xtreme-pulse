import type { ClientSession } from 'mongoose';
import { AccessDeniedError } from '@pulse/core';
import {
  type EmployeeIdentity,
  getEmployeeIdentity,
  type IdentityActor,
  isApproverFor,
  resolveModuleAccess,
} from '@pulse/core/server';
import { TIMESHEET_APPROVAL_TYPE } from '../../timesheets/submission';
import { canViewTimesheet, TIMESHEET_DENIED, type TalentActor } from '../policy';

// Spec: SECURITY.md#exceptions-to-module-access ("The own timesheet", "Supervisors see their
// team's timesheets", and from step 2.7 the approvers of a timesheet) and decision 285 in
// docs/BUILD_PLAN.md — who may open an employee's timesheet, DTR and offset balance.
//
// Core's `getEmployeeIdentity` lets through the employee, Talent Read and an active direct
// report's supervisor. An approver of a timesheet may have none of these (an HR approver without
// Talent Read), so after Core refuses them the employee is read with the service reader below and
// the approver rule decides. The views built from it carry directory fields only about the
// employee, as for a supervisor.

/**
 * The reader the timesheet services use where no signed-in user's access applies: the approval
 * hooks, the holidays-changed listener, the reminder job, and an approver whose access was checked
 * by the approver rule. Talent Read with no employee; it sends nothing anywhere, and only the
 * employee id, number, name, dates and position type are used.
 */
export const SERVICE_READER: IdentityActor = {
  employee: null,
  moduleAccess: resolveModuleAccess({
    isSystemAdministrator: false,
    moduleAccess: { talent: 'read' },
  }),
};

/** The employee as the service reader sees them (separated included), or null. */
export function serviceIdentity(
  employeeId: string,
  options: { session?: ClientSession | null } = {},
): Promise<EmployeeIdentity | null> {
  return getEmployeeIdentity(SERVICE_READER, employeeId, {
    separated: true,
    session: options.session ?? null,
  });
}

/** True when `userId` is or was an approver on any request for the timesheet `timesheetId`. */
export function isTimesheetApprover(userId: string, timesheetId: string): Promise<boolean> {
  return isApproverFor(userId, TIMESHEET_APPROVAL_TYPE, timesheetId);
}

/**
 * The employee whose timesheet `actor` opens, after the viewing rule: the employee, Talent Read,
 * a `reportingTo` supervisor, or (when Core refuses those) whoever `approverOf` accepts, read-only.
 * Null when there is no such employee for a viewer who may look; {@link AccessDeniedError}
 * otherwise. `approver` is true when only the approver rule let them in.
 */
export async function timesheetViewerIdentity(
  actor: TalentActor,
  employeeId: string,
  approverOf: (identity: EmployeeIdentity) => Promise<boolean>,
): Promise<{ identity: EmployeeIdentity; approver: boolean } | null> {
  let identity: EmployeeIdentity | null = null;
  let denied = false;
  try {
    identity = await getEmployeeIdentity(actor, employeeId, { separated: true });
  } catch (error) {
    if (!(error instanceof AccessDeniedError)) throw error;
    denied = true;
  }
  if (identity && canViewTimesheet(actor, identity)) return { identity, approver: false };

  const subject = await serviceIdentity(employeeId);
  if (!subject) {
    if (denied || identity) throw new AccessDeniedError(TIMESHEET_DENIED);
    return null;
  }
  if (await approverOf(subject)) return { identity: subject, approver: true };
  throw new AccessDeniedError(TIMESHEET_DENIED);
}
