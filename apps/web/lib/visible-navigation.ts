import { canOpenAdminArea, countUsersNeedingAccessFor, type CurrentUser } from '@pulse/core/server';
import { type NavBadges, NO_NAV_BADGES, visibleHrefs } from './navigation';

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

/**
 * The sidebar counts for `user`: User access's "need access" count, which only HR and System
 * Administrators get (null for anyone else; docs/modules/core.md#user-access-page). Server only,
 * read on the first render and again on every navigation, like the hrefs. A count is a
 * convenience: a failed read hides the badge rather than failing the page.
 */
export async function navBadgesFor(user: CurrentUser): Promise<NavBadges> {
  try {
    return { usersNeedingAccess: await countUsersNeedingAccessFor(user) };
  } catch {
    return NO_NAV_BADGES;
  }
}
