import { AccessDeniedError } from '../../actions';
import type { CurrentUser } from './session-user';

// Spec: SECURITY.md#sign-in-and-passwords — every page and action needs a signed-in, active user,
// and a user with a temporary password may only change it. The app's `requireSignedIn()` access
// check reads the session and calls this (apps/web/lib/auth.ts). Module access is checked on top
// of it (module-access.ts).

export interface SignedInOptions {
  /** Let a user with a temporary password through. Only for the change-password page and action. */
  allowPasswordChange?: boolean;
}

/** Throws {@link AccessDeniedError} unless `user` is signed in and may go on. */
export function assertSignedIn(
  user: CurrentUser | null,
  { allowPasswordChange = false }: SignedInOptions = {},
): asserts user is CurrentUser {
  if (!user) throw new AccessDeniedError('You’re signed out. Sign in again to continue.');
  if (user.mustChangePassword && !allowPasswordChange) {
    throw new AccessDeniedError('Set a new password before you continue.');
  }
}
