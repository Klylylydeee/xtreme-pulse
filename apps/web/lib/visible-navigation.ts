import { canOpenAdminArea, type CurrentUser } from '@pulse/core/server';
import { visibleHrefs } from './navigation';

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
