import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectDb } from '@pulse/db';
import { ActionError } from '../../actions';
import { coreSeedLoaders } from '../seed/loaders';
import { storageRoot } from './root';
import { saveUpload, type StoredFile } from './stored-files';

// The `transform` option of `saveUpload` (build step 2.2, decision 174 in docs/BUILD_PLAN.md,
// docs/ARCHITECTURE.md#file-storage): photos and signatures are re-encoded with sharp,
// auto-rotated and stripped of metadata. Made-up images only.

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

/** A JPEG from a "camera": EXIF with a copyright and GPS position, turned by its orientation. */
async function cameraJpeg(width = 2400, height = 1200): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 30, b: 30 } } })
    .withExif({
      IFD0: { Copyright: 'Made-up camera' },
      IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '14/1 35/1 0/1' },
    })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
}

async function storedBytes(file: StoredFile): Promise<Buffer> {
  return readFile(path.join(storageRoot(), ...file.storageKey.split('/')));
}

function upload(bytes: Uint8Array, name: string, transform?: 'photo' | 'signature') {
  return saveUpload({
    file: new File([new Uint8Array(bytes)], name),
    owner: { type: 'test.images', id: null },
    actorId: null,
    field: 'image',
    transform,
  });
}

describe('saveUpload with transform', () => {
  it('stores a photo as WebP of at most 1024 px, rotated, with no EXIF or GPS', async () => {
    const input = await cameraJpeg();
    expect((await sharp(input).metadata()).exif).toBeDefined();

    const file = await upload(input, 'holiday.jpg', 'photo');
    expect(file.contentType).toBe('image/webp');
    expect(file.originalName).toBe('holiday.webp');
    const bytes = await storedBytes(file);
    expect(file.sizeBytes).toBe(bytes.byteLength);
    const meta = await sharp(bytes).metadata();
    expect(meta).toMatchObject({ format: 'webp', width: 512, height: 1024 });
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    expect(bytes.toString('latin1')).not.toContain('Made-up camera');
  });

  it('stores a signature as PNG of at most 1200 px, keeping transparency', async () => {
    const input = await sharp({
      create: { width: 2400, height: 600, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
    const file = await upload(input, 'signature.png', 'signature');
    expect(file.contentType).toBe('image/png');
    const meta = await sharp(await storedBytes(file)).metadata();
    expect(meta).toMatchObject({ format: 'png', width: 1200, height: 300, hasAlpha: true });
    expect(meta.exif).toBeUndefined();
  });

  it('never enlarges a small image', async () => {
    const input = await sharp({
      create: { width: 300, height: 200, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer();
    const file = await upload(input, 'small.png', 'photo');
    expect(await sharp(await storedBytes(file)).metadata()).toMatchObject({
      width: 300,
      height: 200,
    });
  });

  it('refuses a PDF and an unreadable image, on the field', async () => {
    const pdf = new TextEncoder().encode('%PDF-1.7 made-up');
    await expect(upload(pdf, 'photo.pdf', 'photo')).rejects.toMatchObject({
      message: 'Upload a JPG, PNG or WEBP file.',
      field: 'image',
    });
    const broken = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6]);
    const refusal = await upload(broken, 'broken.jpg', 'photo').catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ActionError);
    expect(refusal).toMatchObject({ field: 'image' });
  });

  it('stores other uploads byte for byte', async () => {
    const input = await cameraJpeg(64, 32);
    const file = await upload(input, 'scan.jpg');
    expect(file.contentType).toBe('image/jpeg');
    expect(Buffer.compare(await storedBytes(file), input)).toBe(0);
  });
});

// The `transformImages` option and the `receipt` transform (build step 2.5, decision 247 in
// docs/BUILD_PLAN.md): a receipt image is re-encoded, a receipt PDF is stored byte for byte.
function uploadReceipt(
  bytes: Uint8Array,
  name: string,
  accept?: readonly ('application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp')[],
) {
  return saveUpload({
    file: new File([new Uint8Array(bytes)], name),
    owner: { type: 'test.receipts', id: null },
    actorId: null,
    field: 'receipt',
    transformImages: 'receipt',
    accept,
  });
}

describe('saveUpload with transformImages: receipt', () => {
  it('stores a receipt image as WebP of at most 2000 px, rotated, with no EXIF or GPS', async () => {
    const input = await cameraJpeg(4000, 3000);
    const file = await uploadReceipt(input, 'lunch receipt.jpg');
    expect(file.contentType).toBe('image/webp');
    expect(file.originalName).toBe('lunch receipt.webp');
    const bytes = await storedBytes(file);
    expect(file.sizeBytes).toBe(bytes.byteLength);
    const meta = await sharp(bytes).metadata();
    // Orientation 6 turns the 4000 × 3000 image upright to 3000 × 4000, then shrinks it to fit.
    expect(meta).toMatchObject({ format: 'webp', width: 1500, height: 2000 });
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    const text = bytes.toString('latin1');
    expect(text).not.toContain('Made-up camera');
    expect(text).not.toContain('GPS');
  });

  it('never enlarges a small receipt image', async () => {
    const input = await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 250, g: 250, b: 250 } },
    })
      .png()
      .toBuffer();
    const file = await uploadReceipt(input, 'small.png');
    expect(file.contentType).toBe('image/webp');
    expect(await sharp(await storedBytes(file)).metadata()).toMatchObject({
      format: 'webp',
      width: 800,
      height: 600,
    });
  });

  it('stores a PDF receipt byte for byte', async () => {
    const pdf = new TextEncoder().encode('%PDF-1.7\n% made-up receipt\n%%EOF\n');
    const file = await uploadReceipt(pdf, 'receipt.pdf');
    expect(file.contentType).toBe('application/pdf');
    expect(file.originalName).toBe('receipt.pdf');
    expect(file.sizeBytes).toBe(pdf.byteLength);
    expect(Buffer.compare(await storedBytes(file), Buffer.from(pdf))).toBe(0);
  });

  it('refuses a type that is not allowed, on the field', async () => {
    const text = new TextEncoder().encode('not a receipt');
    await expect(uploadReceipt(text, 'receipt.txt')).rejects.toMatchObject({
      message: 'Upload a PDF, JPG, PNG or WEBP file.',
      field: 'receipt',
    });
    // `accept` still narrows the upload settings' types.
    const pdf = new TextEncoder().encode('%PDF-1.7 made-up');
    await expect(uploadReceipt(pdf, 'receipt.pdf', ['image/jpeg'])).rejects.toMatchObject({
      message: 'Upload a JPG file.',
      field: 'receipt',
    });
  });

  it('refuses an unreadable image, on the field', async () => {
    const broken = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6]);
    const refusal = await uploadReceipt(broken, 'broken.jpg').catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ActionError);
    expect(refusal).toMatchObject({ field: 'receipt' });
  });

  it('refuses transform and transformImages together', async () => {
    const pdf = new TextEncoder().encode('%PDF-1.7 made-up');
    await expect(
      saveUpload({
        file: new File([pdf], 'receipt.pdf'),
        owner: { type: 'test.receipts', id: null },
        actorId: null,
        transform: 'photo',
        transformImages: 'receipt',
      }),
    ).rejects.toThrow('not both');
  });
});
