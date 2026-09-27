import { z } from 'zod';
import { defineConfigSetting, findConfigVersion } from '../config';
import { UPLOAD_TYPE_NAMES, type UploadType } from './file-types';

// Spec: docs/ARCHITECTURE.md#file-storage — "Uploads are checked against allowed file types and a
// maximum size, both settings." They are kept in the versioned configuration store
// (docs/DATA_MODEL.md#versioned-configuration), so a change is a new dated version.

/**
 * The upload request ceiling: the Server Action body limit in apps/web/next.config.ts
 * (`serverActions.bodySizeLimit`, 25 MB). Keep the two equal. The upload setting can't go above it,
 * because a larger request is cut off before the storage service sees it.
 */
export const UPLOAD_REQUEST_LIMIT_BYTES = 25 * 1024 * 1024;

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
