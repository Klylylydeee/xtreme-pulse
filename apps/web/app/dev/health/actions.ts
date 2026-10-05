'use server';

import { z } from 'zod';
import { defineAction } from '@pulse/core';
import { saveUpload } from '@pulse/core/server';
import { requireSignedIn } from '@/lib/auth';

// Development-only test upload for `/dev/health` (build step 0.7). It stores a file through the
// storage service like any module will, owned by the `dev.sample` placeholder record type, whose
// files open through the file route in development only (build step 1.6).

export interface TestUploadResult {
  name: string;
  url: string;
  /** The generated name on disk, shown only on this development page to prove it isn't the uploaded name. */
  storedAs: string;
  contentType: string;
  sizeBytes: number;
}

export const uploadTestFile = defineAction({
  // Signed in. `/dev/*` is never served in production (SECURITY.md#development-only-pages).
  access: requireSignedIn(),
  schema: z.object({
    file: z.instanceof(File, { message: 'Choose a file to upload.' }),
  }),
  handler: async ({ file }): Promise<TestUploadResult> => {
    const stored = await saveUpload({
      file,
      owner: { type: 'dev.sample', id: null },
      actorId: null,
    });
    return {
      name: stored.originalName,
      url: stored.url,
      storedAs: stored.storageKey,
      contentType: stored.contentType,
      sizeBytes: stored.sizeBytes,
    };
  },
});
