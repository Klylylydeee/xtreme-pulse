import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { storageRoot } from './root';

export interface StorageHealth {
  /** The absolute storage folder, or null when it couldn't be worked out. */
  root: string | null;
  /** A probe file was written, read back and removed. */
  writable: boolean;
  error: string | null;
}

/** Checks the storage folder for `/dev/health`: resolves it, then writes, reads and removes a probe. */
export async function checkStorage(): Promise<StorageHealth> {
  let root: string;
  try {
    root = storageRoot();
  } catch (error) {
    return {
      root: null,
      writable: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
  const probeDir = path.join(/*turbopackIgnore: true*/ root, '.tmp');
  const probe = path.join(/*turbopackIgnore: true*/ probeDir, `health-${randomUUID()}`);
  const content = randomUUID();
  try {
    await mkdir(probeDir, { recursive: true });
    await writeFile(probe, content, { flag: 'wx' });
    const writable = (await readFile(probe, 'utf8')) === content;
    return { root, writable, error: null };
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown error';
    return { root, writable: false, error: message };
  } finally {
    await unlink(probe).catch(() => undefined);
  }
}
