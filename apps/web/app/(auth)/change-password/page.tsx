import type { Metadata } from 'next';
import { Button } from '@pulse/ui/components/button';
import { requireCurrentUser } from '@/lib/auth';
import { signOutAction } from '@/lib/sign-out';
import { ChangePasswordForm } from './change-password-form';

export const metadata: Metadata = { title: 'Set a new password' };

/**
 * Change password, outside the signed-in shell (SECURITY.md#sign-in-and-passwords). A user with a
 * temporary password is sent here first and can open nothing else until they set a new one.
 */
export default async function ChangePasswordPage() {
  const user = await requireCurrentUser({ allowPasswordChange: true });

  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="text-large-title md:text-display">Set a new password</h1>
        <p className="text-body text-text-secondary">
          {user.mustChangePassword
            ? 'Your password is temporary. Choose a new one to continue.'
            : `Choose a new password for ${user.email}.`}
        </p>
      </div>
      <ChangePasswordForm email={user.email} />
      <form action={signOutAction} className="flex justify-center">
        <Button type="submit" variant="plain">
          Sign out
        </Button>
      </form>
    </>
  );
}
