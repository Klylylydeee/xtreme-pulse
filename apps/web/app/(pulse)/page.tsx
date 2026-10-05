import { Suspense } from 'react';
import { Inbox, KeyRound } from 'lucide-react';
import { hasAnyModuleAccess } from '@pulse/core';
import { EmptyState } from '@pulse/ui/components/empty-state';
import { IconTile } from '@pulse/ui/components/icon-tile';
import { PageHeader } from '@pulse/ui/components/page-header';
import { CompanyDetailsReminder } from '@/components/company-details-reminder';
import { APP_NAME } from '@/lib/app';
import { requireCurrentUser } from '@/lib/auth';

/**
 * The new user's home card (docs/modules/core.md#user-access-page): shown while the user's
 * effective access is None on every module, in place of "Nothing needs your attention".
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
 * Pulse Core home, open to every signed-in user (self-service needs no module access). A
 * placeholder until Phase 1 and 2 fill it with the user's own data. HR and the System
 * Administrator also see the company details reminder while any detail is a placeholder; it reads
 * the database, so it streams in behind its own Suspense.
 */
export default async function HomePage() {
  const user = await requireCurrentUser();
  const waitingForAccess = !hasAnyModuleAccess(user.moduleAccess);
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
        <h2 id="home-hero-title" className="text-title-1">
          Your workday in one place
        </h2>
        <p className="max-w-2xl text-callout text-hero-text-secondary">
          Your timesheet, leave, offset balance and latest payslip will show here.
        </p>
      </section>
      {waitingForAccess ? (
        <AccessSetupCard />
      ) : (
        <EmptyState
          icon={<Inbox strokeWidth={1.75} />}
          title="Nothing needs your attention"
          description="Approvals and reminders that need you will show here."
        />
      )}
    </>
  );
}
