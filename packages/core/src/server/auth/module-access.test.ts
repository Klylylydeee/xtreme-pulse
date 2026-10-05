import { beforeAll, describe, expect, it } from 'vitest';
import mongoose, { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { AccessDeniedError } from '../../actions';
import {
  ACCESS_LEVELS,
  type AccessLevel,
  atLeast,
  emptyModuleAccess,
  fullModuleAccess,
  type ModuleAccess,
} from '../../module-access';
import { MODULES } from '../../modules';
import { DepartmentModel } from '../departments/model';
import { EmployeeModel } from '../employees/model';
import { UserModel } from '../users/model';
import {
  assertModuleAccess,
  canOpenAdminArea,
  hasModuleAccess,
  resolveModuleAccess,
} from './module-access';
import { type CurrentUser, loadSessionUser } from './session-user';

// Effective module access (SECURITY.md#resolving-and-enforcing-build-step-16,
// docs/TESTING.md#module-access-tests): the stored map through the session load, a missing field
// as None, the System Administrator as Owner (Read on Insight) whatever is stored, the schema's
// limits, the full module × level matrix and the admin area kinds. Made-up data only.

let sequence = 0;
const departments = new Map<string, Types.ObjectId>();

async function departmentId(code: string): Promise<Types.ObjectId> {
  let id = departments.get(code);
  if (!id) {
    id = (await DepartmentModel.create({ name: `Department ${code}`, code }))._id;
    departments.set(code, id);
  }
  return id;
}

interface AddUserOptions {
  departmentCode?: string;
  isSystemAdministrator?: boolean;
  moduleAccess?: Record<string, string>;
}

async function addUser({
  departmentCode = 'ENG',
  isSystemAdministrator = false,
  moduleAccess,
}: AddUserOptions = {}): Promise<Types.ObjectId> {
  sequence += 1;
  const employee = await EmployeeModel.create({
    employeeNumber: `2025-${String(sequence).padStart(2, '0')}`,
    firstName: 'Sample',
    lastName: `Access ${sequence}`,
    departmentId: await departmentId(departmentCode),
    positionId: new Types.ObjectId(),
    employmentStatus: 'Regular',
    dateHired: new Date('2025-01-06T00:00:00+08:00'),
  });
  const user = await UserModel.create({
    email: `access.${sequence}@xtreme-works.com`,
    passwordHash: 'made-up-not-a-hash',
    mustChangePassword: false,
    isSystemAdministrator,
    employeeId: employee._id,
    ...(moduleAccess ? { moduleAccess } : {}),
  });
  return user._id;
}

/** Writes the stored map straight to the collection, past the schema, as old or bad data. */
async function storeRaw(userId: Types.ObjectId, moduleAccess: Record<string, string> | null) {
  await UserModel.collection.updateOne(
    { _id: userId },
    moduleAccess === null ? { $unset: { moduleAccess: '' } } : { $set: { moduleAccess } },
  );
}

async function load(userId: Types.ObjectId): Promise<CurrentUser> {
  const user = await loadSessionUser(userId.toHexString(), Math.floor(Date.now() / 1000) - 60);
  if (!user) throw new Error('The test user didn’t load.');
  return user;
}

function everyModule(level: AccessLevel): Record<string, string> {
  return Object.fromEntries(MODULES.map((module) => [module, level]));
}

beforeAll(async () => {
  await connectDb();
});

describe('the stored map', () => {
  it('stores None on every module for a new account', async () => {
    const userId = await addUser();
    const stored = await UserModel.collection.findOne({ _id: userId });
    expect(stored?.moduleAccess).toEqual(emptyModuleAccess());
    expect((await load(userId)).moduleAccess).toEqual(emptyModuleAccess());
  });

  it('comes through loadSessionUser as stored', async () => {
    const stored = {
      ...emptyModuleAccess(),
      engage: 'owner',
      fiscal: 'write',
      talent: 'read',
      insight: 'read',
    } as const;
    const userId = await addUser({ moduleAccess: stored });
    expect((await load(userId)).moduleAccess).toEqual(stored);
  });

  it('resolves an account stored before the field existed to None everywhere', async () => {
    const userId = await addUser({ moduleAccess: everyModule('read') });
    await storeRaw(userId, null);
    expect((await UserModel.collection.findOne({ _id: userId }))?.moduleAccess).toBeUndefined();
    expect((await load(userId)).moduleAccess).toEqual(emptyModuleAccess());
  });

  it('reads a missing key and an invalid stored level as None', async () => {
    const userId = await addUser();
    await storeRaw(userId, { talent: 'write', insight: 'owner', fiscal: 'admin' });
    expect((await load(userId)).moduleAccess).toEqual({ ...emptyModuleAccess(), talent: 'write' });
  });

  it('refuses Owner or Write on Insight and an unknown level', async () => {
    const before = await UserModel.countDocuments();
    const refused: Record<string, string>[] = [
      { insight: 'owner' },
      { insight: 'write' },
      { talent: 'admin' },
    ];
    for (const moduleAccess of refused) {
      await expect(
        UserModel.create({
          email: `refused.${(sequence += 1)}@xtreme-works.com`,
          passwordHash: 'made-up-not-a-hash',
          employeeId: new Types.ObjectId(),
          // Values the type refuses too: the schema must refuse them at run time.
          moduleAccess: moduleAccess as Partial<ModuleAccess>,
        }),
      ).rejects.toBeInstanceOf(mongoose.Error.ValidationError);
    }
    expect(await UserModel.countDocuments()).toBe(before);

    const userId = await addUser();
    const user = await UserModel.findById(userId).orFail();
    user.set('moduleAccess.insight', 'owner');
    await expect(user.save()).rejects.toBeInstanceOf(mongoose.Error.ValidationError);
    expect((await load(userId)).moduleAccess.insight).toBe('none');
  });
});

describe('the System Administrator', () => {
  it('resolves to Owner everywhere and Read on Insight, whatever is stored', async () => {
    const stored = [everyModule('none'), { ...everyModule('read'), insight: 'none' }, null];
    for (const moduleAccess of stored) {
      const userId = await addUser({ isSystemAdministrator: true, departmentCode: 'IT' });
      await storeRaw(userId, moduleAccess);
      expect((await load(userId)).moduleAccess).toEqual(fullModuleAccess());
    }
  });

  it('includes the bootstrap system account', async () => {
    const system = await UserModel.create({
      email: 'system.access@xtreme-works.com',
      passwordHash: 'made-up-not-a-hash',
      mustChangePassword: false,
      isSystemAdministrator: true,
      isSystemAccount: true,
      employeeId: null,
      moduleAccess: everyModule('none'),
    });
    const user = await load(system._id);
    expect(user.isSystemAccount).toBe(true);
    expect(user.moduleAccess).toEqual(fullModuleAccess());
  });

  it('is decided by the flag alone in resolveModuleAccess', () => {
    expect(resolveModuleAccess({ isSystemAdministrator: true })).toEqual(fullModuleAccess());
    expect(resolveModuleAccess({ isSystemAdministrator: false })).toEqual(emptyModuleAccess());
    expect(
      resolveModuleAccess({ isSystemAdministrator: false, moduleAccess: everyModule('owner') }),
    ).toEqual({ ...everyModule('owner'), insight: 'none' });
  });
});

describe('roles', () => {
  it('gives HR and Board members with nothing stored no module access', async () => {
    for (const departmentCode of ['HR', 'BOD']) {
      const userId = await addUser({ departmentCode });
      await storeRaw(userId, null);
      const user = await load(userId);
      expect(user.roles).toEqual([departmentCode === 'HR' ? 'hr' : 'board']);
      expect(user.moduleAccess).toEqual(emptyModuleAccess());
      for (const module of MODULES) expect(hasModuleAccess(user, module, 'read')).toBe(false);
    }
  });
});

describe('hasModuleAccess and assertModuleAccess', () => {
  it('follows the full matrix of 7 modules × 4 stored levels × required levels', async () => {
    let checks = 0;
    for (const stored of ACCESS_LEVELS) {
      const userId = await addUser();
      // Write and Owner on Insight can't be saved through the model: store them as bad data.
      await storeRaw(userId, everyModule(stored));
      const user = await load(userId);
      for (const module of MODULES) {
        // Write or Owner stored on Insight is invalid, so it reads as None.
        const effective = module === 'insight' && atLeast(stored, 'write') ? 'none' : stored;
        expect(user.moduleAccess[module]).toBe(effective);
        for (const required of ['read', 'write', 'owner'] as const) {
          // Insight's type allows only Read; the cast checks the runtime still refuses the rest.
          const allowed = hasModuleAccess(user, module, required as 'read');
          expect(allowed, `${stored} on ${module}, ${required} required`).toBe(
            atLeast(effective, required) && (module !== 'insight' || required === 'read'),
          );
          if (allowed) {
            expect(() => assertModuleAccess(user, module, required as 'read')).not.toThrow();
          } else {
            expect(() => assertModuleAccess(user, module, required as 'read')).toThrow(
              AccessDeniedError,
            );
          }
          checks += 1;
        }
      }
    }
    expect(checks).toBe(MODULES.length * ACCESS_LEVELS.length * 3);
  });

  it('refuses no user, and takes a message', () => {
    expect(hasModuleAccess(null, 'talent', 'read')).toBe(false);
    expect(hasModuleAccess(undefined, 'talent', 'read')).toBe(false);
    expect(() => assertModuleAccess(null, 'talent', 'read')).toThrow(AccessDeniedError);
    expect(() =>
      assertModuleAccess({ moduleAccess: emptyModuleAccess() }, 'fiscal', 'write', 'Made up.'),
    ).toThrow('Made up.');
    expect(() =>
      assertModuleAccess({ moduleAccess: emptyModuleAccess() }, 'fiscal', 'write'),
    ).toThrow('You don’t have access to do this. Ask HR or the System Administrator.');
  });

  it('types the required level per module', () => {
    const user = { moduleAccess: fullModuleAccess() };
    // @ts-expect-error Insight is read-only: Write doesn't compile.
    expect(hasModuleAccess(user, 'insight', 'write')).toBe(false);
    // @ts-expect-error None is never a required level.
    expect(hasModuleAccess(user, 'talent', 'none')).toBe(true);
    expect(hasModuleAccess(user, 'insight', 'read')).toBe(true);
  });
});

describe('canOpenAdminArea', () => {
  it('opens each admin area kind to the right roles', async () => {
    const admin = await load(await addUser({ isSystemAdministrator: true, departmentCode: 'IT' }));
    const hr = await load(await addUser({ departmentCode: 'HR' }));
    const board = await load(await addUser({ departmentCode: 'BOD' }));
    const plain = await load(
      await addUser({ departmentCode: 'ENG', moduleAccess: fullModuleAccess() }),
    );

    expect(canOpenAdminArea(admin, 'hrOrSystemAdministrator')).toBe(true);
    expect(canOpenAdminArea(admin, 'systemAdministrator')).toBe(true);
    expect(canOpenAdminArea(hr, 'hrOrSystemAdministrator')).toBe(true);
    expect(canOpenAdminArea(hr, 'systemAdministrator')).toBe(false);
    for (const user of [board, plain, null]) {
      expect(canOpenAdminArea(user, 'hrOrSystemAdministrator')).toBe(false);
      expect(canOpenAdminArea(user, 'systemAdministrator')).toBe(false);
    }
  });
});
