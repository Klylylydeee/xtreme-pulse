import { Inbox } from 'lucide-react';
import { EmptyState } from '@pulse/ui/components/empty-state';
import { PageHeader } from '@pulse/ui/components/page-header';
import { APP_NAME } from '@/lib/app';

/** Pulse Core home. A placeholder until Phase 1 and 2 fill it with the user's own data. */
export default function HomePage() {
  return (
    <>
      <PageHeader title="Home" description={`Welcome to ${APP_NAME}`} />
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
      <EmptyState
        icon={<Inbox strokeWidth={1.75} />}
        title="Nothing needs your attention"
        description="Approvals and reminders that need you will show here."
      />
    </>
  );
}
