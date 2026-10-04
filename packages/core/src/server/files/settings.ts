import { z } from 'zod';
import { connectDb, withTransaction } from '@pulse/db';
import { ActionError } from '../../actions';
import {
  fileUploadSettingsInputSchema,
  type FileUploadSettingsInput,
  UPLOAD_SIZE_MAX_MEGABYTES,
} from '../../company-details';
import { type BusinessDate, businessToday, formatDate } from '../../dates';
import { recordAudit } from '../audit/service';
import { assertSystemAdministrator } from '../auth/roles';
import type { CurrentUser } from '../auth/session-user';
import {
  addConfigVersion,
  ConfigVersionExistsError,
  defineConfigSetting,
  findConfigVersion,
} from '../config';
import { toObjectId } from '../paging';
import { UPLOAD_TYPE_NAMES, type UploadType } from './file-types';

// Spec: docs/ARCHITECTURE.md#file-storage — "Uploads are checked against allowed file types and a
// maximum size, both settings." They are kept in the versioned configuration store
// (docs/DATA_MODEL.md#versioned-configuration), so a change is a new dated version. The System
// Administrator changes them on the company settings page (docs/modules/core.md#company-settings-page):
// a change takes effect from today in Manila, and only one change can take effect per day.

/**
 * The upload request ceiling: the Server Action body limit in apps/web/next.config.ts
 * (`serverActions.bodySizeLimit`, 25 MB). Keep the two equal. The upload setting can't go above it,
 * because a larger request is cut off before the storage service sees it.
 */
export const UPLOAD_REQUEST_LIMIT_BYTES = UPLOAD_SIZE_MAX_MEGABYTES * 1024 * 1024;

const BYTES_PER_MEGABYTE = 1024 * 1024;

export const FILE_UPLOADS_SETTING = defineConfigSetting(
  'core.fileUploads',
  z.object({
    /** The largest upload, in bytes. */
    maxSizeBytes: z.number().int().positive().max(UPLOAD_REQUEST_LIMIT_BYTES),
    /** Types accepted, checked against the file's content. */
    allowedTypes: z.array(z.enum(UPLOAD_TYPE_NAMES)).min(1),
  }),
);

export interface FileUploadSettings {
  maxSizeBytes: number;
  allowedTypes: UploadType[];
}

/**
 * Used until a `core.fileUploads` version is added (Pulse Core admin settings, Phase 1): 10 MB of
 * PDF, JPEG, PNG or WebP, which covers receipts, medical certificates, 201 documents and photos.
 */
export const DEFAULT_FILE_UPLOAD_SETTINGS: FileUploadSettings = Object.freeze({
  maxSizeBytes: 10 * 1024 * 1024,
  allowedTypes: [...UPLOAD_TYPE_NAMES],
});

/** The upload settings in effect now. */
export async function currentFileUploadSettings(): Promise<FileUploadSettings> {
  const version = await findConfigVersion(FILE_UPLOADS_SETTING, new Date());
  return version?.value ?? DEFAULT_FILE_UPLOAD_SETTINGS;
}

/** The upload settings for the settings page. */
export interface FileUploadSettingsInfo {
  settings: FileUploadSettings;
  /** The Manila day the settings in effect started, or null while the defaults apply. */
  effectiveFrom: BusinessDate | null;
  /** True when a change already takes effect today, so another one is refused until tomorrow. */
  changedToday: boolean;
}

/** The upload settings in effect today, and whether they can still be changed today. */
export async function getFileUploadSettingsInfo(): Promise<FileUploadSettingsInfo> {
  await connectDb();
  const today = businessToday();
  const version = await findConfigVersion(FILE_UPLOADS_SETTING, today);
  return {
    settings: version?.value ?? { ...DEFAULT_FILE_UPLOAD_SETTINGS },
    effectiveFrom: version?.effectiveFrom ?? null,
    changedToday: version?.effectiveFrom === today,
  };
}

function alreadyChangedToday(today: BusinessDate): ActionError {
  return new ActionError(
    `The upload settings were already changed today (${formatDate(today)}). Only one change can take effect per day: change them again tomorrow.`,
  );
}

/**
 * Changes the upload settings: adds a new `core.fileUploads` version effective from today in
 * Manila, with its audit entry (`create` of a `core.configVersion`), in one transaction. System
 * Administrator only (`AccessDeniedError`). A second change on the same Manila day is refused
 * with {@link ActionError} and changes nothing.
 */
export async function updateFileUploadSettings(
  actor: CurrentUser,
  input: FileUploadSettingsInput,
): Promise<FileUploadSettingsInfo> {
  assertSystemAdministrator(actor);
  const parsed = fileUploadSettingsInputSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.map(String).join('.') || undefined;
    throw new ActionError(issue?.message ?? 'Check the form and try again.', { field });
  }
  const value: FileUploadSettings = {
    maxSizeBytes: parsed.data.maxSizeMegabytes * BYTES_PER_MEGABYTE,
    // Keep the listed order, once each.
    allowedTypes: UPLOAD_TYPE_NAMES.filter((type) => parsed.data.allowedTypes.includes(type)),
  };
  const today = businessToday();

  try {
    const version = await withTransaction(async (session) => {
      const inEffect = await findConfigVersion(FILE_UPLOADS_SETTING, today, { session });
      if (inEffect?.effectiveFrom === today) throw alreadyChangedToday(today);
      const added = await addConfigVersion(FILE_UPLOADS_SETTING, {
        effectiveFrom: today,
        value,
        actorId: toObjectId(actor.id),
        session,
      });
      await recordAudit(
        {
          actorId: actor.id,
          actorEmail: actor.email,
          module: 'core',
          action: 'create',
          record: {
            type: 'core.configVersion',
            id: added.id,
            label: `${FILE_UPLOADS_SETTING.key} from ${added.effectiveFrom}`,
          },
          before: null,
          after: {
            key: added.key,
            effectiveFrom: added.effectiveFrom,
            value: added.value,
            source: added.source,
          },
        },
        { session },
      );
      return added;
    });
    return { settings: version.value, effectiveFrom: version.effectiveFrom, changedToday: true };
  } catch (error) {
    // Another change for today committed first (the unique key and effective date).
    if (error instanceof ConfigVersionExistsError) throw alreadyChangedToday(today);
    throw error;
  }
}
