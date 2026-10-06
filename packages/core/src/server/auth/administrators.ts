import type { ClientSession, Types } from 'mongoose';
import { ActionError } from '../../actions';
import { DepartmentModel } from '../departments/model';
import type { OrgStructureActor } from '../departments/service';
import { EmployeeModel } from '../employees/model';
import { toObjectId } from '../paging';
import { UserModel } from '../users/model';
import { resolveAccountStatus } from './account-status';
import { departmentRolesFor } from './roles';

// Spec: SECURITY.md#account-status and SECURITY.md#system-administrator — there is always at least
// one active System Administrator (the never-zero rule), and a change made in a transaction is
// checked against the actor's account as it is in that transaction, not as the session saw it a
// moment earlier. Shared by the user service (separating a System Administrator, disabling the
// system account) and the access service (the System Administrator switch).

const ACTOR_INACTIVE = 'Your account is no longer active, so this change wasn’t saved.';
const LAST_ADMINISTRATOR =
  'This would leave no active System Administrator. Keep another System Administrator active first.';

/** The actor's account in the transaction, or a refusal when it is gone or no longer active. */
async function activeActorAccount(actor: OrgStructureActor, session: ClientSession) {
  const actorUser = await UserModel.findById(toObjectId(actor.id), {
    email: 1,
    employeeId: 1,
    isSystemAdministrator: 1,
    isSystemAccount: 1,
    systemAccountDisabled: 1,
  })
    .session(session)
    .lean();
  const actorEmployee = actorUser?.employeeId
    ? await EmployeeModel.findById(actorUser.employeeId, { employmentStatus: 1, departmentId: 1 })
        .session(session)
        .lean()
    : null;
  if (!actorUser || resolveAccountStatus(actorUser, actorEmployee) !== 'active') {
    throw new ActionError(ACTOR_INACTIVE);
  }
  return { user: actorUser, employee: actorEmployee };
}

/**
 * Loads the actor again inside the transaction and returns them as they are now: refuses when
 * their account is gone or no longer active, and gives their current System Administrator flag
 * and department roles, so a role removed since the session loaded no longer counts.
 */
export async function reloadActor(
  actor: OrgStructureActor,
  session: ClientSession,
): Promise<OrgStructureActor> {
  const { user, employee } = await activeActorAccount(actor, session);
  let departmentCode: string | null = null;
  if (!user.isSystemAccount && employee) {
    // A retired department keeps its code, and its members keep its role until they move.
    const department = await DepartmentModel.findById(
      employee.departmentId,
      { code: 1 },
      { withDeleted: true },
    )
      .session(session)
      .lean();
    departmentCode = department?.code ?? null;
  }
  return {
    id: user._id.toHexString(),
    email: user.email,
    isSystemAdministrator: user.isSystemAdministrator,
    roles: user.isSystemAccount ? [] : departmentRolesFor(departmentCode),
  };
}

/**
 * Refuses when deactivating `targetId` would leave no active System Administrator (the system
 * account counts while active), or when the actor's own account is no longer active. Every
 * System Administrator's user record is written first, so two concurrent changes conflict and the
 * retried one counts the other's result (the same pattern as removing an allowed email domain).
 *
 * The actor is checked again here because their session was checked before the transaction: two
 * System Administrators separating each other at once would otherwise each pass as active, and
 * one separated a moment before their own request runs could still separate someone else.
 */
export async function assertAnotherAdministratorStays(
  actor: OrgStructureActor,
  targetId: Types.ObjectId,
  session: ClientSession,
): Promise<void> {
  const administrators = { $or: [{ isSystemAdministrator: true }, { isSystemAccount: true }] };
  await UserModel.updateMany(administrators, { $inc: { __v: 1 } }, { session, timestamps: false });

  await activeActorAccount(actor, session);
  const others = await UserModel.find(
    { ...administrators, _id: { $ne: targetId } },
    { employeeId: 1, isSystemAccount: 1, systemAccountDisabled: 1 },
  )
    .session(session)
    .lean();
  const employees = await EmployeeModel.find(
    { _id: { $in: others.flatMap((user) => (user.employeeId ? [user.employeeId] : [])) } },
    { employmentStatus: 1 },
  )
    .session(session)
    .lean();
  const statusById = new Map(employees.map((e) => [e._id.toHexString(), e]));
  const active = others.filter(
    (user) =>
      resolveAccountStatus(
        user,
        user.employeeId ? (statusById.get(user.employeeId.toHexString()) ?? null) : null,
      ) === 'active',
  );
  if (active.length === 0) throw new ActionError(LAST_ADMINISTRATOR);
}
