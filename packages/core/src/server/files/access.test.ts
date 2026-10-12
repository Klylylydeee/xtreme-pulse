import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose, { type mongo, Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { AccessDeniedError } from '../../actions';
import { AuditLogModel } from '../audit/model';
import { resolveModuleAccess } from '../auth/module-access';
import type { CurrentUser } from '../auth/session-user';
import { getCompanyLogoFile, removeCompanyLogo, setCompanyLogo } from '../company-settings/service';
import { coreSeedLoaders } from '../seed/loaders';
import {
  authorizeFileAccess,
  findAccessibleFile,
  openAccessibleFile,
  registerFileAccess,
} from './access';
import { storageRoot } from './root';
import { registerCoreFileAccess } from './registrations';
import { openStoredFile, saveUpload, type StoredFile } from './stored-files';

// Every content read goes through this spy, so a test can see what was already written when the
// file was opened (the audit entry comes first) and whether it was opened at all.
const opening = vi.hoisted(() => ({
  onOpen: null as null | ((file: { id: string }) => Promise<void>),
}));
vi.mock('./stored-files', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./stored-files')>();
  return {
    ...actual,
    openStoredFile: vi.fn(async (file: Parameters<typeof actual.openStoredFile>[0]) => {
      await opening.onOpen?.(file);
      return actual.openStoredFile(file);
    }),
  };
});

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
  await AuditLogModel.init();
  await AuditLogModel.createCollection().catch(() => undefined);
  registerCoreFileAccess();
  logo = await setLogo();
  devSample = await upload('dev.sample');
  unregistered = await upload('test.unregistered');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.mocked(openStoredFile).mockClear();
  opening.onOpen = null;
  await database().command({ collMod: 'auditLogs', validator: {} });
});

function database(): mongo.Db {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Not connected.');
  return db;
}

/** Makes every audit log insert fail until afterEach clears it. */
async function breakAuditLog(): Promise<void> {
  await database().command({
    collMod: 'auditLogs',
    validator: { $jsonSchema: { required: ['aFieldNoEntryHas'] } },
    validationLevel: 'strict',
    validationAction: 'error',
  });
}

/** The reveal entries naming `recordId`. */
function revealsOf(recordId: Types.ObjectId) {
  return AuditLogModel.find({ action: 'reveal', 'record.id': recordId }).lean();
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

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

  it('refuses an owner type that audit-logs views, whose content opens only with the entry', async () => {
    registerFileAccess('test.auditedMeta', () => true, {
      auditView: { module: 'talent', record: () => ({ type: 'test.auditedMeta', id: null }) },
    });
    const file = await upload('test.auditedMeta');
    expect(await findAccessibleFile(user, file.id)).toBeNull();
  });
});

// Sensitive file views (build step 2.2, decision 181, docs/TESTING.md#document-e-signature-and-certification-tests).
describe('openAccessibleFile', () => {
  const recordId = new Types.ObjectId();
  let audited: StoredFile;
  let plain: StoredFile;

  beforeAll(async () => {
    registerFileAccess('test.audited', () => true, {
      auditView: {
        module: 'talent',
        record: (file) => ({
          type: 'test.audited',
          id: recordId,
          label: `2027-01 · ${file.ownerType}`,
        }),
      },
    });
    registerFileAccess('test.plain', () => true);
    audited = await upload('test.audited');
    plain = await upload('test.plain');
    registerFileAccess('test.auditedRefused', () => false, {
      auditView: { module: 'talent', record: () => ({ type: 'test.audited', id: recordId }) },
    });
  });

  it('writes one committed reveal entry with fields ["file"] before any content is read', async () => {
    const before = (await revealsOf(recordId)).length;
    let entriesWhenOpened = -1;
    opening.onOpen = async () => {
      // Read outside any transaction: the entry is already committed.
      entriesWhenOpened = (await revealsOf(recordId)).length;
    };

    const opened = await openAccessibleFile(user, audited.id);
    if (!opened) throw new Error('The file did not open.');
    expect(opened.file.id).toBe(audited.id);
    expect(entriesWhenOpened).toBe(before + 1);
    expect(await readAll(opened.stream)).toEqual(PNG);

    const entries = await revealsOf(recordId);
    expect(entries).toHaveLength(before + 1);
    expect(entries.at(-1)).toMatchObject({
      module: 'talent',
      action: 'reveal',
      actorEmail: user.email,
      record: { type: 'test.audited', label: '2027-01 · test.audited' },
      fields: ['file'],
      before: null,
      after: null,
    });
    expect(entries.at(-1)?.actorId?.toHexString()).toBe(user.id);
  });

  it('logs every open, the owner’s own included', async () => {
    const before = (await revealsOf(recordId)).length;
    await openAccessibleFile(user, audited.id);
    await openAccessibleFile(admin, audited.id);
    expect(await revealsOf(recordId)).toHaveLength(before + 2);
  });

  it('opens nothing when the entry can’t be written', async () => {
    const before = (await revealsOf(recordId)).length;
    await breakAuditLog();
    await expect(openAccessibleFile(user, audited.id)).rejects.toThrow();
    expect(openStoredFile).not.toHaveBeenCalled();
    await database().command({ collMod: 'auditLogs', validator: {} });
    expect(await revealsOf(recordId)).toHaveLength(before);
  });

  it('writes the entry even when the content turns out to be missing, then answers null', async () => {
    const lost = await upload('test.audited');
    await unlink(path.join(storageRoot(), ...lost.storageKey.split('/')));
    const before = (await revealsOf(recordId)).length;
    expect(await openAccessibleFile(user, lost.id)).toBeNull();
    expect(await revealsOf(recordId)).toHaveLength(before + 1);
  });

  it('writes nothing for a registration without auditView', async () => {
    const entries = await AuditLogModel.countDocuments({ action: 'reveal' });
    const opened = await openAccessibleFile(user, plain.id);
    if (!opened) throw new Error('The file did not open.');
    expect(await readAll(opened.stream)).toEqual(PNG);
    expect(await AuditLogModel.countDocuments({ action: 'reveal' })).toBe(entries);
  });

  it('answers a refused file the same as a missing one, and writes nothing for either', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const refused = await upload('test.auditedRefused');
    const entries = await AuditLogModel.countDocuments({ action: 'reveal' });
    const answers = await Promise.all([
      openAccessibleFile(user, refused.id),
      openAccessibleFile(user, unregistered.id),
      openAccessibleFile(user, devSample.id),
      openAccessibleFile(user, new Types.ObjectId().toHexString()),
      openAccessibleFile(user, 'not-an-id'),
      openAccessibleFile(signedIn({ mustChangePassword: true }), audited.id),
    ]);
    expect(answers).toEqual([null, null, null, null, null, null]);
    expect(await AuditLogModel.countDocuments({ action: 'reveal' })).toBe(entries);
    expect(openStoredFile).not.toHaveBeenCalled();
  });
});
