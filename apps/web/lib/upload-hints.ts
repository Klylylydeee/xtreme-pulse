import { UPLOAD_TYPES, type UploadType } from '@pulse/core';
import { getFileUploadSettingsInfo } from '@pulse/core/server';

// The accepted types and size limit a file field names (docs/DESIGN_SYSTEM.md#layout--components,
// "Uploads use a sheet with a file field that names the accepted types and the size limit"), built
// from the upload settings in effect today (docs/ARCHITECTURE.md#file-storage). The server checks
// the file again from its own bytes; this only tells people what will be accepted.

const BYTES_PER_MEGABYTE = 1024 * 1024;
/** Photos and signatures are re-encoded, so only these image types are taken. */
const IMAGE_TYPES: readonly UploadType[] = ['image/jpeg', 'image/png', 'image/webp'];

/** One file field's `accept` attribute and the hint under it. */
export interface UploadHint {
  accept: string;
  hint: string;
}

export interface UploadHints {
  /** 201 documents and certification attachments: any allowed type, stored byte for byte. */
  document: UploadHint;
  /** Profile photos and e-signatures: the allowed image types. */
  image: UploadHint;
}

/** "PDF", "PDF or JPEG", "PDF, JPEG or PNG". */
function listOfTypes(types: readonly UploadType[]): string {
  const names = types.map((type) => UPLOAD_TYPES[type].label.replace(/ image$/, ''));
  const last = names.pop();
  return names.length > 0 ? `${names.join(', ')} or ${last}` : (last ?? '');
}

function hintFor(types: readonly UploadType[], maxMegabytes: number): UploadHint {
  if (types.length === 0) {
    return {
      accept: '',
      hint: 'The upload settings allow no file type for this right now. Ask the System Administrator.',
    };
  }
  return {
    accept: types.join(','),
    hint: `${listOfTypes(types)}, up to ${maxMegabytes} MB.`,
  };
}

/** The hints for today's upload settings. */
export async function getUploadHints(): Promise<UploadHints> {
  const { settings } = await getFileUploadSettingsInfo();
  const maxMegabytes = Math.floor(settings.maxSizeBytes / BYTES_PER_MEGABYTE);
  const allowed = settings.allowedTypes;
  return {
    document: hintFor(allowed, maxMegabytes),
    image: hintFor(
      IMAGE_TYPES.filter((type) => allowed.includes(type)),
      maxMegabytes,
    ),
  };
}
