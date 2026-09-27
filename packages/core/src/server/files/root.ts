import { existsSync } from 'node:fs';
import path from 'node:path';

// Spec: docs/ARCHITECTURE.md#file-storage and docs/adr/0011-file-storage-in-project-folder.md
//
// Every uploaded and generated file lives in one folder, `FILE_STORAGE_DIR` (default `./storage`).
// A relative path is read from the repo root, never from the process's working folder, so the
// Next app (run from apps/web) and the worker (run from apps/worker) use the same folder.
//
// `turbopackIgnore` keeps Next's build from tracing these runtime paths, which would otherwise
// pull the whole project (and any stored files) into the server output.

const DEFAULT_STORAGE_DIR = './storage';
const WORKSPACE_MARKER = 'pnpm-workspace.yaml';

/** Thrown when the storage folder can't be worked out or breaks the storage rules. */
export class StorageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageConfigError';
  }
}

/** The repo root: the nearest folder at or above the working folder with pnpm-workspace.yaml. */
function findRepoRoot(from: string): string | null {
  let dir = path.resolve(/*turbopackIgnore: true*/ from);
  for (;;) {
    if (existsSync(path.join(/*turbopackIgnore: true*/ dir, WORKSPACE_MARKER))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

let cached: { setting: string; cwd: string; root: string } | null = null;

/**
 * The absolute path of the storage folder. Refuses a folder that is, or is inside, a `public`
 * folder, since files must never be served directly.
 */
export function storageRoot(): string {
  const setting = process.env.FILE_STORAGE_DIR?.trim() || DEFAULT_STORAGE_DIR;
  const cwd = process.cwd();
  if (cached && cached.setting === setting && cached.cwd === cwd) return cached.root;

  let root: string;
  if (path.isAbsolute(setting)) {
    root = path.resolve(/*turbopackIgnore: true*/ setting);
  } else {
    const repoRoot = findRepoRoot(cwd);
    if (!repoRoot) {
      throw new StorageConfigError(
        'FILE_STORAGE_DIR is a relative path, but the repo root (the folder with pnpm-workspace.yaml) was not found. Set FILE_STORAGE_DIR to an absolute path.',
      );
    }
    root = path.resolve(/*turbopackIgnore: true*/ repoRoot, setting);
  }

  // Never public (docs/ARCHITECTURE.md#file-storage): no `public` folder anywhere in the path.
  if (root.split(path.sep).some((segment) => segment.toLowerCase() === 'public')) {
    throw new StorageConfigError(
      'FILE_STORAGE_DIR must not be inside a public folder. Files open only through the file route.',
    );
  }

  cached = { setting, cwd, root };
  return root;
}
