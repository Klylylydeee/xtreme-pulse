import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { AccessDeniedError, ActionError } from '../../actions';
import { COMPANY_DETAIL_FIELDS, pendingCompanyDetails } from '../../company-details';
import { AuditLogModel } from '../audit/model';
import type { CurrentUser } from '../auth/session-user';
import { coreSeedLoaders } from '../seed/loaders';
import { COMPANY_DETAIL_PLACEHOLDERS } from '../seed/core-data';
import { saveUpload } from '../files/stored-files';
import { COMPANY_SETTINGS_KEY, CompanySettingsModel } from './model';
import {
  getCompanyDetailsStatus,
  getCompanyLogoFile,
  getCompanySettings,
  removeCompanyLogo,
  setCompanyLogo,
  updateCompanyDetails,
} from './service';

// Company settings (docs/modules/core.md#company-settings-page,
// docs/TESTING.md#core-administration-tests). Made-up data only.

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const PDF = new TextEncoder().encode('%PDF-1.7 made-up');

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
const hr = actor({
  email: 'hr.test@xtreme-works.com',
  isSystemAdministrator: false,
  roles: ['hr'],
});

const FILLED = {
  registeredName: 'Made-up Systems Inc.',
  businessAddress: '1 Sample Street, Makati City',
  tin: '000-000-000-00000',
  rdoCode: '050',
  sssEmployerNumber: '00-0000000-0',
  philhealthEmployerNumber: '00-000000000-0',
  pagibigEmployerId: '0000-0000-0000',
  birRegistration: { casPermitDetails: 'Made-up permit 0001', invoiceSeries: '0001-9999' },
};

let storageDir: string;

beforeAll(async () => {
  storageDir = await mkdtemp(path.join(tmpdir(), 'pulse-test-storage-'));
  process.env.FILE_STORAGE_DIR = storageDir;
  await connectDb();
  for (const loader of coreSeedLoaders) await loader.run();
});

afterAll(async () => {
  await rm(storageDir, { recursive: true, force: true });
});

async function settingsEntries() {
  return AuditLogModel.find({ 'record.type': 'core.companySettings' }).sort({ _id: 1 }).lean();
}

describe('pendingCompanyDetails', () => {
  it('lists every detail and the logo at seed time', async () => {
    const pending = pendingCompanyDetails({ ...COMPANY_DETAIL_PLACEHOLDERS, logoFileId: null });
    expect(pending.map((detail) => detail.path)).toEqual([
      ...COMPANY_DETAIL_FIELDS.map((field) => field.path),
      'logoFileId',
    ]);
    const status = await getCompanyDetailsStatus();
    expect(status.complete).toBe(false);
    expect(status.pending).toHaveLength(COMPANY_DETAIL_FIELDS.length + 1);
  });

  it('is empty once everything, the logo included, is filled in', () => {
    expect(pendingCompanyDetails({ ...FILLED, logoFileId: new Types.ObjectId() })).toEqual([]);
  });

  it('counts the logo while logoFileId is null', () => {
    expect(pendingCompanyDetails({ ...FILLED, logoFileId: null })).toEqual([
      { path: 'logoFileId', label: 'Company logo' },
    ]);
  });

  it('counts a single remaining placeholder, also a BIR one', () => {
    const pending = pendingCompanyDetails({
      ...FILLED,
      birRegistration: { ...FILLED.birRegistration, invoiceSeries: '[Invoice series]' },
      logoFileId: new Types.ObjectId(),
    });
    expect(pending.map((detail) => detail.path)).toEqual(['birRegistration.invoiceSeries']);
  });
});

describe('updateCompanyDetails', () => {
  it('refuses anyone but the System Administrator and changes nothing', async () => {
    const before = await CompanySettingsModel.findOne({
      singletonKey: COMPANY_SETTINGS_KEY,
    }).lean();
    await expect(updateCompanyDetails(hr, FILLED)).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(
      updateCompanyDetails(actor({ isSystemAdministrator: false }), FILLED),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    const after = await CompanySettingsModel.findOne({ singletonKey: COMPANY_SETTINGS_KEY }).lean();
    expect(after).toEqual(before);
    expect(await settingsEntries()).toHaveLength(0);
  });

  it('refuses a blank detail on its field', async () => {
    const error = await updateCompanyDetails(admin, {
      ...FILLED,
      birRegistration: { ...FILLED.birRegistration, invoiceSeries: '  ' },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ActionError);
    expect((error as ActionError).field).toBe('birRegistration.invoiceSeries');
    expect(await settingsEntries()).toHaveLength(0);
  });

  it('saves the details with exactly one update audit entry', async () => {
    const view = await updateCompanyDetails(admin, FILLED);
    expect(view).toMatchObject(FILLED);

    const stored = await CompanySettingsModel.findOne({ singletonKey: COMPANY_SETTINGS_KEY })
      .lean()
      .orFail();
    expect(stored).toMatchObject(FILLED);
    expect(stored.updatedBy?.toHexString()).toBe(admin.id);

    const entries = await settingsEntries();
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry).toMatchObject({
      module: 'core',
      action: 'update',
      actorEmail: admin.email,
      record: { type: 'core.companySettings', id: stored._id },
    });
    expect(entry?.actorId?.toHexString()).toBe(admin.id);
    expect(entry?.before).toMatchObject({ tin: COMPANY_DETAIL_PLACEHOLDERS.tin });
    expect(entry?.after).toMatchObject({
      tin: FILLED.tin,
      birRegistration: FILLED.birRegistration,
    });

    // Only the logo is pending now.
    const status = await getCompanyDetailsStatus();
    expect(status.pending.map((detail) => detail.path)).toEqual(['logoFileId']);
  });
});

describe('the company logo', () => {
  it('refuses anyone but the System Administrator', async () => {
    const file = new File([PNG], 'logo.png', { type: 'image/png' });
    await expect(setCompanyLogo(hr, file)).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(removeCompanyLogo(hr)).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it('accepts PNG, JPEG and WebP only', async () => {
    const pdf = new File([PDF], 'logo.png', { type: 'image/png' });
    const error = await setCompanyLogo(admin, pdf).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ActionError);
    expect((error as ActionError).field).toBe('logo');
    expect((await getCompanySettings()).logoFileId).toBeNull();
  });

  it('sets the logo with an update entry, and the lookup serves only that file', async () => {
    const entriesBefore = (await settingsEntries()).length;
    // Another stored image, not the logo.
    const other = await saveUpload({
      file: new File([PNG], 'other.png'),
      owner: { type: 'core.companySettings', id: null },
      actorId: null,
    });

    expect(await getCompanyLogoFile()).toBeNull();
    const view = await setCompanyLogo(admin, new File([PNG], 'logo.png'));
    expect(view.logoFileId).not.toBeNull();
    expect(view.logoUrl).toBe(`/company-logo?v=${view.logoFileId}`);

    const logo = await getCompanyLogoFile();
    expect(logo?.id).toBe(view.logoFileId);
    expect(logo?.id).not.toBe(other.id);
    expect(logo?.contentType).toBe('image/png');

    const entries = await settingsEntries();
    expect(entries).toHaveLength(entriesBefore + 1);
    expect(entries.at(-1)).toMatchObject({ action: 'update' });
    expect(entries.at(-1)?.after).toMatchObject({ logoFileId: view.logoFileId });
    expect((await getCompanyDetailsStatus()).complete).toBe(true);
  });

  it('serves nothing when the logo points at a file that isn’t an allowed image', async () => {
    const current = await getCompanySettings();
    const pdf = await saveUpload({
      file: new File([PDF], 'doc.pdf'),
      owner: { type: 'core.companySettings', id: null },
      actorId: null,
    });
    await CompanySettingsModel.updateOne(
      { singletonKey: COMPANY_SETTINGS_KEY },
      { $set: { logoFileId: new Types.ObjectId(pdf.id) } },
    );
    expect(await getCompanyLogoFile()).toBeNull();
    await CompanySettingsModel.updateOne(
      { singletonKey: COMPANY_SETTINGS_KEY },
      { $set: { logoFileId: new Types.ObjectId(current.logoFileId ?? undefined) } },
    );
  });

  it('removes the logo with an update entry; removing again writes nothing', async () => {
    const entriesBefore = (await settingsEntries()).length;
    const view = await removeCompanyLogo(admin);
    expect(view.logoFileId).toBeNull();
    expect(await getCompanyLogoFile()).toBeNull();
    expect(await settingsEntries()).toHaveLength(entriesBefore + 1);

    await removeCompanyLogo(admin);
    expect(await settingsEntries()).toHaveLength(entriesBefore + 1);
    const status = await getCompanyDetailsStatus();
    expect(status.pending.map((detail) => detail.path)).toEqual(['logoFileId']);
  });
});
