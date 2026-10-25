// File types the storage service can recognise from the file's own bytes. An upload's type comes
// from its content, never from the name or the type the browser sent, so a renamed script can't be
// stored as a "PDF". A type can be allowed in the upload setting only if it can be recognised here.

export const UPLOAD_TYPES = {
  'application/pdf': { extension: 'pdf', label: 'PDF' },
  'image/jpeg': { extension: 'jpg', label: 'JPEG image' },
  'image/png': { extension: 'png', label: 'PNG image' },
  'image/webp': { extension: 'webp', label: 'WebP image' },
} as const;

export type UploadType = keyof typeof UPLOAD_TYPES;

export const UPLOAD_TYPE_NAMES = Object.keys(UPLOAD_TYPES) as [UploadType, ...UploadType[]];

/**
 * Generated plain text files (build step 2.11, decision 389): the remittance upload files, as
 * printable ASCII with CR LF line ends only.
 */
export const GENERATED_TEXT_TYPES = {
  'text/plain': { extension: 'txt', label: 'plain text (printable ASCII with CR LF line ends)' },
  'text/csv': {
    extension: 'csv',
    label: 'comma-separated text (printable ASCII with CR LF line ends)',
  },
} as const;

export type GeneratedTextType = keyof typeof GENERATED_TEXT_TYPES;

/** Types the app generates itself (reports, payslips, exports). Never accepted as uploads. */
export const GENERATED_TYPES = {
  ...UPLOAD_TYPES,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
    extension: 'xlsx',
    label: 'Excel workbook',
  },
  ...GENERATED_TEXT_TYPES,
} as const;

export type GeneratedType = keyof typeof GENERATED_TYPES;

/** True for a generated text type (`text/plain`, `text/csv`). */
export function isGeneratedTextType(type: string): type is GeneratedTextType {
  return Object.hasOwn(GENERATED_TEXT_TYPES, type);
}

/**
 * True when `bytes` is non-empty printable ASCII (0x20 to 0x7E) in lines that each end with
 * CR LF: no tab, no bare CR or LF, no other control or non-ASCII byte, and a final CR LF.
 */
export function isPrintableAsciiCrLf(bytes: Uint8Array): boolean {
  if (bytes.length < 2) return false;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] as number;
    if (byte === 0x0d) {
      if (bytes[index + 1] !== 0x0a) return false;
      index += 1;
      continue;
    }
    if (byte < 0x20 || byte > 0x7e) return false;
  }
  return bytes[bytes.length - 2] === 0x0d && bytes[bytes.length - 1] === 0x0a;
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

const ASCII = (text: string) => [...text].map((char) => char.charCodeAt(0));

/** The type of `bytes` from its leading signature, or null when it isn't one we recognise. */
export function detectUploadType(bytes: Uint8Array): UploadType | null {
  if (startsWith(bytes, ASCII('%PDF-'))) return 'application/pdf';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, ASCII('RIFF')) && startsWith(bytes, ASCII('WEBP'), 8)) return 'image/webp';
  return null;
}

/** True when `bytes` starts like an OOXML (zip) file, for checking generated workbooks. */
export function looksLikeZip(bytes: Uint8Array): boolean {
  return startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]);
}
