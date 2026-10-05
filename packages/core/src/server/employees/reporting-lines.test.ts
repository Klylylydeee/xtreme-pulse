import { beforeAll, describe, expect, it } from 'vitest';
import mongoose, { type ClientSession, Types } from 'mongoose';
import { connectDb, withTransaction } from '@pulse/db';
import { EMPLOYMENT_STATUS, type EmploymentStatus } from '../../account';
import { AuditLogModel } from '../audit/model';
import { UserModel } from '../users/model';
import { EmployeeModel } from './model';
import { MAX_SUPERVISORS, validateAndClaimReportingTo } from './reporting-lines';

// Reporting lines (docs/modules/core.md#reporting-lines, docs/TESTING.md#user-account-tests).
// Made-up data only.

let counter = 0;

/** An employee with a user account, the way step 1.5 creates them. */
async function addEmployee(
  firstName: string,
  {
    status = 'Regular',
    reportingTo = [],
  }: { status?: EmploymentStatus; reportingTo?: Types.ObjectId[] } = {},
): Promise<Types.ObjectId> {
  counter += 1;
  const employee = await EmployeeModel.create({
    employeeNumber: `2024-${String(counter).padStart(2, '0')}`,
    firstName,
    lastName: 'Test',
    departmentId: new Types.ObjectId(),
    positionId: new Types.ObjectId(),
    reportingTo,
    employmentStatus: status,
    dateHired: new Date('2024-01-01T00:00:00+08:00'),
    separationDate:
      EMPLOYMENT_STATUS[status] === 'active' ? null : new Date('2024-06-01T00:00:00+08:00'),
  });
  await UserModel.create({
    email: `person${counter}@xtreme-works.com`,
    passwordHash: 'not-a-real-hash',
    employeeId: employee._id,
  });
  return employee._id;
}

/** Checks and saves the line in `session`, the way the user service will. */
async function saveLines(
  employeeId: Types.ObjectId,
  supervisorIds: readonly (Types.ObjectId | string)[],
  session: ClientSession,
): Promise<Types.ObjectId[]> {
  const ids = await validateAndClaimReportingTo(employeeId, supervisorIds, session);
  await EmployeeModel.updateOne({ _id: employeeId }, { $set: { reportingTo: ids } }, { session });
  return ids;
}

function setLines(employeeId: Types.ObjectId, supervisorIds: readonly (Types.ObjectId | string)[]) {
  return withTransaction((session) => saveLines(employeeId, supervisorIds, session));
}

/** Checks a new hire's line (no employee record yet). */
function checkNewHire(supervisorIds: readonly (Types.ObjectId | string)[]) {
  return withTransaction((session) => validateAndClaimReportingTo(null, supervisorIds, session));
}

async function linesOf(id: Types.ObjectId): Promise<string[]> {
  const employee = await EmployeeModel.findById(id).lean().orFail();
  return employee.reportingTo.map((s) => s.toHexString());
}

function refusal(message: string | RegExp) {
  return { name: 'ActionError', field: 'reportingTo', message: expect.stringMatching(message) };
}

/**
 * Runs `work` in a transaction that stays open until `commit` is called, standing in for a
 * concurrent request that has passed its checks but not committed yet.
 */
async function openTransaction(work: (session: ClientSession) => Promise<unknown>) {
  const session = await mongoose.startSession();
  session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
  await work(session);
  return {
    async commit() {
      await session.commitTransaction();
      await session.endSession();
    },
  };
}

// Long enough for the call under test to read its snapshot and hit the open transaction's write.
const OVERLAP_MS = 500;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  await connectDb();
  // Collections must exist before a transaction writes to them.
  await Promise.all([EmployeeModel.init(), UserModel.init(), AuditLogModel.init()]);
});

describe('the supervisor list', () => {
  it('may be empty, for anyone', async () => {
    const ana = await addEmployee('Ana');
    expect(await setLines(ana, [])).toEqual([]);
    expect(await checkNewHire([])).toEqual([]);
  });

  it('is returned as ObjectIds in the order given', async () => {
    const ana = await addEmployee('Ana');
    const ben = await addEmployee('Ben');
    const cara = await addEmployee('Cara');
    const ids = await setLines(ana, [cara.toHexString(), ben]);
    expect(ids.every((id) => id instanceof Types.ObjectId)).toBe(true);
    expect(ids.map((id) => id.toHexString())).toEqual([cara.toHexString(), ben.toHexString()]);
    expect(await linesOf(ana)).toEqual([cara.toHexString(), ben.toHexString()]);
  });

  it('accepts a new hire’s supervisors', async () => {
    const ben = await addEmployee('Ben');
    expect((await checkNewHire([ben])).map(String)).toEqual([ben.toHexString()]);
  });

  it('can’t include the employee themselves', async () => {
    const ana = await addEmployee('Ana');
    await expect(setLines(ana, [ana])).rejects.toMatchObject(
      refusal('Someone can’t report to themselves.'),
    );
  });

  it(`holds at most ${MAX_SUPERVISORS} supervisors`, async () => {
    const ana = await addEmployee('Ana');
    const supervisors: Types.ObjectId[] = [];
    for (let i = 0; i <= MAX_SUPERVISORS; i += 1) supervisors.push(await addEmployee(`Boss${i}`));
    await expect(setLines(ana, supervisors)).rejects.toMatchObject(
      refusal(`Choose at most ${MAX_SUPERVISORS} supervisors.`),
    );
    expect(await setLines(ana, supervisors.slice(0, MAX_SUPERVISORS))).toHaveLength(
      MAX_SUPERVISORS,
    );
  });

  it('lists no one twice', async () => {
    const ana = await addEmployee('Ana');
    const ben = await addEmployee('Ben');
    await expect(setLines(ana, [ben, ben.toHexString()])).rejects.toMatchObject(
      refusal('Each supervisor can be chosen only once.'),
    );
    expect(await linesOf(ana)).toEqual([]);
  });

  it('refuses a supervisor who doesn’t exist', async () => {
    const ana = await addEmployee('Ana');
    for (const unknown of [new Types.ObjectId(), 'not-an-id']) {
      await expect(setLines(ana, [unknown])).rejects.toMatchObject(refusal('doesn’t exist'));
    }
  });

  it('refuses the system account', async () => {
    const ana = await addEmployee('Ana');
    const system = await UserModel.create({
      email: 'system@xtreme-works.com',
      passwordHash: 'not-a-real-hash',
      isSystemAccount: true,
      isSystemAdministrator: true,
    });
    await expect(setLines(ana, [system._id])).rejects.toMatchObject(
      refusal('The system account can’t be a supervisor.'),
    );
    await expect(checkNewHire([system._id])).rejects.toMatchObject(
      refusal('The system account can’t be a supervisor.'),
    );
  });

  it.each<EmploymentStatus>(['Resigned', 'Terminated', 'Retired'])(
    'refuses a %s supervisor, also for a new hire',
    async (status) => {
      const ana = await addEmployee('Ana');
      const gone = await addEmployee('Gina', { status });
      await expect(setLines(ana, [gone])).rejects.toMatchObject(
        refusal('Gina Test isn’t an active employee.'),
      );
      await expect(checkNewHire([gone])).rejects.toMatchObject(
        refusal('Gina Test isn’t an active employee.'),
      );
    },
  );

  it('keeps lines to someone who separates later', async () => {
    const ana = await addEmployee('Ana');
    const ben = await addEmployee('Ben');
    await setLines(ana, [ben]);
    await EmployeeModel.updateOne({ _id: ben }, { $set: { employmentStatus: 'Resigned' } });
    expect(await linesOf(ana)).toEqual([ben.toHexString()]);
  });
});

describe('loops', () => {
  it('are refused when two people would report to each other', async () => {
    const ana = await addEmployee('Ana');
    const ben = await addEmployee('Ben', { reportingTo: [ana] });
    await expect(setLines(ana, [ben])).rejects.toMatchObject(
      refusal('This would create a loop: Ben Test already reports to Ana Test.'),
    );
    expect(await linesOf(ana)).toEqual([]);
  });

  it('are refused through a longer chain, naming it', async () => {
    // Ana ← Ben ← Cara ← Dan: Ana choosing Dan would close the loop.
    const ana = await addEmployee('Ana');
    const ben = await addEmployee('Ben', { reportingTo: [ana] });
    const cara = await addEmployee('Cara', { reportingTo: [ben] });
    const dan = await addEmployee('Dan', { reportingTo: [cara] });
    await expect(setLines(ana, [dan])).rejects.toMatchObject(
      refusal(
        'This would create a loop: Dan Test already reports to Ana Test through Cara Test and Ben Test.',
      ),
    );
  });

  it('are found through any of several supervisors', async () => {
    const ana = await addEmployee('Ana');
    const ben = await addEmployee('Ben');
    const cara = await addEmployee('Cara', { reportingTo: [ben, ana] });
    const dan = await addEmployee('Dan', { reportingTo: [ben, cara] });
    await expect(setLines(ana, [ben, dan])).rejects.toMatchObject(
      refusal('This would create a loop: Dan Test already reports to Ana Test through Cara Test.'),
    );
  });

  it('aren’t confused with shared supervisors (a diamond is fine)', async () => {
    const top = await addEmployee('Top');
    const left = await addEmployee('Left', { reportingTo: [top] });
    const right = await addEmployee('Right', { reportingTo: [top] });
    const ana = await addEmployee('Ana');
    expect(await setLines(ana, [left, right])).toHaveLength(2);
  });

  it('are still followed through someone who has separated', async () => {
    const ana = await addEmployee('Ana');
    const gone = await addEmployee('Gina', { status: 'Resigned', reportingTo: [ana] });
    const ben = await addEmployee('Ben', { reportingTo: [gone] });
    await expect(setLines(ana, [ben])).rejects.toMatchObject(
      refusal('Ben Test already reports to Ana Test through Gina Test.'),
    );
  });
});

describe('the claim writes', () => {
  it('bump the version of the employee and every record up the chain, and nothing else', async () => {
    const top = await addEmployee('Top');
    const mid = await addEmployee('Mid', { reportingTo: [top] });
    const ana = await addEmployee('Ana');
    const outsider = await addEmployee('Olga');
    const ids = [top, mid, ana, outsider];
    const before = await EmployeeModel.find({ _id: { $in: ids } }).lean();
    const auditCount = await AuditLogModel.countDocuments();

    await withTransaction((session) => validateAndClaimReportingTo(ana, [mid], session));

    const after = new Map(
      (await EmployeeModel.find({ _id: { $in: ids } }).lean()).map((e) => [e._id.toHexString(), e]),
    );
    for (const employee of before) {
      const now = after.get(employee._id.toHexString());
      const claimed = !employee._id.equals(outsider);
      expect(now?.__v).toBe(employee.__v + (claimed ? 1 : 0));
      expect(now?.updatedAt).toEqual(employee.updatedAt);
    }
    expect(await AuditLogModel.countDocuments()).toBe(auditCount);
  });

  it('refuse an employee who no longer exists', async () => {
    const ben = await addEmployee('Ben');
    await expect(
      withTransaction((session) =>
        validateAndClaimReportingTo(new Types.ObjectId(), [ben], session),
      ),
    ).rejects.toMatchObject({ name: 'ActionError', field: null });
  });
});

// Two edits that are each fine but together close a loop. Without the claim writes, each sees
// only its own line under snapshot isolation and both commit (write skew).
describe('two edits at the same time', () => {
  it('can’t together make two people report to each other', async () => {
    const ana = await addEmployee('Ana');
    const ben = await addEmployee('Ben');
    const benToAna = await openTransaction((session) => saveLines(ben, [ana], session));
    const anaToBen = setLines(ana, [ben]).catch((error: unknown) => error);
    await pause(OVERLAP_MS);
    await benToAna.commit();

    expect(await anaToBen).toMatchObject(
      refusal('This would create a loop: Ben Test already reports to Ana Test.'),
    );
    expect(await linesOf(ben)).toEqual([ana.toHexString()]);
    expect(await linesOf(ana)).toEqual([]);
  });

  it('can’t together close a longer loop', async () => {
    // Ben ← Cara exists. One edit adds Cara ← Ana, the other Ana ← Ben: Ana → Ben → Cara → Ana.
    const ana = await addEmployee('Ana');
    const cara = await addEmployee('Cara');
    const ben = await addEmployee('Ben', { reportingTo: [cara] });
    const caraToAna = await openTransaction((session) => saveLines(cara, [ana], session));
    const anaToBen = setLines(ana, [ben]).catch((error: unknown) => error);
    await pause(OVERLAP_MS);
    await caraToAna.commit();

    expect(await anaToBen).toMatchObject(
      refusal('This would create a loop: Ben Test already reports to Ana Test through Cara Test.'),
    );
    expect(await linesOf(cara)).toEqual([ana.toHexString()]);
    expect(await linesOf(ana)).toEqual([]);
  });

  it('let exactly one through when both run at once', async () => {
    for (let round = 0; round < 5; round += 1) {
      const ana = await addEmployee(`Ana${round}`);
      const ben = await addEmployee(`Ben${round}`);
      const results = await Promise.allSettled([setLines(ana, [ben]), setLines(ben, [ana])]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const lines = [...(await linesOf(ana)), ...(await linesOf(ben))];
      expect(lines).toHaveLength(1);
    }
  });
});
