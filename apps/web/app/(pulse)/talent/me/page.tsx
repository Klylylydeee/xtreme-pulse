import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { ChevronRight, ListChecks, UserRound } from 'lucide-react';
import { ActionError } from '@pulse/core';
import { type CurrentUser, listBrandOptions } from '@pulse/core/server';
import { EMPLOYEE_UPLOAD_DOCUMENT_TYPES, type WorkScheduleSectionView } from '@pulse/talent';
import {
  getOwnChangeRequestStates,
  getOwnOnboardingReminder,
  getOwnRecordView,
  getWorkScheduleSection,
  listOwnChangeRequests,
  listOwnESignatures,
  listOwnPayslips,
} from '@pulse/talent/server';
import { Avatar } from '@pulse/ui/components/avatar';
import { EmptyState } from '@pulse/ui/components/empty-state';
import { IconTile } from '@pulse/ui/components/icon-tile';
import { PageHeader } from '@pulse/ui/components/page-header';
import { Skeleton } from '@pulse/ui/components/skeleton';
import { Badge } from '@/components/org-structure';
import { requireCurrentUser } from '@/lib/auth';
import { ONBOARDING_HREF } from '@/lib/navigation';
import { onboardingDoneText } from '@/lib/onboarding';
import { getUploadHints } from '@/lib/upload-hints';
import { WorkScheduleSection } from '../employee-record-sections';
import { OwnPayslips } from './own-payslips';
import { OwnPhotoAndSignature } from './own-photo-signature';
import { OwnRecord } from './own-record';

export const metadata: Metadata = { title: 'My record' };

const DESCRIPTION =
  'Your employee record. Fill in what’s empty and it’s saved; changes to filled-in details go for approval. Each time you reveal a hidden value or open a document, it’s recorded.';

// Spec: docs/modules/talent.md#the-employee-record-build-step-21 (decision 170) and
// SECURITY.md#exceptions-to-module-access — the employee's own record, self-service outside
// module access: every signed-in user, no Pulse Talent access needed. It takes no employee id from
// the request: `getOwnRecordView` loads the signed-in user's own employee only. Read-only in step
// 2.1, with Reveal on the employee's own sensitive values (each reveal is audit-logged by the
// reveal action). The bootstrap system account, which has no employee, gets an empty state. The
// guard comes first, before anything that can suspend; loading errors go to the (pulse) error
// boundary. Nothing here is logged or cached.
//
// From step 2.2 (decisions 173, 175 and 188) the page adds the employee's own photo (Change,
// Remove) and e-signature (a preview, Upload or Replace, and the version history with how often
// each version was applied), through self-service actions that act on the signed-in user's own
// employee only; and the 201 file, skills and certifications, read-only. Opening a 201 document
// goes through the file route, which records every open in the audit log.
//
// From step 2.3 (docs/modules/talent.md#payroll-settings-and-allowances-build-step-23) the
// Compensation section also lists the employee's own allowances, read-only: the automatic ones
// with the company default, assigned amounts masked with Reveal (audit-logged by the reveal
// action). `getOwnRecordView` includes them only when the employee may reveal their own
// `allowances`; there is no "Assign allowance" here.
//
// From step 2.4 (docs/modules/talent.md#work-schedules-and-daily-time-entries-build-step-24) the
// Work schedule section, read-only: the schedule in effect, the scheduled changes and the
// history, for the signed-in user's own employee (the id comes from their own record, never the
// request). When no company schedule is set yet, the section is left out instead of the page.
//
// From step 2.6 (docs/modules/talent.md#onboarding-checklist-and-change-requests-build-step-26,
// decisions 266–268 and 275) the employee edits their own Personal, Government IDs, Payroll bank
// account and Skills sections (empty fields saved straight away, changes to filled-in ones sent as
// change requests), uploads their own 201 documents and adds certifications, and sees their own
// Change requests list. A link to the onboarding checklist shows while any own item is To do.
// Every one of these reads and writes the signed-in user's own employee only.
//
// From step 2.10 (docs/modules/talent.md#payroll-review-approval-and-payslips-build-step-210) the
// Payslips section (`#payslips`, where the `talent.payslipReady` notification links): the
// employee's own payslips of finalized runs, newest first, with net pay masked behind Reveal and
// "Open payslip". `listOwnPayslips` reads the signed-in user's own employee only. It sits above
// the record's sections, since it's what an employee opens this page for most often.
export default async function MyRecordPage() {
  const user = await requireCurrentUser();
  return (
    <>
      <PageHeader title="My record" description={DESCRIPTION} />
      <Suspense fallback={<MyRecordLoading />}>
        <MyRecord user={user} />
      </Suspense>
    </>
  );
}

async function MyRecord({ user }: { user: CurrentUser }) {
  const [view, versions, uploads, states, changeRequests, brands, reminder, payslips] =
    await Promise.all([
      getOwnRecordView(user),
      listOwnESignatures(user),
      getUploadHints(),
      getOwnChangeRequestStates(user),
      listOwnChangeRequests(user),
      listBrandOptions(),
      getOwnOnboardingReminder(user),
      listOwnPayslips(user),
    ]);
  if (!view || !states) {
    return (
      <EmptyState
        icon={<UserRound strokeWidth={1.75} />}
        title="No employee record"
        description="This account isn’t linked to an employee, so there’s no record to show."
      />
    );
  }
  const { identity } = view;
  const workSchedule = await ownWorkSchedule(user, view.employeeId);
  return (
    <div className="flex w-full max-w-2xl flex-col gap-5">
      <div className="flex items-center gap-3">
        <Avatar
          firstName={identity.firstName}
          lastName={identity.lastName}
          photoUrl={view.photoUrl}
          size="lg"
        />
        <div className="flex min-w-0 flex-col gap-1">
          {/* An h2, so the sections' h3 titles sit under it (in the inspector the panel title is the h2). */}
          <h2 className="text-headline break-words">
            {identity.firstName} {identity.lastName}
          </h2>
          <span className="flex flex-wrap items-center gap-2 text-footnote text-text-secondary">
            <span className="numeric">{identity.employeeNumber}</span>
            {identity.position ? <span>· {identity.position.name}</span> : null}
            <Badge tone="accent">{identity.employmentStatus}</Badge>
          </span>
        </div>
      </div>
      <OwnPhotoAndSignature
        firstName={identity.firstName}
        lastName={identity.lastName}
        photoUrl={view.photoUrl}
        canChangePhoto={view.can.changePhoto}
        eSignature={view.eSignature}
        versions={versions}
        canUploadSignature={view.can.uploadESignature}
        imageUpload={uploads.image}
      />
      {reminder?.showReminder ? (
        <Link
          href={ONBOARDING_HREF}
          className="flex min-h-11 items-center gap-3 rounded-card bg-surface px-4 py-3 shadow-card hover:bg-accent-subtle/30"
        >
          <IconTile className="size-9 rounded-lg [&_svg]:size-4.5">
            <ListChecks strokeWidth={1.75} />
          </IconTile>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-subheadline font-semibold">Onboarding checklist</span>
            <span className="numeric text-footnote text-text-secondary">
              {onboardingDoneText(reminder)}
            </span>
          </span>
          <ChevronRight
            aria-hidden="true"
            strokeWidth={1.75}
            className="size-4.5 shrink-0 text-text-secondary"
          />
        </Link>
      ) : null}
      <OwnPayslips payslips={payslips} />
      <OwnRecord
        view={view}
        states={states}
        changeRequests={changeRequests}
        brands={brands}
        documentUpload={uploads.document}
        uploadTypes={EMPLOYEE_UPLOAD_DOCUMENT_TYPES}
        workSchedule={workSchedule ? <WorkScheduleSection section={workSchedule} /> : null}
      />
    </div>
  );
}

/** The employee's own Work schedule section; null when none can be shown (no company schedule). */
async function ownWorkSchedule(
  user: CurrentUser,
  employeeId: string,
): Promise<WorkScheduleSectionView | null> {
  try {
    return await getWorkScheduleSection(user, employeeId);
  } catch (error) {
    if (error instanceof ActionError) return null;
    throw error;
  }
}

function MyRecordLoading() {
  return (
    <div role="status" aria-live="polite" className="flex w-full max-w-2xl flex-col gap-5">
      <span className="sr-only">Loading your record…</span>
      <div className="flex items-center gap-3">
        <Skeleton className="size-12 rounded-full" />
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-4 w-48 max-w-full" />
          <Skeleton className="h-3 w-32" />
        </div>
      </div>
      {Array.from({ length: 4 }, (_, index) => (
        <div
          key={index}
          aria-hidden="true"
          className="flex flex-col gap-3 rounded-card bg-surface p-4 shadow-card"
        >
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ))}
    </div>
  );
}
