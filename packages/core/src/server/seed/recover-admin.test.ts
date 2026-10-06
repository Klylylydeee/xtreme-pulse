import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { AllowedEmailDomainModel } from '../allowed-email-domains/model';
import { AuditLogModel } from '../audit/model';
import { verifyPassword } from '../auth/password';
import { loadSessionUser } from '../auth/session-user';
import { DepartmentModel } from '../departments/model';
import type { OrgStructureActor } from '../departments/service';
import { EmployeeNumberCounterModel } from '../employee-number-counters/model';
import { EmployeeModel } from '../employees/model';
import { NotificationModel } from '../notifications/model';
import { PositionModel } from '../positions/model';
import { UserModel } from '../users/model';
import { createUser } from '../users/service';
import { SeedInputError } from './bootstrap-admin';
import { recoverSystemAdministrator } from './recover-admin';

// `pnpm recover:admin` (SECURITY.md#system-administrator,
// docs/RUNBOOK.md#the-only-system-administrator-is-disabled, decision 75). Made-up data only.

const PASSWORD = 'Made-up-Recovery-Password-7';
const OLD_HASH = 'made-up-not-a-hash';

let systemAccountId: string;
/** An ordinary user made a System Administrator, switched on and off per test. */
let otherAdminId: string;

async function systemAccount() {
  return UserModel.findById(systemAccountId).select('+passwordHash').lean().orFail();
}

async function entriesForSystemAccount() {
  return AuditLogModel.find({ 'record.id': new Types.ObjectId(systemAccountId) })
    .sort({ _id: 1 })
    .lean();
}

/** The state `pnpm recover:admin` is for: no System Administrator is active. */
async function lockedOut({ systemAccountIsAdministrator = true } = {}) {
  await UserModel.updateOne(
    { _id: systemAccountId },
    {
      $set: {
        systemAccountDisabled: true,
        isSystemAdministrator: systemAccountIsAdministrator,
        mustChangePassword: false,
        passwordHash: OLD_HASH,
        sessionsValidFrom: null,
      },
    },
  );
  await UserModel.updateOne({ _id: otherAdminId }, { $set: { isSystemAdministrator: false } });
}

const signedInAgo = (seconds: number) => Math.floor(Date.now() / 1000) - seconds;

beforeAll(async () => {
  await connectDb();
  // Collections must exist before a transaction writes to them.
  await Promise.all([
    DepartmentModel.init(),
    PositionModel.init(),
    EmployeeModel.init(),
    UserModel.init(),
    AuditLogModel.init(),
    NotificationModel.init(),
    EmployeeNumberCounterModel.init(),
    AllowedEmailDomainModel.init(),
  ]);
  await AllowedEmailDomainModel.create({ domain: 'xtreme-works.com' });
  const department = await DepartmentModel.create({ name: 'Department NET', code: 'NET' });
  const position = await PositionModel.create({
    name: 'Position NET',
    departmentId: department._id,
    timesheetType: 'standard',
  });
  const system = await UserModel.create({
    email: 'sysadmin@xtreme-works.com',
    passwordHash: OLD_HASH,
    mustChangePassword: false,
    isSystemAdministrator: true,
    isSystemAccount: true,
    employeeId: null,
  });
  systemAccountId = system._id.toHexString();
  const actor: OrgStructureActor = {
    id: systemAccountId,
    email: system.email,
    isSystemAdministrator: true,
    roles: [],
  };
  const other = await createUser(actor, {
    email: 'other.admin@xtreme-works.com',
    firstName: 'Ana',
    middleName: null,
    lastName: 'Reyes',
    employeeNumberMode: 'generate',
    employeeNumber: null,
    dateHired: '2020-03-01',
    departmentId: department._id.toHexString(),
    positionId: position._id.toHexString(),
    employmentStatus: 'Regular',
    reportingTo: [],
  });
  otherAdminId = other.id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('recoverSystemAdministrator', () => {
  it('refuses while any System Administrator is active, and changes nothing', async () => {
    // The system account itself is active.
    await lockedOut();
    await UserModel.updateOne({ _id: systemAccountId }, { $set: { systemAccountDisabled: false } });
    const entries = (await entriesForSystemAccount()).length;
    await expect(recoverSystemAdministrator({ password: PASSWORD })).rejects.toThrow(
      SeedInputError,
    );

    // Another, ordinary System Administrator is active.
    await lockedOut();
    await UserModel.updateOne({ _id: otherAdminId }, { $set: { isSystemAdministrator: true } });
    await expect(recoverSystemAdministrator({ password: PASSWORD })).rejects.toThrow(
      SeedInputError,
    );

    const account = await systemAccount();
    expect(account).toMatchObject({
      systemAccountDisabled: true,
      passwordHash: OLD_HASH,
      mustChangePassword: false,
      sessionsValidFrom: null,
    });
    expect(await entriesForSystemAccount()).toHaveLength(entries);
  });

  it('refuses an empty password', async () => {
    await lockedOut();
    await expect(recoverSystemAdministrator({ password: '' })).rejects.toThrow(SeedInputError);
    expect((await systemAccount()).systemAccountDisabled).toBe(true);
  });

  it.each([
    ['keeps', true],
    ['restores', false],
  ])(
    're-enables the system account with a new temporary password, and %s the role',
    async (_label, systemAccountIsAdministrator) => {
      await lockedOut({ systemAccountIsAdministrator });

      const result = await recoverSystemAdministrator({ password: PASSWORD });
      expect(result).toEqual({ status: 'recovered', email: 'sysadmin@xtreme-works.com' });

      const account = await systemAccount();
      expect(account).toMatchObject({
        systemAccountDisabled: false,
        isSystemAdministrator: true,
        mustChangePassword: true,
        updatedBy: null,
      });
      expect(account.passwordHash).not.toBe(OLD_HASH);
      expect(account.passwordHash).not.toContain(PASSWORD);
      expect(await verifyPassword(account.passwordHash, PASSWORD)).toBe(true);
    },
  );

  it('signs out the account’s old sessions', async () => {
    await lockedOut();
    const startedAt = Date.now();
    await recoverSystemAdministrator({ password: PASSWORD });

    const account = await systemAccount();
    expect(account.sessionsValidFrom?.getTime()).toBeGreaterThanOrEqual(startedAt - 1000);
    expect(await loadSessionUser(systemAccountId, signedInAgo(5))).toBeNull();
  });

  it('writes one update entry with no actor, and never the password or its hash', async () => {
    await lockedOut({ systemAccountIsAdministrator: false });
    const before = (await entriesForSystemAccount()).length;
    await recoverSystemAdministrator({ password: PASSWORD });

    const entries = (await entriesForSystemAccount()).slice(before);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actorId: null,
      actorEmail: null,
      module: 'core',
      action: 'update',
      record: { type: 'core.user', label: 'sysadmin@xtreme-works.com' },
      before: { systemAccountDisabled: true, isSystemAdministrator: false },
      after: {
        systemAccountDisabled: false,
        isSystemAdministrator: true,
        mustChangePassword: true,
      },
    });
    const hash = (await systemAccount()).passwordHash;
    const written = JSON.stringify(entries[0]);
    expect(written).not.toContain(PASSWORD);
    expect(written).not.toContain(hash);
    expect(written).not.toContain('passwordHash');
  });

  it('never returns or logs the password or its hash', async () => {
    await lockedOut();
    const logged: unknown[][] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
    }

    const result = await recoverSystemAdministrator({ password: PASSWORD });
    // And when it refuses, now that the account is active again.
    const refusal = await recoverSystemAdministrator({ password: PASSWORD }).catch(
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(SeedInputError);

    const hash = (await systemAccount()).passwordHash;
    for (const text of [
      JSON.stringify(result),
      JSON.stringify(logged),
      (refusal as Error).message,
    ]) {
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain(hash);
    }
  });
});
