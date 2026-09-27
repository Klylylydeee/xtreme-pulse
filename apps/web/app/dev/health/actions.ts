'use server';

import { z } from 'zod';
import { defineAction, noAccessCheckYet } from '@pulse/core';
import { saveUpload } from '@pulse/core/server';

// Development-only test upload for `/dev/health` (build step 0.7). It stores a file through the
// storage service like any module will, owned by the `dev.sample` placeholder record type.

export interface TestUploadResult {
  name: string;
  url: string;
  /** The generated name on disk, shown only on this development page to prove it isn't the uploaded name. */
  storedAs: string;
  contentType: string;
  sizeBytes: number;
}

export const uploadTestFile = defineAction({
  // Development only: refuses every call in production (step 1.6 brings real access checks).
  access: noAccessCheckYet,
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
