'use server';

import { z } from 'zod';
import { defineAction, noAccessCheckYet } from '@pulse/core';
import { revealDevEncryptionSample } from '@pulse/core/server';

// Development-only reveal for the masked field sample on `/dev/ui` (build step 0.8). It goes
// through `revealSensitive` like any sensitive field will.

export const revealSampleValue = defineAction({
  // Development only: refuses every call in production (step 1.6 brings real access checks, and
  // Phase 1 the audit log entry for each reveal).
  access: noAccessCheckYet,
  schema: z.object({}),
  handler: () => revealDevEncryptionSample(),
});
