'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { ActionError, defineAction, publicAction, signInSchema } from '@pulse/core';
import { checkEmailDomain, needsPasswordChange } from '@pulse/core/server';
import { signIn, signInFailureCode } from '@/auth';
import { APP_NAME } from '@/lib/app';
import { changePasswordPath, safeCallbackUrl } from '@/lib/callback-url';

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

    const destination = safeCallbackUrl(callbackUrl);
    try {
      // `redirect: false` sets the session cookie and returns, so the destination can depend on
      // the account. Failures still throw (mapped below).
      await signIn('credentials', { email, password, redirect: false, redirectTo: destination });
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
    // Signed in. A temporary password goes straight to the change-password page, so the address
    // bar shows it (a redirect the proxy adds to an action's redirect isn't shown).
    redirect((await needsPasswordChange(email)) ? changePasswordPath(destination) : destination);
  },
});
