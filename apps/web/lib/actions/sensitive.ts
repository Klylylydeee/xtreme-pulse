'use server';

import { z } from 'zod';
import { defineAction } from '@pulse/core';
import { revealSensitiveField } from '@pulse/core/server';
import { requireSignedIn, signedInUser } from '@/lib/auth';

// Spec: SECURITY.md#sensitive-data — the one Server Action behind every masked field's Reveal
// button. It needs a signed-in user; `revealSensitiveField` then refuses unregistered record types
// and fields, checks the reveal rules for this user and record, and writes the audit entry before
// it returns the value. Bind the record's identifiers in the page:
//
//   <MaskedField reveal={revealSensitiveAction.bind(null, null, { ownerType, ownerId, field })} />

export const revealSensitiveAction = defineAction({
  access: requireSignedIn(),
  schema: z.object({
    ownerType: z.string().min(1).max(100),
    ownerId: z.string().min(1).max(64),
    field: z.string().min(1).max(100),
  }),
  handler: async (input) => revealSensitiveField({ actor: await signedInUser(), ...input }),
});
