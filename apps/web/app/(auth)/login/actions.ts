'use server';

import { z } from 'zod';
import { ActionError, defineAction, publicAction, signInSchema } from '@pulse/core';
import { checkEmailDomain } from '@pulse/core/server';
import { signIn, signInFailureCode } from '@/auth';
import { APP_NAME } from '@/lib/app';
import { safeCallbackUrl } from '@/lib/callback-url';

// Spec: SECURITY.md#sign-in-and-passwords — signing in. The only action open without signing in.
// Nothing here logs, and the result never carries the password back to the form.

function wrongDomain(domain: string | null): ActionError {
  return new ActionError(
    `Use your work email. ${domain ?? 'That domain'} can’t sign in to ${APP_NAME}.`,
    { field: 'email' },
  );
}

export const signInAction = defineAction({
  access: publicAction,
  schema: signInSchema.extend({ callbackUrl: z.string().optional() }),
  handler: async ({ email, password, callbackUrl }): Promise<void> => {
    // Checked first so the form can say what's wrong with the email itself. Domains are not
    // secret, so this tells a stranger nothing about which accounts exist.
    const domain = await checkEmailDomain(email);
    if (!domain.allowed) throw wrongDomain(domain.domain);

    try {
      // Redirects on success (a NEXT_REDIRECT error, re-thrown below).
      await signIn('credentials', { email, password, redirectTo: safeCallbackUrl(callbackUrl) });
    } catch (error) {
      switch (signInFailureCode(error)) {
        case 'bad-domain':
          throw wrongDomain(domain.domain);
        case 'inactive':
          throw new ActionError('This account is no longer active. Contact HR.');
        case 'invalid':
          throw new ActionError('The email or password isn’t right.');
        default:
          throw error;
      }
    }
  },
});
