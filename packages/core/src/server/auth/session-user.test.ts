import { beforeAll, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { SESSION_MAX_AGE_HOURS } from '../../account';
import { businessToday, startOfBusinessDate } from '../../dates';
import { EmployeeModel } from '../employees/model';
import { UserModel } from '../users/model';
import { changePassword } from './change-password';
import { hashPassword } from './password';
import { isSessionAfterReset, loadSessionUser } from './session-user';

// The session check on every request (SECURITY.md#account-status,
// SECURITY.md#sign-in-and-passwords, docs/TESTING.md#user-account-tests): a password reset ends
// every earlier session through `sessionsValidFrom`, a separation signs the user out on their next
// request, and changing one's own password keeps other sessions. Made-up data only.

const PASSWORD = 'made-up session password 1';
const NEW_PASSWORD = 'made-up session password 2';

let sequence = 0;

async function addUser({ withPassword = false } = {}) {
  sequence += 1;
  const employee = await EmployeeModel.create({
    employeeNumber: `2025-${String(sequence).padStart(2, '0')}`,
    firstName: 'Sample',
    lastName: `Session ${sequence}`,
    departmentId: new Types.ObjectId(),
    positionId: new Types.ObjectId(),
    employmentStatus: 'Regular',
    dateHired: new Date('2025-01-06T00:00:00+08:00'),
  });
  const user = await UserModel.create({
    email: `session.${sequence}@xtreme-works.com`,
    passwordHash: withPassword ? await hashPassword(PASSWORD) : 'made-up-not-a-hash',
    mustChangePassword: false,
    employeeId: employee._id,
  });
  return { userId: user._id, employeeId: employee._id };
}

/** `signedInAt` (whole seconds since the epoch) for a sign-in `secondsAgo` before now. */
function signedInAgo(secondsAgo: number): number {
  return Math.floor(Date.now() / 1000) - secondsAgo;
}

beforeAll(async () => {
  await connectDb();
});

describe('isSessionAfterReset', () => {
  const resetAt = new Date('2026-10-05T02:00:00.000Z');
  const resetSecond = resetAt.getTime() / 1000;

  it('accepts every session while there has been no reset', () => {
    expect(isSessionAfterReset(0, null)).toBe(true);
    expect(isSessionAfterReset(resetSecond, null)).toBe(true);
  });

  it('refuses a session that signed in before the reset, and accepts one from it onwards', () => {
    expect(isSessionAfterReset(resetSecond - 1, resetAt)).toBe(false);
    expect(isSessionAfterReset(resetSecond, resetAt)).toBe(true);
    expect(isSessionAfterReset(resetSecond + 60, resetAt)).toBe(true);
  });

  it('fails closed within the reset’s second, and on values that aren’t numbers or dates', () => {
    const midSecond = new Date(resetAt.getTime() + 500);
    expect(isSessionAfterReset(resetSecond, midSecond)).toBe(false);
    expect(isSessionAfterReset(Number.NaN, resetAt)).toBe(false);
    expect(isSessionAfterReset(resetSecond, new Date(Number.NaN))).toBe(false);
  });
});

describe('loadSessionUser', () => {
  it('loads an active user whose session has no reset after it', async () => {
    const { userId, employeeId } = await addUser();
    const user = await loadSessionUser(userId.toHexString(), signedInAgo(60));
    expect(user).toMatchObject({
      id: userId.toHexString(),
      employee: { id: employeeId.toHexString() },
    });
  });

  it('accepts an account stored before the field existed (no sessionsValidFrom at all)', async () => {
    const { userId } = await addUser();
    await UserModel.collection.updateOne({ _id: userId }, { $unset: { sessionsValidFrom: '' } });
    expect(await loadSessionUser(userId.toHexString(), signedInAgo(60))).not.toBeNull();
  });

  it('refuses a session that signed in before sessionsValidFrom, and accepts a later one', async () => {
    const { userId } = await addUser();
    const id = userId.toHexString();
    // One reference second, so the clock ticking during the test can't move the boundary.
    const resetSecond = signedInAgo(60);
    const before = resetSecond - 60;
    expect(await loadSessionUser(id, before)).not.toBeNull();

    // What a reset writes: only sessions that sign in from then on count.
    await UserModel.updateOne(
      { _id: userId },
      { $set: { sessionsValidFrom: new Date(resetSecond * 1000) } },
    );

    expect(await loadSessionUser(id, before)).toBeNull();
    expect(await loadSessionUser(id, resetSecond - 1)).toBeNull();
    expect(await loadSessionUser(id, resetSecond)).not.toBeNull();
    expect(await loadSessionUser(id, resetSecond + 30)).not.toBeNull();
  });

  it('signs out a user set to Resigned as of today on their next request', async () => {
    const { userId, employeeId } = await addUser();
    const id = userId.toHexString();
    const signedInAt = signedInAgo(60);
    expect(await loadSessionUser(id, signedInAt)).not.toBeNull();

    const employee = await EmployeeModel.findById(employeeId).orFail();
    employee.set({
      employmentStatus: 'Resigned',
      separationDate: startOfBusinessDate(businessToday()),
    });
    await employee.save();

    expect(await loadSessionUser(id, signedInAt)).toBeNull();
  });

  it('keeps other sessions when users change their own password', async () => {
    const { userId } = await addUser({ withPassword: true });
    const id = userId.toHexString();
    const otherSession = signedInAgo(600);

    await changePassword(id, {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
      confirm: NEW_PASSWORD,
    });

    const stored = await UserModel.findById(userId).lean().orFail();
    expect(stored.sessionsValidFrom).toBeNull();
    expect(await loadSessionUser(id, otherSession)).not.toBeNull();
  });

  it('still refuses a session past its limit, or one that starts too far in the future', async () => {
    const { userId } = await addUser();
    const id = userId.toHexString();
    expect(await loadSessionUser(id, signedInAgo(SESSION_MAX_AGE_HOURS * 3600 + 1))).toBeNull();
    expect(await loadSessionUser(id, signedInAgo(-10 * 60))).toBeNull();
  });

  it('refuses an unknown or malformed user id', async () => {
    expect(await loadSessionUser(new Types.ObjectId().toHexString(), signedInAgo(60))).toBeNull();
    expect(await loadSessionUser('not-an-id', signedInAgo(60))).toBeNull();
  });
});
