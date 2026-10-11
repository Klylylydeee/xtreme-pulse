import {
  canOpenAdminArea,
  countApprovalsWaiting,
  countUsersNeedingAccessFor,
  type CurrentUser,
} from '@pulse/core/server';
import { type NavBadges, visibleHrefs } from './navigation';

/**
 * The hrefs of the sections `user` can open, for the sidebar and command bar: modules at Read or
 * higher from the effective access, and the admin pages their role opens. Server only: the
 * (pulse) layout uses it for the first render and `visibleNavigationAction` for every navigation
 * after that, so the client never decides what it sees (docs/ARCHITECTURE.md#one-application).
 */
export function visibleHrefsFor(user: CurrentUser): string[] {
  return visibleHrefs({
    moduleAccess: user.moduleAccess,
    canOpenAdminArea: (kind) => canOpenAdminArea(user, kind),
  });
}

/** A count that hides its badge (null) rather than failing the page when the read fails. */
async function countOrNull(read: () => Promise<number | null>): Promise<number | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

/**
 * The sidebar counts for `user`: User access's "need access" count, which only HR and System
 * Administrators get (null for anyone else; docs/modules/core.md#user-access-page), and from step
 * 1.9 Approvals' "waiting" count, the requests whose pending step names the user
 * (docs/modules/core.md#approvals-list). Server only, read on the first render and again on every
 * navigation, like the hrefs. A count is a convenience: a failed read hides that badge rather than
 * failing the page.
 */
export async function navBadgesFor(user: CurrentUser): Promise<NavBadges> {
  const [usersNeedingAccess, approvalsWaiting] = await Promise.all([
    countOrNull(() => countUsersNeedingAccessFor(user)),
    countOrNull(() => countApprovalsWaiting(user.id)),
  ]);
  return { usersNeedingAccess, approvalsWaiting };
}
