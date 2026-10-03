'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { changePasswordSchema, defineAction } from '@pulse/core';
import { assertSignedIn, changePassword } from '@pulse/core/server';
import { getCurrentUser, requireSignedIn } from '@/lib/auth';
import { safeCallbackUrl } from '@/lib/callback-url';

// Spec: SECURITY.md#sign-in-and-passwords — users change their own password, with the current
// one. Open to a user with a temporary password, which is what this page is for.

export const changePasswordAction = defineAction({
  access: requireSignedIn({ allowPasswordChange: true }),
  // Plus where the user was going when sent here, made safe before use.
  schema: changePasswordSchema.and(z.object({ callbackUrl: z.string().optional() })),
  handler: async (input): Promise<void> => {
    const user = await getCurrentUser();
    assertSignedIn(user, { allowPasswordChange: true });
    await changePassword(user.id, input);
    redirect(safeCallbackUrl(input.callbackUrl));
  },
});
