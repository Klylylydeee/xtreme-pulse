import { cache } from 'react';
import { forbidden, redirect } from 'next/navigation';
import {
  AccessDeniedError,
  type AccessCheck,
  type ModuleKey,
  type RequiredLevel,
} from '@pulse/core';
import {
  type AdminAreaKind,
  assertModuleAccess,
  assertSignedIn,
  canOpenAdminArea,
  type CurrentUser,
  hasModuleAccess,
  loadSessionUser,
  type SignedInOptions,
} from '@pulse/core/server';
import { auth } from '@/auth';

// Spec: SECURITY.md#account--access — the signed-in user for pages, layouts and Server Actions.
// The proxy (proxy.ts) checks every request first; these checks repeat it where the data is read,
// so a page never depends on the proxy alone.
//
// Spec: SECURITY.md#resolving-and-enforcing-build-step-16 — module access and the admin area role
// are checked by every page, Server Action and Route Handler for itself, through one shared check
// in @pulse/core with a page form (forbidden(), HTTP 403 with (pulse)/forbidden.tsx) and an action
// form (an AccessCheck that throws AccessDeniedError). A page calls its guard first, before
// anything that can suspend, and never from a layout (docs/CODE_STYLE.md#pages-server-actions-and-route-handlers).

/**
 * The signed-in user, reloaded from the database (once per request): null when signed out, when
 * the account is deactivated, or when the session is older than SESSION_MAX_AGE_HOURS.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const session = await auth();
  const userId = session?.user?.id;
  const signedInAt = session?.signedInAt;
  if (typeof userId !== 'string' || typeof signedInAt !== 'number') return null;
  return loadSessionUser(userId, signedInAt);
});

/**
 * The signed-in user for a page or layout. Redirects to the login page when signed out, and to the
 * change-password page while the password is temporary (unless `allowPasswordChange`).
 */
export async function requireCurrentUser(options: SignedInOptions = {}): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.mustChangePassword && !options.allowPasswordChange) redirect('/change-password');
  return user;
}

/**
 * The access check for a Server Action that needs only a signed-in user (`defineAction({ access })`):
 * Pulse Core's own actions, which have no module level. A module's actions use
 * {@link requireModuleAccess}.
 */
export function requireSignedIn(options: SignedInOptions = {}): AccessCheck {
  return async () => {
    assertSignedIn(await getCurrentUser(), options);
  };
}

/**
 * The signed-in user inside a Server Action's handler, after its access check (the user is loaded
 * once per request, so this costs nothing more). Throws AccessDeniedError, which `defineAction`
 * turns into a form error, when there is none.
 */
export async function signedInUser(options: SignedInOptions = {}): Promise<CurrentUser> {
  const user = await getCurrentUser();
  assertSignedIn(user, options);
  return user;
}

/**
 * The signed-in user for a module page that needs at least `level` on `module`. Signed-out users
 * go to the login page (and a temporary password to the change-password page) first; anyone
 * without the level gets `forbidden()`: HTTP 403 with the no-access state from
 * `(pulse)/forbidden.tsx`. Call it first in the page, before anything that can suspend.
 */
export async function requireModulePage<M extends ModuleKey>(
  module: M,
  level: RequiredLevel<M>,
): Promise<CurrentUser> {
  const user = await requireCurrentUser();
  if (!hasModuleAccess(user, module, level)) forbidden();
  return user;
}

/**
 * The access check for a module's Server Action (`defineAction({ access })`) that needs at least
 * `level` on `module`. It refuses with AccessDeniedError, which `defineAction` returns as the form
 * error. A Route Handler can call it too and answer 403 when it throws AccessDeniedError.
 */
export function requireModuleAccess<M extends ModuleKey>(
  module: M,
  level: RequiredLevel<M>,
  message?: string,
): AccessCheck {
  return async () => {
    const user = await getCurrentUser();
    assertSignedIn(user);
    assertModuleAccess(user, module, level, message);
  };
}

/**
 * The signed-in user for a Pulse Core admin page, checked by role, not module access (decision 54):
 * `hrOrSystemAdministrator` for `/admin`, `/admin/users`, `/admin/access`, `/admin/departments`
 * and `/admin/positions`; `systemAdministrator` for `/admin/settings` and `/admin/audit`. Anyone else
 * gets `forbidden()` (HTTP 403, the no-access state); signed-out users go to the login page first.
 */
export async function requireAdminPage(kind: AdminAreaKind): Promise<CurrentUser> {
  const user = await requireCurrentUser();
  if (!canOpenAdminArea(user, kind)) forbidden();
  return user;
}

/**
 * The access check for a Server Action in the admin area, checked by role like
 * {@link requireAdminPage}. The service checks the role again itself.
 */
export function adminOnly(kind: AdminAreaKind, message?: string): AccessCheck {
  return async () => {
    const user = await getCurrentUser();
    assertSignedIn(user);
    if (!canOpenAdminArea(user, kind)) throw new AccessDeniedError(message);
  };
}
