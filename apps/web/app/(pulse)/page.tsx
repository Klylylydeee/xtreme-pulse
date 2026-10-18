import { Suspense } from 'react';
import { KeyRound } from 'lucide-react';
import { hasAnyModuleAccess, now } from '@pulse/core';
import { IconTile } from '@pulse/ui/components/icon-tile';
import { PageHeader } from '@pulse/ui/components/page-header';
import { CompanyDetailsReminder } from '@/components/company-details-reminder';
import { APP_NAME } from '@/lib/app';
import { requireCurrentUser } from '@/lib/auth';
import { formatHeroDate, homeGreeting } from '@/lib/home';
import {
  APPROVALS_TILE,
  ApprovalsWaitingTile,
  HOLIDAYS_TILE,
  HomeTileSkeleton,
  NOTIFICATIONS_TILE,
  OnboardingCard,
  TEAM_TILE,
  UnreadNotificationsTile,
  UpcomingHolidaysTile,
  YourTeamTile,
} from './home-tiles';

/**
 * The new user's home card (docs/modules/core.md#user-access-page): shown under the hero while the
 * user's effective access is None on every module.
 */
function AccessSetupCard() {
  return (
    <section
      aria-labelledby="home-access-title"
      className="flex items-start gap-4 rounded-card bg-surface p-4 shadow-card md:p-5"
    >
      <IconTile className="size-11 rounded-xl [&_svg]:size-5">
        <KeyRound strokeWidth={1.75} />
      </IconTile>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h2 id="home-access-title" className="text-headline">
          Your access is being set up
        </h2>
        <p className="text-subheadline text-text-secondary">
          HR will give you access to the modules you need.
        </p>
      </div>
    </section>
  );
}

/**
 * Pulse Core home (docs/modules/core.md#home), open to every signed-in user and showing only their
 * own data. The hero greets the user by the Manila time of day with the Manila date (no name for
 * the bootstrap system account); the access card of step 1.6 stays under it; then the tiles, each
 * streaming in behind its own Suspense with its own skeleton, zero state and error state. HR and
 * the System Administrator also see the company details reminder while any detail is a
 * placeholder. From step 2.6 a user with an employee also sees "Finish setting up your profile"
 * under the hero, above the access card, while any of their own onboarding items is To do
 * (docs/modules/talent.md#onboarding-checklist-and-change-requests-build-step-26).
 */
export default async function HomePage() {
  const user = await requireCurrentUser();
  const waitingForAccess = !hasAnyModuleAccess(user.moduleAccess);
  const showTeam = !user.isSystemAccount && user.employee !== null;
  const at = now();
  return (
    <>
      <PageHeader title="Home" description={`Welcome to ${APP_NAME}`} />
      <Suspense fallback={null}>
        <CompanyDetailsReminder />
      </Suspense>
      <section
        aria-labelledby="home-hero-title"
        className="flex flex-col gap-2 rounded-3xl bg-hero px-6 py-8 text-hero-text shadow-accent md:px-8 md:py-10"
      >
        <h2 id="home-hero-title" className="text-title-1 md:text-large-title">
          {homeGreeting(at, user.isSystemAccount ? null : user.employee?.firstName)}
        </h2>
        <p className="text-callout text-hero-text-secondary">{formatHeroDate(at)}</p>
      </section>
      {showTeam ? (
        <Suspense fallback={null}>
          <OnboardingCard user={user} />
        </Suspense>
      ) : null}
      {waitingForAccess ? <AccessSetupCard /> : null}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        <Suspense fallback={<HomeTileSkeleton info={APPROVALS_TILE} />}>
          <ApprovalsWaitingTile user={user} />
        </Suspense>
        <Suspense fallback={<HomeTileSkeleton info={NOTIFICATIONS_TILE} />}>
          <UnreadNotificationsTile user={user} />
        </Suspense>
        <Suspense fallback={<HomeTileSkeleton info={HOLIDAYS_TILE} />}>
          <UpcomingHolidaysTile />
        </Suspense>
        {showTeam ? (
          <Suspense fallback={<HomeTileSkeleton info={TEAM_TILE} />}>
            <YourTeamTile user={user} />
          </Suspense>
        ) : null}
      </div>
    </>
  );
}
