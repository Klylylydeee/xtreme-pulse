import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { AccessDeniedError, ActionError } from '../../actions';
import { emptyModuleAccess } from '../../module-access';
import { AuditLogModel } from '../audit/model';
import type { DepartmentRole } from '../auth/roles';
import type { CurrentUser } from '../auth/session-user';
import { DepartmentModel } from '../departments/model';
import { authorizeFileAccess, findAccessibleFile } from '../files/access';
import { registerCoreFileAccess } from '../files/registrations';
import { storageRoot } from '../files/root';
import { findStoredFile, saveUpload } from '../files/stored-files';
import { coreSeedLoaders } from '../seed/loaders';
import { UserModel } from '../users/model';
import { EmployeeModel } from './model';
import {
  canChangeEmployeePhoto,
  EMPLOYEE_PHOTO_OWNER_TYPE,
  employeePhotoUrl,
  removeEmployeePhoto,
  setEmployeePhoto,
} from './photo';

// The profile photo (build step 2.2, decision 173 in docs/BUILD_PLAN.md,
// docs/modules/core.md#people-data-ownership, docs/TESTING.md#document-e-signature-and-certification-tests).
// Made-up people and images only.

let storageDir: string;
let counter = 0;

async function departmentId(code: string): Promise<Types.ObjectId> {
  const found = await DepartmentModel.findOne({ code }, { _id: 1 }).lean();
  if (found) return found._id;
  return (await DepartmentModel.create({ name: `Department ${code}`, code }))._id;
}

/** A real, active employee with an account, as the signed-in user. */
async function person(
  department: 'NET' | 'HR' | 'ACCT' = 'NET',
  { admin = false } = {},
): Promise<CurrentUser & { employee: NonNullable<CurrentUser['employee']> }> {
  counter += 1;
  const employee = await EmployeeModel.create({
    employeeNumber: `2026-${String(counter).padStart(2, '0')}`,
    firstName: 'Photo',
    lastName: `Person${counter}`,
    departmentId: await departmentId(department),
    positionId: new Types.ObjectId(),
    reportingTo: [],
    employmentStatus: 'Regular',
    dateHired: new Date('2024-01-01T00:00:00+08:00'),
    separationDate: null,
  });
  const email = `photo${counter}@xtreme-works.com`;
  const user = await UserModel.create({
    email,
    passwordHash: 'made-up-hash',
    employeeId: employee._id,
    isSystemAdministrator: admin,
  });
  const roles: DepartmentRole[] =
    department === 'HR' ? ['hr'] : department === 'ACCT' ? ['accounting'] : [];
  return {
    id: user._id.toHexString(),
    email,
    mustChangePassword: false,
    isSystemAdministrator: admin,
    isSystemAccount: false,
    employee: {
      id: employee._id.toHexString(),
      name: `Photo Person${counter}`,
      firstName: 'Photo',
      departmentCode: department,
    },
    roles,
    moduleAccess: emptyModuleAccess(),
  };
}

let systemAccount: CurrentUser;

/** A JPEG from a "camera", with EXIF and a GPS position. */
async function cameraPhoto(): Promise<File> {
  const bytes = await sharp({
    create: { width: 1600, height: 1200, channels: 3, background: { r: 10, g: 120, b: 200 } },
  })
    .withExif({
      IFD0: { Copyright: 'Made-up camera' },
      IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '14/1 35/1 0/1' },
    })
    .jpeg()
    .toBuffer();
  return new File([new Uint8Array(bytes)], 'me.jpg');
}

async function storedPhotoId(employeeId: string): Promise<string | null> {
  const employee = await EmployeeModel.findById(employeeId, { photoFileId: 1 }).lean().orFail();
  return employee.photoFileId?.toHexString() ?? null;
}

function photoEntries(employeeId: string) {
  return AuditLogModel.find({
    'record.type': 'core.employee',
    'record.id': new Types.ObjectId(employeeId),
  })
    .sort({ _id: 1 })
    .lean();
}

beforeAll(async () => {
  storageDir = await mkdtemp(path.join(tmpdir(), 'pulse-test-storage-'));
  process.env.FILE_STORAGE_DIR = storageDir;
  await connectDb();
  await Promise.all([EmployeeModel.init(), UserModel.init(), AuditLogModel.init()]);
  for (const loader of coreSeedLoaders) await loader.run();
  registerCoreFileAccess();
  const system = await UserModel.create({
    email: 'system.photo@xtreme-works.com',
    passwordHash: 'made-up-hash',
    employeeId: null,
    isSystemAdministrator: true,
    isSystemAccount: true,
  });
  systemAccount = {
    id: system._id.toHexString(),
    email: system.email,
    mustChangePassword: false,
    isSystemAdministrator: true,
    isSystemAccount: true,
    employee: null,
    roles: [],
    moduleAccess: emptyModuleAccess(),
  };
});

afterAll(async () => {
  await rm(storageDir, { recursive: true, force: true });
});

describe('who sets and removes the photo', () => {
  it('lets the employee, HR and the System Administrator set and remove it', async () => {
    const ana = await person();
    const hr = await person('HR');
    const admin = await person('NET', { admin: true });
    for (const actor of [ana, hr, admin]) {
      expect(canChangeEmployeePhoto(actor, ana.employee.id)).toBe(true);
      const { photoUrl } = await setEmployeePhoto(actor, ana.employee.id, await cameraPhoto());
      const id = await storedPhotoId(ana.employee.id);
      expect(photoUrl).toBe(`/files/${id}?inline=1`);
      expect(await removeEmployeePhoto(actor, ana.employee.id)).toEqual({ photoUrl: null });
      expect(await storedPhotoId(ana.employee.id)).toBeNull();
    }
  });

  it('refuses anyone else, and the system account, and stores nothing', async () => {
    const ana = await person();
    const colleague = await person();
    const accounting = await person('ACCT');
    for (const actor of [colleague, accounting, systemAccount]) {
      expect(canChangeEmployeePhoto(actor, ana.employee.id)).toBe(false);
      await expect(setEmployeePhoto(actor, ana.employee.id, await cameraPhoto())).rejects.toThrow(
        AccessDeniedError,
      );
      await expect(removeEmployeePhoto(actor, ana.employee.id)).rejects.toThrow(AccessDeniedError);
    }
    expect(await storedPhotoId(ana.employee.id)).toBeNull();
    expect(await photoEntries(ana.employee.id)).toHaveLength(0);
  });

  it('re-checks the actor in the transaction: an HR user moved out of HR is refused', async () => {
    const ana = await person();
    const hr = await person('HR');
    const user = await UserModel.findById(hr.id).lean().orFail();
    await EmployeeModel.updateOne(
      { _id: user.employeeId },
      { $set: { departmentId: await departmentId('NET') } },
    );
    await expect(setEmployeePhoto(hr, ana.employee.id, await cameraPhoto())).rejects.toThrow(
      AccessDeniedError,
    );
  });

  it('refuses a missing employee and a file that isn’t an image', async () => {
    const admin = await person('NET', { admin: true });
    await expect(
      setEmployeePhoto(admin, new Types.ObjectId().toHexString(), await cameraPhoto()),
    ).rejects.toThrow(ActionError);
    const ana = await person();
    const pdf = new File([new TextEncoder().encode('%PDF-1.7 made-up')], 'me.pdf');
    await expect(setEmployeePhoto(ana, ana.employee.id, pdf)).rejects.toMatchObject({
      field: 'photo',
    });
  });
});

describe('audit', () => {
  it('writes one update entry on core.employee per change, and nothing for a no-op remove', async () => {
    const ana = await person();
    await removeEmployeePhoto(ana, ana.employee.id);
    expect(await photoEntries(ana.employee.id)).toHaveLength(0);

    await setEmployeePhoto(ana, ana.employee.id, await cameraPhoto());
    await removeEmployeePhoto(ana, ana.employee.id);
    const entries = await photoEntries(ana.employee.id);
    expect(entries.map((entry) => entry.action)).toEqual(['update', 'update']);
    expect(entries[0]).toMatchObject({
      module: 'core',
      actorEmail: ana.email,
      record: { type: 'core.employee', label: expect.stringMatching(/^2026-\d{2} · Photo Person/) },
    });
    expect(entries[0]?.before).toMatchObject({ photoFileId: null });
    expect(entries[1]?.after).toMatchObject({ photoFileId: null });
  });
});

describe('the stored image', () => {
  it('is WebP of at most 1024 px with no EXIF or GPS metadata', async () => {
    const ana = await person();
    await setEmployeePhoto(ana, ana.employee.id, await cameraPhoto());
    const file = await findStoredFile((await storedPhotoId(ana.employee.id)) ?? '');
    expect(file).toMatchObject({ contentType: 'image/webp', ownerType: EMPLOYEE_PHOTO_OWNER_TYPE });
    const bytes = await readFile(path.join(storageRoot(), ...(file?.storageKey ?? '').split('/')));
    const meta = await sharp(bytes).metadata();
    expect(meta).toMatchObject({ format: 'webp', width: 1024, height: 768 });
    expect(meta.exif).toBeUndefined();
    expect(bytes.toString('latin1')).not.toContain('Made-up camera');
  });
});

describe('who opens the photo', () => {
  it('opens the current photo for any signed-in user, and refuses a replaced or removed one', async () => {
    const ana = await person();
    const someone = await person();
    await setEmployeePhoto(ana, ana.employee.id, await cameraPhoto());
    const first = (await storedPhotoId(ana.employee.id)) ?? '';
    for (const viewer of [someone, systemAccount, ana]) {
      expect((await findAccessibleFile(viewer, first))?.id).toBe(first);
    }

    await setEmployeePhoto(ana, ana.employee.id, await cameraPhoto());
    const second = (await storedPhotoId(ana.employee.id)) ?? '';
    expect(second).not.toBe(first);
    // The old file is kept, but no longer opens.
    expect(await findStoredFile(first)).not.toBeNull();
    expect(await findAccessibleFile(someone, first)).toBeNull();
    expect((await findAccessibleFile(someone, second))?.id).toBe(second);

    await removeEmployeePhoto(ana, ana.employee.id);
    expect(await findAccessibleFile(someone, second)).toBeNull();
  });

  it('refuses another file owned by the employee record, and a temporary password', async () => {
    const ana = await person();
    const other = await saveUpload({
      file: await cameraPhoto(),
      owner: { type: EMPLOYEE_PHOTO_OWNER_TYPE, id: new Types.ObjectId(ana.employee.id) },
      actorId: null,
    });
    await expect(authorizeFileAccess(ana, other)).rejects.toThrow(AccessDeniedError);

    await setEmployeePhoto(ana, ana.employee.id, await cameraPhoto());
    const current = (await storedPhotoId(ana.employee.id)) ?? '';
    expect(await findAccessibleFile({ ...ana, mustChangePassword: true }, current)).toBeNull();
  });
});

describe('employeePhotoUrl', () => {
  it('is the inline file route URL, or null', () => {
    const id = new Types.ObjectId();
    expect(employeePhotoUrl(id)).toBe(`/files/${id.toHexString()}?inline=1`);
    expect(employeePhotoUrl(null)).toBeNull();
    expect(employeePhotoUrl('not-an-id')).toBeNull();
  });
});
