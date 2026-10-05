'use server';

import { z } from 'zod';
import { defineAction } from '@pulse/core';
import { requireSignedIn, signedInUser } from '@/lib/auth';
import { visibleHrefsFor } from '@/lib/visible-navigation';

// Spec: docs/ARCHITECTURE.md#one-application and docs/modules/core.md#administration-area — the
// sidebar and command bar list only the sections the user can open. The (pulse) layout computes
// that once, and it doesn't re-run on client navigation, so the shell asks again on every
// navigation: a change to the user's module access or role then shows without a reload. The
// session user is reloaded from the database on each call, so the answer is always current. The
// list is navigation, not access control (every page checks for itself). Read-only: not
// audit-logged.

/** The hrefs of the sections the signed-in user can open, in sidebar order. */
export const visibleNavigationAction = defineAction({
  access: requireSignedIn(),
  schema: z.object({}),
  handler: async () => visibleHrefsFor(await signedInUser()),
});
