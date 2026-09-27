import type { Metadata } from 'next';
import Link from 'next/link';
import { Info, Lock } from 'lucide-react';
import { buttonVariants } from '@pulse/ui/components/button';
import { LogoPlaceholder } from '@/components/logo-placeholder';
import { APP_NAME } from '@/lib/app';
import { MODULE_ENTRIES } from '@/lib/navigation';

export const metadata: Metadata = { title: 'Sign in' };

/**
 * The Pulse Core login page, the only public route. A placeholder layout: step 1.2 adds the
 * sign-in form (Auth.js Credentials) and the checks in SECURITY.md#sign-in-and-passwords.
 */
export default function LoginPage() {
  return (
    <div className="flex min-h-dvh flex-col bg-bg lg:flex-row">
      <section
        aria-label={`About ${APP_NAME}`}
        className="flex flex-col gap-8 bg-hero px-6 py-8 text-hero-text md:px-12 lg:w-1/2 lg:justify-between lg:px-16 lg:py-14"
      >
        <div className="flex items-center gap-3">
          <LogoPlaceholder className="size-10 border-hero-text-secondary text-hero-text-secondary" />
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
          <div className="flex flex-col gap-2">
            <h1 className="text-display">Sign in</h1>
            <p className="text-body text-text-secondary">Sign in with your work email.</p>
          </div>
          <div className="flex items-start gap-3 rounded-card bg-bg-grouped px-4 py-3.5">
            <Info aria-hidden="true" className="mt-0.5 size-4.5 shrink-0 text-accent" />
            <p className="text-footnote text-text-secondary">
              Sign-in isn’t set up yet. Until it is, every page opens without signing in.
            </p>
          </div>
          <Link href="/" className={buttonVariants({ className: 'h-12 w-full text-body' })}>
            Continue to Home
          </Link>
        </div>
        <footer className="flex items-center gap-2 pb-8 text-footnote text-text-secondary">
          <Lock aria-hidden="true" className="size-4 shrink-0" />
          <span>For internal use. Available on the office network or VPN.</span>
        </footer>
      </main>
    </div>
  );
}
