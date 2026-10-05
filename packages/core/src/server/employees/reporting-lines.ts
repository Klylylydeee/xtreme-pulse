import type { ClientSession, Types } from 'mongoose';
import { ActionError } from '../../actions';
import { MAX_SUPERVISORS } from '../../user-accounts';
import { resolveAccountStatus } from '../auth/account-status';
import { toObjectId } from '../paging';
import { UserModel } from '../users/model';
import { type EmployeeRecord, EmployeeModel } from './model';

// Spec: docs/modules/core.md#reporting-lines (decision 44 in docs/BUILD_PLAN.md) — the checks on
// an employee's `reportingTo`, run by the user service inside its own transaction before it saves:
//
// - Anyone may have no supervisor.
// - At most 10 supervisors, no one listed twice, and not the employee themselves.
// - Each supervisor exists, is an employee (not the bootstrap system account) and is active when
//   saved. Lines to someone who later separates stay as they are (steps 1.9 and 1.11).
// - No cycles: the walk follows the upward chain inside the transaction and refuses when it comes
//   back to the employee.
//
// Two edits that are each fine but together form a loop (A → B in one, B → A in the other) would
// both pass under snapshot isolation, because neither sees the other's line. So the walk writes
// every record it reads, plus the employee's own: the edits then share a written record, one
// fails with a write conflict, and `withTransaction` retries it against the other's result. The
// write only bumps the version key with timestamps off, like `claimLiveDepartment`, so
// `updatedAt` and `updatedBy` keep saying who last edited the record and no audit entry is due.

// The limit is shared with the user sheet (browser-safe), and re-exported here for the server.
export { MAX_SUPERVISORS };

/**
 * How many levels up the walk goes. Stored lines never form a loop, so a chain is never longer
 * than the number of employees; this only stops a corrupt chain from running forever.
 */
const MAX_CHAIN_DEPTH = 100;

const FIELD = 'reportingTo';

type ChainNode = Pick<EmployeeRecord, '_id' | 'firstName' | 'lastName' | 'reportingTo'>;

const CHAIN_FIELDS = { firstName: 1, lastName: 1, reportingTo: 1 } as const;

function refuse(message: string): never {
  throw new ActionError(message, { field: FIELD });
}

function nameOf(employee: Pick<EmployeeRecord, 'firstName' | 'lastName'>): string {
  return `${employee.firstName} ${employee.lastName}`;
}

/** `A`, `A and B`, `A, B and C`. */
function listOf(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** Bumps the version key of each record, with timestamps off; returns how many matched. */
async function claim(ids: Types.ObjectId[], session: ClientSession): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await EmployeeModel.updateMany(
    { _id: { $in: ids } },
    { $inc: { __v: 1 } },
    { session, timestamps: false },
  );
  return result.matchedCount;
}

/** Parses the list and applies the checks that need no database: the count, repeats and self. */
function normalize(
  employeeId: Types.ObjectId | null,
  supervisorIds: readonly (Types.ObjectId | string)[],
): Types.ObjectId[] {
  if (supervisorIds.length > MAX_SUPERVISORS) {
    refuse(`Choose at most ${MAX_SUPERVISORS} supervisors.`);
  }
  const ids: Types.ObjectId[] = [];
  const seen = new Set<string>();
  for (const value of supervisorIds) {
    const id = toObjectId(value);
    if (!id)
      refuse('One of the chosen supervisors doesn’t exist. Reload the page and choose again.');
    const hex = id.toHexString();
    if (seen.has(hex)) refuse('Each supervisor can be chosen only once. Remove the repeat.');
    seen.add(hex);
    ids.push(id);
  }
  if (employeeId && seen.has(employeeId.toHexString())) {
    refuse('Someone can’t report to themselves. Remove them from their supervisors.');
  }
  return ids;
}

/** Refuses a supervisor who isn't an existing, active employee. Claims them in the transaction. */
async function loadSupervisors(
  ids: Types.ObjectId[],
  session: ClientSession,
): Promise<Map<string, ChainNode>> {
  await claim(ids, session);
  // One after the other: a session runs one operation at a time.
  const employees = await EmployeeModel.find(
    { _id: { $in: ids } },
    { ...CHAIN_FIELDS, employmentStatus: 1 },
  )
    .session(session)
    .lean();
  const users = await UserModel.find(
    { $or: [{ employeeId: { $in: ids } }, { _id: { $in: ids } }] },
    { employeeId: 1, isSystemAccount: 1, systemAccountDisabled: 1 },
  )
    .session(session)
    .lean();
  const employeeById = new Map(employees.map((e) => [e._id.toHexString(), e]));
  const userByEmployee = new Map(
    users.flatMap((u) => (u.employeeId ? [[u.employeeId.toHexString(), u] as const] : [])),
  );
  const systemAccountIds = new Set(
    users.filter((u) => u.isSystemAccount).map((u) => u._id.toHexString()),
  );

  for (const id of ids) {
    const hex = id.toHexString();
    const employee = employeeById.get(hex);
    const user = userByEmployee.get(hex);
    // The system account has no employee record; the check covers its user ID being sent, and a
    // linked one should the model's own rule ever be bypassed.
    if (systemAccountIds.has(hex) || user?.isSystemAccount) {
      refuse('The system account can’t be a supervisor. Choose an employee.');
    }
    if (!employee) {
      refuse('One of the chosen supervisors doesn’t exist. Reload the page and choose again.');
    }
    // An employee with no account yet is judged by their employment status alone.
    const account = user ?? { isSystemAccount: false, systemAccountDisabled: false };
    if (resolveAccountStatus(account, employee) !== 'active') {
      refuse(`${nameOf(employee)} isn’t an active employee. Choose someone who is.`);
    }
  }
  return employeeById;
}

/**
 * Walks up from the supervisors and refuses when the chain comes back to `subject`. Every record
 * read is claimed first. `via` remembers, for each record reached, the one below it in the walk,
 * so the message can name the chain.
 */
async function assertNoCycle(
  subject: Pick<EmployeeRecord, '_id' | 'firstName' | 'lastName'>,
  supervisors: Map<string, ChainNode>,
  session: ClientSession,
): Promise<void> {
  const subjectHex = subject._id.toHexString();
  const nodes = new Map(supervisors);
  const via = new Map<string, string>([...supervisors.keys()].map((hex) => [hex, subjectHex]));
  const visited = new Set([subjectHex, ...supervisors.keys()]);
  let level = [...supervisors.values()];

  for (let depth = 0; level.length > 0; depth += 1) {
    if (depth >= MAX_CHAIN_DEPTH) {
      refuse(
        `This reporting chain is more than ${MAX_CHAIN_DEPTH} levels deep, so it can’t be checked. Ask the System Administrator.`,
      );
    }
    const next: Types.ObjectId[] = [];
    for (const node of level) {
      const nodeHex = node._id.toHexString();
      for (const up of node.reportingTo) {
        const upHex = up.toHexString();
        if (upHex === subjectHex) refuseCycle(subject, nodeHex, { nodes, via });
        if (visited.has(upHex)) continue;
        visited.add(upHex);
        via.set(upHex, nodeHex);
        next.push(up);
      }
    }
    if (next.length === 0) return;
    await claim(next, session);
    // A line to a record that's gone is skipped: it leads nowhere.
    level = await EmployeeModel.find({ _id: { $in: next } }, CHAIN_FIELDS)
      .session(session)
      .lean();
    for (const node of level) nodes.set(node._id.toHexString(), node);
  }
}

/**
 * "This would create a loop: B already reports to A[ through C and D]." `topHex` is the record
 * found reporting to the subject; following `via` down from it reaches a chosen supervisor.
 */
function refuseCycle(
  subject: Pick<EmployeeRecord, '_id' | 'firstName' | 'lastName'>,
  topHex: string,
  { nodes, via }: { nodes: Map<string, ChainNode>; via: Map<string, string> },
): never {
  // From the record just above the subject down to the chosen supervisor, whose `via` is the
  // subject itself.
  const names: string[] = [];
  const subjectHex = subject._id.toHexString();
  for (let hex = topHex; hex !== subjectHex; hex = via.get(hex) ?? subjectHex) {
    const node = nodes.get(hex);
    if (node) names.push(nameOf(node));
  }
  const [chosen, ...between] = names.reverse();
  const through = between.length > 0 ? ` through ${listOf(between)}` : '';
  refuse(`This would create a loop: ${chosen} already reports to ${nameOf(subject)}${through}.`);
}

/**
 * Checks `supervisorIds` as the `reportingTo` of `employeeId` (null for a new hire) and returns
 * them as ObjectIds, in the order given. Throws an {@link ActionError} on `reportingTo` when a
 * check fails. Run it inside the transaction that saves the line, with that transaction's session:
 * it writes the employee and every supervisor up the chain, so an overlapping edit that would
 * form a loop with this one conflicts and is retried.
 */
export async function validateAndClaimReportingTo(
  employeeId: Types.ObjectId | null,
  supervisorIds: readonly (Types.ObjectId | string)[],
  session: ClientSession,
): Promise<Types.ObjectId[]> {
  const ids = normalize(employeeId, supervisorIds);
  if (ids.length === 0) return [];

  let subject: Pick<EmployeeRecord, '_id' | 'firstName' | 'lastName'> | null = null;
  if (employeeId) {
    if ((await claim([employeeId], session)) !== 1) {
      throw new ActionError('This employee no longer exists. Reload the page.');
    }
    subject = await EmployeeModel.findById(employeeId, { firstName: 1, lastName: 1 })
      .session(session)
      .lean()
      .orFail();
  }

  const supervisors = await loadSupervisors(ids, session);
  // Nobody reports to a new hire yet, so their chain can't loop back to them.
  if (subject) await assertNoCycle(subject, supervisors, session);
  return ids;
}
