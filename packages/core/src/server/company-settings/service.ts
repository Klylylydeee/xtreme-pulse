import { connectDb, withTransaction } from '@pulse/db';
import { ActionError } from '../../actions';
import {
  type CompanyDetailField,
  type CompanyDetailsFormInput,
  companyDetailsSchema,
  pendingCompanyDetails,
} from '../../company-details';
import { now } from '../../dates';
import { recordAudit } from '../audit/service';
import { snapshotsForAudit } from '../audit/snapshot';
import type { CurrentUser } from '../auth/session-user';
import { assertSystemAdministrator } from '../auth/roles';
import { toObjectId } from '../paging';
import { findStoredFile, saveUpload, type StoredFile } from '../files/stored-files';
import type { UploadType } from '../files/file-types';
import {
  type BirRegistration,
  COMPANY_SETTINGS_KEY,
  type CompanySettingsRecord,
  CompanySettingsModel,
} from './model';

// Spec: docs/modules/core.md#company-settings-page — the one company settings record. Documents
// and reports read the details from here. Only the System Administrator changes them (until module
// access in step 1.6); each change writes its audit entry (`core.companySettings`, action
// `update`) in the same transaction. Setting or removing the logo is an `update` too.
//
// The logo is public (SECURITY.md#exceptions-to-module-access): `/company-logo` serves only the
// stored file whose id equals `logoFileId`, and only a PNG, JPEG or WebP image.

/** The audit record type of the settings record. */
export const COMPANY_SETTINGS_RECORD_TYPE = 'core.companySettings';

/** The file owner type of the company logo. */
export const COMPANY_LOGO_OWNER_TYPE = 'core.companySettings';

/** The logo's accepted types. */
export const COMPANY_LOGO_TYPES: readonly UploadType[] = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/webp',
]);

/** The company settings, as pages and documents see them. */
export interface CompanySettingsView {
  id: string;
  registeredName: string;
  businessAddress: string;
  tin: string;
  rdoCode: string;
  sssEmployerNumber: string;
  philhealthEmployerNumber: string;
  pagibigEmployerId: string;
  birRegistration: BirRegistration;
  /** The logo's stored file id, or null while none is uploaded. */
  logoFileId: string | null;
  /** The public logo URL with its cache buster, or null while none is uploaded. */
  logoUrl: string | null;
  updatedAt: Date;
}

/** Thrown when the settings record is missing (the seed hasn't run). */
export class CompanySettingsMissingError extends Error {
  constructor() {
    super('The company settings record is missing. Run `pnpm seed:admin` to add the base data.');
    this.name = 'CompanySettingsMissingError';
  }
}

const MISSING_FOR_FORM =
  'The company settings record is missing. Ask whoever set up Pulse to run the seed, then try again.';

/** The public logo URL for a logo file id, with the id as its cache buster. */
export function companyLogoUrl(logoFileId: string): string {
  return `/company-logo?v=${encodeURIComponent(logoFileId)}`;
}

function toView(record: CompanySettingsRecord): CompanySettingsView {
  const logoFileId = record.logoFileId ? record.logoFileId.toHexString() : null;
  return {
    id: record._id.toHexString(),
    registeredName: record.registeredName,
    businessAddress: record.businessAddress,
    tin: record.tin,
    rdoCode: record.rdoCode,
    sssEmployerNumber: record.sssEmployerNumber,
    philhealthEmployerNumber: record.philhealthEmployerNumber,
    pagibigEmployerId: record.pagibigEmployerId,
    birRegistration: {
      casPermitDetails: record.birRegistration?.casPermitDetails ?? '',
      invoiceSeries: record.birRegistration?.invoiceSeries ?? '',
    },
    logoFileId,
    logoUrl: logoFileId ? companyLogoUrl(logoFileId) : null,
    updatedAt: record.updatedAt,
  };
}

async function findSettings() {
  await connectDb();
  return CompanySettingsModel.findOne({ singletonKey: COMPANY_SETTINGS_KEY }).lean();
}

/** The company settings. Throws {@link CompanySettingsMissingError} before the seed has run. */
export async function getCompanySettings(): Promise<CompanySettingsView> {
  const record = await findSettings();
  if (!record) throw new CompanySettingsMissingError();
  return toView(record);
}

export interface CompanyDetailsStatus {
  /** The details still pending, the logo last when it is missing. Empty when all are filled in. */
  pending: CompanyDetailField[];
  complete: boolean;
}

/**
 * Which company details are still placeholders, the logo included. Without a settings record
 * (before the seed), every detail counts as pending.
 */
export async function getCompanyDetailsStatus(): Promise<CompanyDetailsStatus> {
  const record = await findSettings();
  const pending = pendingCompanyDetails(
    record ?? {
      registeredName: '',
      businessAddress: '',
      tin: '',
      rdoCode: '',
      sssEmployerNumber: '',
      philhealthEmployerNumber: '',
      pagibigEmployerId: '',
      birRegistration: null,
      logoFileId: null,
    },
  );
  return { pending, complete: pending.length === 0 };
}

/**
 * The stored file set as the company logo, for the public `/company-logo` route: only the file
 * whose id equals `logoFileId`, owned by the settings record, and only a PNG, JPEG or WebP image.
 * Null in every other case (no logo, an unknown or removed file, another type).
 */
export async function getCompanyLogoFile(): Promise<StoredFile | null> {
  const record = await findSettings();
  if (!record?.logoFileId) return null;
  const file = await findStoredFile(record.logoFileId.toHexString());
  if (!file || file.id !== record.logoFileId.toHexString()) return null;
  if (file.ownerType !== COMPANY_LOGO_OWNER_TYPE) return null;
  if (!(COMPANY_LOGO_TYPES as readonly string[]).includes(file.contentType)) return null;
  return file;
}

function firstIssue(error: { issues: { path: PropertyKey[]; message: string }[] }): ActionError {
  const issue = error.issues[0];
  const field = issue?.path.map(String).join('.') || undefined;
  return new ActionError(issue?.message ?? 'Check the form and try again.', { field });
}

/** Writes `changes` to the settings record with its `update` audit entry, in one transaction. */
async function updateSettings(
  actor: CurrentUser,
  changes: Partial<Omit<CompanySettingsRecord, '_id' | 'singletonKey' | 'createdAt' | 'createdBy'>>,
): Promise<CompanySettingsView> {
  const actorId = toObjectId(actor.id);
  return withTransaction(async (session) => {
    const original = await CompanySettingsModel.findOne(
      { singletonKey: COMPANY_SETTINGS_KEY },
      null,
      { session },
    );
    if (!original) throw new ActionError(MISSING_FOR_FORM);
    const before = original.toObject();
    const set = { ...changes, updatedBy: actorId, updatedAt: now() };
    // An update, not `save()`: `withTransaction` may run this callback again, and a retried save
    // would find nothing modified and skip the write.
    await CompanySettingsModel.updateOne(
      { _id: original._id },
      { $set: set },
      { session, timestamps: false, runValidators: true },
    );
    original.set(set);
    const after = original.toObject();
    const snapshots = snapshotsForAudit(CompanySettingsModel, before, after);
    await recordAudit(
      {
        actorId: actor.id,
        actorEmail: actor.email,
        module: 'core',
        action: 'update',
        record: { type: COMPANY_SETTINGS_RECORD_TYPE, id: original._id, label: 'Company settings' },
        before: snapshots.before,
        after: snapshots.after,
      },
      { session },
    );
    return toView(after as CompanySettingsRecord);
  });
}

/**
 * Saves the company details. System Administrator only ({@link AccessDeniedError}). Throws
 * {@link ActionError} (with the field) for invalid input. `birRegistration` is always written as
 * an object.
 */
export async function updateCompanyDetails(
  actor: CurrentUser,
  input: CompanyDetailsFormInput,
): Promise<CompanySettingsView> {
  assertSystemAdministrator(actor);
  const parsed = companyDetailsSchema.safeParse(input);
  if (!parsed.success) throw firstIssue(parsed.error);
  const details = parsed.data;
  return updateSettings(actor, {
    registeredName: details.registeredName,
    businessAddress: details.businessAddress,
    tin: details.tin,
    rdoCode: details.rdoCode,
    sssEmployerNumber: details.sssEmployerNumber,
    philhealthEmployerNumber: details.philhealthEmployerNumber,
    pagibigEmployerId: details.pagibigEmployerId,
    birRegistration: {
      casPermitDetails: details.birRegistration.casPermitDetails,
      invoiceSeries: details.birRegistration.invoiceSeries,
    },
  });
}

/**
 * Uploads a new company logo (PNG, JPEG or WebP) and sets it. System Administrator only. The file
 * is saved first, outside the transaction (saving a file is a side effect, and the transaction can
 * run more than once); then `logoFileId` and the audit entry are written in one transaction. If
 * that transaction fails, the saved file is left orphaned in storage (accepted by the spec).
 * Refusals of the file itself come back as {@link ActionError} on the field `logo`.
 */
export async function setCompanyLogo(actor: CurrentUser, file: File): Promise<CompanySettingsView> {
  assertSystemAdministrator(actor);
  const current = await findSettings();
  if (!current) throw new ActionError(MISSING_FOR_FORM);
  const stored = await saveUpload({
    file,
    owner: { type: COMPANY_LOGO_OWNER_TYPE, id: current._id },
    actorId: toObjectId(actor.id),
    accept: COMPANY_LOGO_TYPES,
    field: 'logo',
  });
  const logoFileId = toObjectId(stored.id);
  if (!logoFileId) throw new Error('The stored logo has no valid id.');
  return updateSettings(actor, { logoFileId });
}

/**
 * Removes the company logo: screens show the placeholder mark again. System Administrator only.
 * Nothing is written (and nothing audit-logged) when no logo is set. The stored file is kept.
 */
export async function removeCompanyLogo(actor: CurrentUser): Promise<CompanySettingsView> {
  assertSystemAdministrator(actor);
  const current = await findSettings();
  if (!current) throw new ActionError(MISSING_FOR_FORM);
  if (!current.logoFileId) return toView(current);
  return updateSettings(actor, { logoFileId: null });
}
