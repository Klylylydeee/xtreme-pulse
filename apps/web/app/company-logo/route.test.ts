import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import type { CurrentUser } from '@pulse/core/server';
import { removeCompanyLogo, saveUpload, setCompanyLogo } from '@pulse/core/server';
import { coreSeedLoaders } from '@pulse/core/server/seed';
import { GET } from './route';

// The public company logo route (SECURITY.md#exceptions-to-module-access,
// docs/TESTING.md#core-administration-tests). Made-up data only.

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const admin: CurrentUser = {
  id: new Types.ObjectId().toHexString(),
  email: 'admin.test@xtreme-works.com',
  mustChangePassword: false,
  isSystemAdministrator: true,
  isSystemAccount: false,
  employee: null,
  roles: [],
};

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

function get(query = ''): Promise<Response> {
  return GET(new Request(`http://localhost/company-logo${query}`));
}

describe('GET /company-logo', () => {
  it('answers 404 while no logo is set', async () => {
    const response = await get();
    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('serves the logo with the hardening headers, caching only the current version', async () => {
    // Another stored image: the route never serves it, whatever the query says.
    const other = await saveUpload({
      file: new File([PNG], 'other.png'),
      owner: { type: 'core.companySettings', id: null },
      actorId: null,
    });
    const view = await setCompanyLogo(admin, new File([PNG], 'logo.png'));
    const logoId = view.logoFileId ?? '';

    const current = await get(`?v=${logoId}`);
    expect(current.status).toBe(200);
    expect(current.headers.get('Content-Type')).toBe('image/png');
    expect(current.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(current.headers.get('Content-Security-Policy')).toContain('sandbox');
    expect(current.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(new Uint8Array(await current.arrayBuffer())).toEqual(PNG);

    for (const query of ['', `?v=${other.id}`, '?v=old']) {
      const response = await get(query);
      expect(response.status, query).toBe(200);
      expect(response.headers.get('Cache-Control'), query).toBe('private, no-store');
      await response.arrayBuffer();
    }
  });

  it('answers 404 again once the logo is removed', async () => {
    await removeCompanyLogo(admin);
    expect((await get()).status).toBe(404);
  });
});
