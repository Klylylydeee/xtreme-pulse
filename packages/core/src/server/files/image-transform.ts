import sharp from 'sharp';
import { ActionError } from '../../actions';
import type { UploadType } from './file-types';

// Spec: docs/ARCHITECTURE.md#file-storage (decision 174 in docs/BUILD_PLAN.md) — profile photos and
// e-signatures are re-encoded on the server before they are stored. Every image is auto-rotated
// from its EXIF orientation, and its metadata (EXIF, GPS, XMP, ICC comments) is dropped: sharp
// writes none unless asked to keep it, and nothing here asks. Other uploads (201 documents,
// certificate attachments) are stored byte for byte.

/** The re-encodings `saveUpload` offers (its `transform` option). */
export const UPLOAD_TRANSFORMS = {
  /** A profile photo: WebP, at most 1024 px on its longer side. */
  photo: { maxPixels: 1024, contentType: 'image/webp' },
  /** An e-signature: PNG, at most 1200 px on its longer side, transparency kept. */
  signature: { maxPixels: 1200, contentType: 'image/png' },
} as const satisfies Record<string, { maxPixels: number; contentType: UploadType }>;

export type UploadTransform = keyof typeof UPLOAD_TRANSFORMS;

/** The upload types a transform accepts: images only. */
export const TRANSFORMABLE_TYPES: readonly UploadType[] = ['image/jpeg', 'image/png', 'image/webp'];

// Refuse decompression bombs: an image larger than this many pixels isn't decoded.
const MAX_INPUT_PIXELS = 50_000_000;

/**
 * Re-encodes an uploaded image for `transform`: auto-rotated, metadata stripped, shrunk (never
 * enlarged) to fit the size, as WebP for a photo or PNG (alpha kept) for a signature. Throws
 * {@link ActionError} on `field` when the image can't be read.
 */
export async function transformImage(
  bytes: Uint8Array,
  transform: UploadTransform,
  field: string,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; contentType: UploadType }> {
  const spec = UPLOAD_TRANSFORMS[transform];
  try {
    const pipeline = sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, animated: false })
      .rotate()
      .resize({
        width: spec.maxPixels,
        height: spec.maxPixels,
        fit: 'inside',
        withoutEnlargement: true,
      });
    const output =
      spec.contentType === 'image/webp'
        ? await pipeline.webp({ quality: 85 }).toBuffer()
        : await pipeline.png({ compressionLevel: 9 }).toBuffer();
    return { bytes: new Uint8Array(output), contentType: spec.contentType };
  } catch {
    throw new ActionError('This image can’t be read. Upload another JPEG, PNG or WebP image.', {
      field,
    });
  }
}
