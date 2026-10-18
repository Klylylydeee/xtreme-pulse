'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { changePasswordSchema, defineAction } from '@pulse/core';
import { assertSignedIn, changePassword, type CurrentUser } from '@pulse/core/server';
import { getOwnOnboardingReminder } from '@pulse/talent/server';
import { getCurrentUser, requireSignedIn } from '@/lib/auth';
import { afterPasswordChangePath } from '@/lib/onboarding';

// Spec: SECURITY.md#sign-in-and-passwords — users change their own password, with the current
// one. Open to a user with a temporary password, which is what this page is for.
//
// Step 2.6 (docs/modules/talent.md#onboarding-checklist-and-change-requests-build-step-26,
// decision 261): after replacing a temporary password, a user with an employee whose own
// onboarding items aren't all done is guided once to `/talent/onboarding` instead of Home, unless
// they were on their way to another page. Nothing else is in the way.

/** Whether any of the user's own onboarding items is To do; false when it can't be read. */
async function onboardingPending(user: CurrentUser): Promise<boolean> {
  if (!user.employee) return false;
  try {
    return (await getOwnOnboardingReminder(user))?.showReminder === true;
  } catch {
    // The checklist is a guide, never a gate: on a failed read the user simply goes Home.
    return false;
  }
}

export const changePasswordAction = defineAction({
  access: requireSignedIn({ allowPasswordChange: true }),
  // Plus where the user was going when sent here, made safe before use.
  schema: changePasswordSchema.and(z.object({ callbackUrl: z.string().optional() })),
  handler: async (input): Promise<void> => {
    const user = await getCurrentUser();
    assertSignedIn(user, { allowPasswordChange: true });
    const hadTemporaryPassword = user.mustChangePassword;
    await changePassword(user.id, input);
    redirect(
      afterPasswordChangePath({
        callbackUrl: input.callbackUrl,
        hadTemporaryPassword,
        onboardingPending: hadTemporaryPassword ? await onboardingPending(user) : false,
      }),
    );
  },
});
