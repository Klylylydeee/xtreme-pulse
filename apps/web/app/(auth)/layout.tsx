import type { ReactNode } from 'react';
import { Lock } from 'lucide-react';
import { CompanyLogo } from '@/components/company-logo';
import { APP_NAME } from '@/lib/app';
import { getCompanyLogoUrl } from '@/lib/company-logo';
import { MODULE_ENTRIES } from '@/lib/navigation';

/**
 * The hero layout outside the signed-in shell: the solid cobalt hero beside a panel holding the
 * page (DESIGN_SYSTEM.md › Bolder identity). Used by the login and change-password pages.
 */
export default async function AuthLayout({ children }: { children: ReactNode }) {
  // The page is public: read only the logo's URL, never the other company details.
  const logoUrl = await getCompanyLogoUrl();
  return (
    <div className="flex min-h-dvh flex-col bg-bg lg:flex-row">
      <section
        aria-label={`About ${APP_NAME}`}
        className="flex flex-col gap-8 bg-hero px-6 py-8 text-hero-text md:px-12 lg:w-1/2 lg:justify-between lg:px-16 lg:py-14"
      >
        <div className="flex items-center gap-3">
          <CompanyLogo
            logoUrl={logoUrl}
            className="size-10"
            placeholderClassName="border-hero-text-secondary text-hero-text-secondary"
          />
          <span className="text-title-2">{APP_NAME}</span>
        </div>
        <div className="flex max-w-xl flex-col gap-4">
          <p className="text-large-title lg:text-display">
            Your people, projects and pay in one place.
          </p>
          <p className="text-body text-hero-text-secondary">
            Timesheets, leave, payroll and project delivery, from the first lead to the renewal.
          </p>
        </div>
        <p className="hidden text-footnote text-hero-text-secondary lg:block">
          {['Core', ...MODULE_ENTRIES.map((entry) => entry.label)].join(' · ')}
        </p>
      </section>

      <main className="flex flex-1 flex-col items-center px-4">
        <div className="flex w-full max-w-sm flex-1 flex-col justify-center gap-8 py-12">
          {children}
        </div>
        <footer className="flex items-center gap-2 pb-8 text-footnote text-text-secondary">
          <Lock aria-hidden="true" className="size-4 shrink-0" />
          <span>For internal use. Available on the office network or VPN.</span>
        </footer>
      </main>
    </div>
  );
}
