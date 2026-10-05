import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { AccessDeniedError } from '../../actions';
import { resolveModuleAccess } from '../auth/module-access';
import type { CurrentUser } from '../auth/session-user';
import { getCompanyLogoFile, removeCompanyLogo, setCompanyLogo } from '../company-settings/service';
import { coreSeedLoaders } from '../seed/loaders';
import { authorizeFileAccess, findAccessibleFile, registerFileAccess } from './access';
import { registerCoreFileAccess } from './registrations';
import { saveUpload, type StoredFile } from './stored-files';

// The file access registry (docs/ARCHITECTURE.md#file-storage,
// docs/TESTING.md#module-access-tests). Made-up data only.

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

// An ordinary signed-in user with no roles. The checks registered so far don't read module access.
function signedIn(overrides: Partial<CurrentUser> = {}): CurrentUser {
  const isSystemAdministrator = overrides.isSystemAdministrator ?? false;
  return {
    id: new Types.ObjectId().toHexString(),
    email: 'staff.test@xtreme-works.com',
    mustChangePassword: false,
    isSystemAdministrator,
    isSystemAccount: false,
    employee: null,
    roles: [],
    moduleAccess: resolveModuleAccess({ isSystemAdministrator }),
    ...overrides,
  };
}

const user = signedIn();
const admin = signedIn({ email: 'admin.test@xtreme-works.com', isSystemAdministrator: true });

let storageDir: string;
let logo: StoredFile;
let devSample: StoredFile;
let unregistered: StoredFile;

function upload(ownerType: string): Promise<StoredFile> {
  return saveUpload({
    file: new File([PNG], 'file.png'),
    owner: { type: ownerType, id: null },
    actorId: null,
  });
}

// The file set as the company logo in company settings.
async function setLogo(): Promise<StoredFile> {
  await setCompanyLogo(admin, new File([PNG], 'logo.png'));
  const file = await getCompanyLogoFile();
  if (!file) throw new Error('The logo was not set.');
  return file;
}

beforeAll(async () => {
  storageDir = await mkdtemp(path.join(tmpdir(), 'pulse-test-storage-'));
  process.env.FILE_STORAGE_DIR = storageDir;
  await connectDb();
  for (const loader of coreSeedLoaders) await loader.run();
  registerCoreFileAccess();
  logo = await setLogo();
  devSample = await upload('dev.sample');
  unregistered = await upload('test.unregistered');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await rm(storageDir, { recursive: true, force: true });
});

describe('authorizeFileAccess', () => {
  it('refuses an owner type nobody registered', async () => {
    await expect(authorizeFileAccess(user, unregistered)).rejects.toThrow(AccessDeniedError);
  });

  it('opens the current company logo for a signed-in user', async () => {
    await expect(authorizeFileAccess(user, logo)).resolves.toBeUndefined();
  });

  it('refuses a company settings file that is not the current logo', async () => {
    // Owned by the settings record type, but never set as the logo.
    const other = await upload('core.companySettings');
    await expect(authorizeFileAccess(user, other)).rejects.toThrow(AccessDeniedError);

    // A replaced logo stops opening; the new one opens. A removed logo stops opening too.
    const replacement = await setLogo();
    await expect(authorizeFileAccess(user, logo)).rejects.toThrow(AccessDeniedError);
    await expect(authorizeFileAccess(user, replacement)).resolves.toBeUndefined();
    await removeCompanyLogo(admin);
    await expect(authorizeFileAccess(user, replacement)).rejects.toThrow(AccessDeniedError);

    logo = await setLogo();
  });

  it('refuses every file while the password is temporary', async () => {
    await expect(authorizeFileAccess(signedIn({ mustChangePassword: true }), logo)).rejects.toThrow(
      AccessDeniedError,
    );
  });

  it('opens development samples in development and refuses them in production', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    await expect(authorizeFileAccess(user, devSample)).resolves.toBeUndefined();
    vi.stubEnv('NODE_ENV', 'production');
    await expect(authorizeFileAccess(user, devSample)).rejects.toThrow(AccessDeniedError);
  });
});

describe('registerCoreFileAccess', () => {
  it('registers once, so calling it again does nothing, even in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => registerCoreFileAccess()).not.toThrow();
  });
});

describe('registerFileAccess', () => {
  it('replaces the check when an owner type is registered again in development', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    registerFileAccess('test.again', () => true);
    const file = await upload('test.again');
    await expect(authorizeFileAccess(user, file)).resolves.toBeUndefined();
    registerFileAccess('test.again', () => false);
    await expect(authorizeFileAccess(user, file)).rejects.toThrow(AccessDeniedError);
  });

  it('throws when an owner type is registered again in production, and keeps the first check', async () => {
    registerFileAccess('test.once', () => true);
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => registerFileAccess('test.once', () => false)).toThrow(/already registered/);
    const file = await upload('test.once');
    await expect(authorizeFileAccess(user, file)).resolves.toBeUndefined();
  });

  it('refuses something that is not a record type', () => {
    expect(() => registerFileAccess('../files', () => true)).toThrow(/isn't a record type/);
  });

  it('refuses when a check answers anything but true', async () => {
    registerFileAccess('test.refused', () => false);
    const refused = await upload('test.refused');
    await expect(authorizeFileAccess(user, refused)).rejects.toThrow(AccessDeniedError);
  });
});

describe('findAccessibleFile', () => {
  it('returns a file the user may open', async () => {
    expect((await findAccessibleFile(user, logo.id))?.id).toBe(logo.id);
  });

  it('answers a refused file the same as a missing one', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const answers = await Promise.all([
      findAccessibleFile(user, unregistered.id),
      findAccessibleFile(user, devSample.id),
      findAccessibleFile(user, new Types.ObjectId().toHexString()),
      findAccessibleFile(user, 'not-an-id'),
    ]);
    expect(answers).toEqual([null, null, null, null]);
  });
});
