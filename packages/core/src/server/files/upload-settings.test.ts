import { beforeAll, describe, expect, it } from 'vitest';
import mongoose, { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { AccessDeniedError, ActionError } from '../../actions';
import { businessToday, startOfBusinessDate } from '../../dates';
import { AuditLogModel } from '../audit/model';
import type { CurrentUser } from '../auth/session-user';
import {
  currentFileUploadSettings,
  DEFAULT_FILE_UPLOAD_SETTINGS,
  getFileUploadSettingsInfo,
  updateFileUploadSettings,
} from './settings';

// Upload settings (docs/modules/core.md#company-settings-page,
// docs/TESTING.md#core-administration-tests). Made-up data only.

function actor(overrides: Partial<CurrentUser> = {}): CurrentUser {
  return {
    id: new Types.ObjectId().toHexString(),
    email: 'admin.test@xtreme-works.com',
    mustChangePassword: false,
    isSystemAdministrator: true,
    isSystemAccount: false,
    employee: null,
    roles: [],
    ...overrides,
  };
}

const admin = actor();

function versions() {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Not connected.');
  return db.collection('configVersions').find({ key: 'core.fileUploads' }).toArray();
}

async function auditEntries() {
  return AuditLogModel.find({ 'record.type': 'core.configVersion' }).lean();
}

beforeAll(async () => {
  await connectDb();
});

describe('updateFileUploadSettings', () => {
  it('refuses anyone but the System Administrator and changes nothing', async () => {
    const hr = actor({ isSystemAdministrator: false, roles: ['hr'] });
    await expect(
      updateFileUploadSettings(hr, { maxSizeMegabytes: 5, allowedTypes: ['application/pdf'] }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    expect(await versions()).toHaveLength(0);
    expect(await auditEntries()).toHaveLength(0);
    expect(await currentFileUploadSettings()).toEqual(DEFAULT_FILE_UPLOAD_SETTINGS);
  });

  it('refuses invalid input on its field', async () => {
    const tooBig = await updateFileUploadSettings(admin, {
      maxSizeMegabytes: 26,
      allowedTypes: ['application/pdf'],
    }).catch((caught: unknown) => caught);
    expect(tooBig).toBeInstanceOf(ActionError);
    expect((tooBig as ActionError).field).toBe('maxSizeMegabytes');

    const noTypes = await updateFileUploadSettings(admin, {
      maxSizeMegabytes: 5,
      allowedTypes: [],
    }).catch((caught: unknown) => caught);
    expect((noTypes as ActionError).field).toBe('allowedTypes');
    expect(await versions()).toHaveLength(0);
  });

  it('adds a version effective today in Manila, with its audit entry', async () => {
    const today = businessToday();
    const info = await updateFileUploadSettings(admin, {
      maxSizeMegabytes: '5',
      allowedTypes: 'application/pdf',
    });
    expect(info).toEqual({
      settings: { maxSizeBytes: 5 * 1024 * 1024, allowedTypes: ['application/pdf'] },
      effectiveFrom: today,
      changedToday: true,
    });

    const stored = await versions();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.effectiveFrom).toEqual(startOfBusinessDate(today));
    expect(stored[0]?.createdBy?.toHexString()).toBe(admin.id);
    expect(await currentFileUploadSettings()).toEqual(info.settings);

    const entries = await auditEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      module: 'core',
      action: 'create',
      before: null,
      actorEmail: admin.email,
      record: { type: 'core.configVersion', id: stored[0]?._id },
    });
    expect(entries[0]?.after).toMatchObject({
      key: 'core.fileUploads',
      effectiveFrom: today,
      value: info.settings,
    });
    expect(await getFileUploadSettingsInfo()).toEqual(info);
  });

  it('refuses a second change on the same Manila day and changes nothing', async () => {
    const error = await updateFileUploadSettings(admin, {
      maxSizeMegabytes: 8,
      allowedTypes: ['image/png'],
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ActionError);
    expect((error as Error).message).toContain('already changed today');
    expect(await versions()).toHaveLength(1);
    expect(await auditEntries()).toHaveLength(1);
    expect((await currentFileUploadSettings()).maxSizeBytes).toBe(5 * 1024 * 1024);
  });
});
