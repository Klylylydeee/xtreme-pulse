import Link from 'next/link';
import { TriangleAlert } from 'lucide-react';
import {
  canManageOrgStructure,
  type CompanyDetailsStatus,
  getCompanyDetailsStatus,
  isSystemAdministrator,
} from '@pulse/core/server';
import { Button } from '@pulse/ui/components/button';
import { getCurrentUser } from '@/lib/auth';

/**
 * The company details reminder (docs/modules/core.md#company-settings-page): while any company
 * detail is still a placeholder (the logo included), Home and `/admin` show HR and the System
 * Administrator which ones are missing. Nobody else sees it, checked here on the server; it
 * renders nothing once every detail is filled in. The System Administrator gets a link to the
 * settings page; HR is asked to pass it on.
 */
export async function CompanyDetailsReminder() {
  const user = await getCurrentUser();
  if (!user || !canManageOrgStructure(user)) return null;

  let status: CompanyDetailsStatus;
  try {
    status = await getCompanyDetailsStatus();
  } catch {
    // A reminder, not the page's content: if it can't be read, the page still opens without it.
    return null;
  }
  if (status.complete) return null;

  const admin = isSystemAdministrator(user);
  return (
    <section
      aria-labelledby="company-details-reminder-title"
      className="flex flex-col gap-4 rounded-card bg-surface p-4 shadow-card md:flex-row md:items-start md:gap-4 md:p-5"
    >
      <TriangleAlert
        aria-hidden="true"
        strokeWidth={1.75}
        className="size-6 shrink-0 text-warning-text"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="company-details-reminder-title" className="text-headline">
            Company details are still placeholders
          </h2>
          <p className="text-subheadline text-text-secondary">
            Payslips, HR documents and reports print these details.{' '}
            {admin
              ? 'Fill them in once the company has them.'
              : 'Ask the System Administrator to fill them in.'}
          </p>
        </div>
        <ul aria-label="Missing company details" className="flex flex-wrap gap-2">
          {status.pending.map((detail) => (
            <li
              key={detail.path}
              className="flex items-center gap-1.5 rounded-full bg-bg-grouped px-3 py-1 text-footnote text-text-secondary"
            >
              <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-warning" />
              {detail.label}
            </li>
          ))}
        </ul>
      </div>
      {admin ? (
        <Button asChild variant="tinted" className="w-full md:w-auto">
          <Link href="/admin/settings">Fill in company details</Link>
        </Button>
      ) : null}
    </section>
  );
}
