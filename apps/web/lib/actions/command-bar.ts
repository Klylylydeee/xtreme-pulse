'use server';

import { z } from 'zod';
import { COMMAND_QUERY_MAX_LENGTH, defineAction } from '@pulse/core';
import { registerCoreCommandProviders, searchCommands } from '@pulse/core/server';
import { requireSignedIn, signedInUser } from '@/lib/auth';

// Spec: docs/modules/core.md#command-bar and SECURITY.md#rules ("Command bar providers"),
// decisions 143–145 and 152 in docs/BUILD_PLAN.md — the command bar's search, open to every
// signed-in user (`requireSignedIn`). The registry calls only the providers whose `isVisibleTo`
// accepts the user, and each provider checks its own records again. Results are links inside the
// app only; nothing here changes data. Searches aren't audit-logged, and nothing here logs or
// caches the query or a result.
//
// Every call registers Core's providers first (`registerCoreCommandProviders`, safe to call on
// every request). Modules add their own registration beside it in their own steps.

/** One result, as the command bar shows it. */
export interface CommandSearchResult {
  id: string;
  title: string;
  subtitle: string | null;
  href: string;
  icon: 'person' | 'action';
  /** A person's profile photo (the file route, `?inline=1`), or null for the icon (step 2.2). */
  photoUrl: string | null;
}

/** One provider's results, under its heading (such as "People"), in registration order. */
export interface CommandSearchGroup {
  key: string;
  heading: string;
  results: CommandSearchResult[];
}

/**
 * The search providers' results for `query`. The registry trims the query, searches nothing under
 * 2 characters, and leaves out a provider that fails.
 */
export const commandSearchAction = defineAction({
  access: requireSignedIn(),
  schema: z.object({
    query: z.string().max(COMMAND_QUERY_MAX_LENGTH, 'Use a shorter search.'),
  }),
  handler: async ({ query }): Promise<CommandSearchGroup[]> => {
    registerCoreCommandProviders();
    const groups = await searchCommands(await signedInUser(), query);
    // Plain data, field by field: nothing a provider added beyond the result shape crosses over.
    return groups.map((group) => ({
      key: group.key,
      heading: group.group,
      results: group.results.map((result) => ({
        id: result.id,
        title: result.title,
        subtitle: result.subtitle,
        href: result.href,
        icon: result.icon,
        photoUrl: result.photoUrl,
      })),
    }));
  },
});
