import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { GENERATED_TYPES, isGeneratedTextType, isPrintableAsciiCrLf } from './file-types';
import { saveGeneratedFile } from './stored-files';

// The generated file types (docs/ARCHITECTURE.md#file-storage; build step 2.11, decision 389 in
// docs/BUILD_PLAN.md): `saveGeneratedFile` accepts plain text (`text/plain`, `.txt`) and
// comma-separated text (`text/csv`, `.csv`) only as printable ASCII with CR LF line ends, for the
// remittance upload files. Made-up content only.

const bytes = (text: string) => new TextEncoder().encode(text);
const owner = () => ({ type: 'talent.remittanceReport', id: new Types.ObjectId() });

let storageDir: string;

beforeAll(async () => {
  storageDir = await mkdtemp(path.join(tmpdir(), 'pulse-test-storage-'));
  process.env.FILE_STORAGE_DIR = storageDir;
  await connectDb();
});

afterAll(async () => {
  await rm(storageDir, { recursive: true, force: true });
});

describe('the text check', () => {
  it('accepts printable ASCII lines, each ended with CR LF', () => {
    expect(isPrintableAsciiCrLf(bytes('00HEADER\r\n20 DETAIL, "QUOTED"\r\n'))).toBe(true);
    expect(isPrintableAsciiCrLf(bytes('\r\n'))).toBe(true);
  });

  it('refuses a bare LF or CR, a missing final CR LF, a tab, non-ASCII and empty content', () => {
    for (const text of ['A\nB\r\n', 'A\rB\r\n', 'A\r\nB', 'A\tB\r\n', 'PEÑA\r\n', '', 'A']) {
      expect(isPrintableAsciiCrLf(bytes(text))).toBe(false);
    }
    expect(isPrintableAsciiCrLf(new Uint8Array([0x41, 0x00, 0x0d, 0x0a]))).toBe(false);
  });

  it('names the two text types with their extensions', () => {
    expect(GENERATED_TYPES['text/plain'].extension).toBe('txt');
    expect(GENERATED_TYPES['text/csv'].extension).toBe('csv');
    expect(isGeneratedTextType('text/csv')).toBe(true);
    expect(isGeneratedTextType('text/html')).toBe(false);
    expect(isGeneratedTextType('application/pdf')).toBe(false);
  });
});

describe('saveGeneratedFile with text', () => {
  it('saves a .txt and a .csv file of printable ASCII with CR LF', async () => {
    const txt = await saveGeneratedFile({
      bytes: bytes('00MADE-UP\r\n99000000\r\n'),
      contentType: 'text/plain',
      fileName: 'SSS October 2026.txt',
      owner: owner(),
      actorId: null,
    });
    expect(txt).toMatchObject({ contentType: 'text/plain', originalName: 'SSS October 2026.txt' });
    const csv = await saveGeneratedFile({
      bytes: bytes('PIN,LAST NAME\r\n123,MADE-UP\r\n'),
      contentType: 'text/csv',
      fileName: 'PhilHealth October 2026.csv',
      owner: owner(),
      actorId: null,
    });
    expect(csv).toMatchObject({ contentType: 'text/csv' });
  });

  it('refuses text that isn’t printable ASCII with CR LF line ends', async () => {
    for (const text of ['A\nB\n', 'PEÑA\r\n', 'A\r\nB']) {
      await expect(
        saveGeneratedFile({
          bytes: bytes(text),
          contentType: 'text/csv',
          fileName: 'bad.csv',
          owner: owner(),
          actorId: null,
        }),
      ).rejects.toThrow('The generated content is not comma-separated text');
    }
    await expect(
      saveGeneratedFile({
        bytes: bytes('%PDF-1.4\n'),
        contentType: 'text/plain',
        fileName: 'bad.txt',
        owner: owner(),
        actorId: null,
      }),
    ).rejects.toThrow('The generated content is not plain text');
  });

  it('still refuses a PDF that isn’t one', async () => {
    await expect(
      saveGeneratedFile({
        bytes: bytes('00HEADER\r\n'),
        contentType: 'application/pdf',
        fileName: 'bad.pdf',
        owner: owner(),
        actorId: null,
      }),
    ).rejects.toThrow('The generated content is not PDF');
  });
});
