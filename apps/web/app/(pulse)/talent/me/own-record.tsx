'use client';

import { type ReactNode, useId, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronRight, CircleCheck, FileUp, Send, XCircle } from 'lucide-react';
import { formatDate } from '@pulse/core';
import {
  type ChangeRequestSection,
  type ChangeRequestStatus,
  changeRequestHref,
  type Document201Type,
  type EmployeeRecordView,
  type OwnChangeRequestListItem,
  type OwnSection,
} from '@pulse/talent';
import { Button } from '@pulse/ui/components/button';
import { DestructiveConfirmDialog } from '@pulse/ui/components/confirm-dialog';
import { Sheet, SheetContent } from '@pulse/ui/components/sheet';
import { useReturnFocus } from '@pulse/ui/hooks/use-return-focus';
import { Badge } from '@/components/org-structure';
import { notifyOnboardingChanged } from '@/components/onboarding-progress';
import { cancelChangeRequestAction } from '@/lib/actions/talent-change-requests';
import type { UploadHint } from '@/lib/upload-hints';
import type { DocumentHandlers } from '../employee-documents-sections';
import { EmployeeRecordSections } from '../employee-record-sections';
import { EditButton } from '../record-ui';
import {
  OpenRequestNotice,
  OWN_SHEET_TITLES,
  type OwnBrandOption,
  OwnRecordSheet,
  type OwnSectionStates,
  type OwnSheet,
} from './own-record-sheets';

// Spec: docs/modules/talent.md#onboarding-checklist-and-change-requests-build-step-26 ("Screens":
// `/talent/me`; decisions 266–268, 272 and 275 in docs/BUILD_PLAN.md) — the employee's own record
// with its self-service actions:
//
// - Edit on Personal, Government IDs, Payroll bank account and Skills, opening the own sheets
//   ("Save" or "Send for approval"). While a section has an open change request, its Edit reads "A
//   change to this section is waiting for approval" (or "…was returned") and opens the request
//   instead. The on-screen Personal section holds two change request sections, so it shows Edit
//   while either part can still change.
// - "Upload document" at the top of the 201 file and "Add certification" (the employee's own; HR
//   edits, archives and removes them). The record view leaves every inspector permission off for
//   one's own record, so `addCertification` is turned on here for the employee's own add, which
//   the service checks again; nothing else is.
// - The Change requests list, newest first, with status badges (text, never color alone), the
//   remarks of a returned or rejected request, and "Edit and send again" and "Cancel request" on
//   a returned one.
//
// Every action acts on the signed-in user's own employee; nothing takes an employee id.

const CANCEL_FAILED = 'The request wasn’t cancelled. Check your connection and try again.';

/** The sheets and their host, shared by `/talent/me` and the onboarding checklist. */
export function useOwnSheets({
  view,
  states,
  brands,
  documentUpload,
  uploadTypes,
  onChanged,
}: {
  view: EmployeeRecordView;
  states: OwnSectionStates;
  brands: OwnBrandOption[];
  documentUpload: UploadHint;
  uploadTypes: readonly Document201Type[];
  /** After a save: show `message`. The host has already refreshed the page. */
  onChanged: (message: string) => void;
}) {
  const router = useRouter();
  const focus = useReturnFocus();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<{ sheet: OwnSheet; session: number } | null>(null);

  function openSheet(sheet: OwnSheet) {
    focus.remember(document.activeElement as HTMLElement | null);
    setCurrent((previous) => ({ sheet, session: (previous?.session ?? 0) + 1 }));
    setOpen(true);
  }

  function refresh() {
    router.refresh();
    notifyOnboardingChanged();
  }

  const host = current ? (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent aria-describedby={undefined} onCloseAutoFocus={focus.onCloseAutoFocus}>
        <OwnRecordSheet
          key={current.session}
          sheet={current.sheet}
          view={view}
          states={states}
          brands={brands}
          documentUpload={documentUpload}
          uploadTypes={uploadTypes}
          onSaved={(message) => {
            setOpen(false);
            refresh();
            onChanged(message);
          }}
          onReload={() => {
            setOpen(false);
            refresh();
          }}
        />
      </SheetContent>
    </Sheet>
  ) : null;

  return { openSheet, host, refresh };
}

/** The own sections' parts, for which Edit or notice to show. */
const SECTION_PARTS: Record<OwnSection, readonly ChangeRequestSection[]> = {
  personal: ['personal', 'contact'],
  governmentIds: ['governmentIds'],
  bankAccount: ['bankAccount'],
  skills: ['skills'],
};

/** A section's header action: Edit, the open request's notice, or both (Personal). */
export function OwnSectionAction({
  section,
  states,
  onEdit,
}: {
  section: OwnSection;
  states: OwnSectionStates;
  onEdit: (section: OwnSection) => void;
}) {
  const parts = SECTION_PARTS[section];
  const open = parts.flatMap((part) => {
    const request = states[part].openRequest;
    return request ? [request] : [];
  });
  const canEdit = open.length < parts.length;
  return (
    <>
      {open.map((request) => (
        <OpenRequestNotice key={request.id} request={request} className="rounded-lg px-3" />
      ))}
      {canEdit ? (
        <EditButton label={OWN_SHEET_TITLES[section]} onClick={() => onEdit(section)} />
      ) : null}
    </>
  );
}

/** A success line under the page header, announced politely. */
export function SavedNotice({ message }: { message: string | null }) {
  return (
    <div role="status" className="empty:hidden">
      {message ? (
        <p className="flex items-start gap-2 rounded-card bg-surface px-4 py-3 text-footnote font-medium text-success-text shadow-card">
          <CircleCheck aria-hidden="true" className="mt-px size-4 shrink-0" />
          <span>{message}</span>
        </p>
      ) : null}
    </div>
  );
}

/** `/talent/me`'s record with the own actions, and the Change requests list. */
export function OwnRecord({
  view,
  states,
  changeRequests,
  brands,
  documentUpload,
  uploadTypes,
  workSchedule,
}: {
  view: EmployeeRecordView;
  states: OwnSectionStates;
  changeRequests: OwnChangeRequestListItem[];
  brands: OwnBrandOption[];
  documentUpload: UploadHint;
  uploadTypes: readonly Document201Type[];
  workSchedule: ReactNode;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const sheets = useOwnSheets({
    view,
    states,
    brands,
    documentUpload,
    uploadTypes,
    onChanged: setNotice,
  });
  const edit = (section: OwnSection) => {
    setNotice(null);
    sheets.openSheet({ kind: 'section', section });
  };
  const action = (section: OwnSection) => (
    <OwnSectionAction section={section} states={states} onEdit={edit} />
  );
  // Only "Add certification" is wired: the rest stay off on one's own record.
  const handlers: DocumentHandlers = {
    onAddDocument: () => undefined,
    onEditDocument: () => undefined,
    onArchiveDocument: () => undefined,
    onEditSkills: () => undefined,
    onAddCertification: () => {
      setNotice(null);
      sheets.openSheet({ kind: 'addCertification' });
    },
    onEditCertification: () => undefined,
    onChanged: (message) => {
      setNotice(message);
      sheets.refresh();
    },
  };
  const ownView: EmployeeRecordView = { ...view, can: { ...view.can, addCertification: true } };

  return (
    <>
      <SavedNotice message={notice} />
      <EmployeeRecordSections
        view={ownView}
        showESignature={false}
        workSchedule={workSchedule}
        documentHandlers={handlers}
        sectionActions={{
          personal: action('personal'),
          ...(view.governmentIds ? { governmentIds: action('governmentIds') } : {}),
          ...(view.bankAccount ? { bankAccount: action('bankAccount') } : {}),
          skills: action('skills'),
        }}
        photoSlot={
          <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
            <p className="min-w-0 flex-1 text-footnote text-text-secondary">
              Upload your own copies, like an NBI clearance or a government ID. HR issues the
              employment contract and the regularization evaluation.
            </p>
            <Button
              variant="tinted"
              className="shrink-0"
              onClick={() => {
                setNotice(null);
                sheets.openSheet({ kind: 'addDocument' });
              }}
            >
              <FileUp aria-hidden="true" strokeWidth={1.75} />
              Upload document
            </Button>
          </div>
        }
      />
      <ChangeRequestsList
        requests={changeRequests}
        onResend={(request) => {
          setNotice(null);
          sheets.openSheet({ kind: 'resend', request });
        }}
        onChanged={(message) => {
          setNotice(message);
          sheets.refresh();
        }}
      />
      {sheets.host}
    </>
  );
}

const STATUS_TONES: Record<ChangeRequestStatus, 'accent' | 'neutral'> = {
  pending: 'accent',
  returned: 'neutral',
  approved: 'neutral',
  rejected: 'neutral',
  cancelled: 'neutral',
};

/** The employee's own change requests, newest first. */
function ChangeRequestsList({
  requests,
  onResend,
  onChanged,
}: {
  requests: OwnChangeRequestListItem[];
  onResend: (request: OwnChangeRequestListItem) => void;
  onChanged: (message: string) => void;
}) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-2">
      <h3
        id={titleId}
        className="flex min-h-11 items-center pl-4 text-footnote font-semibold text-text-secondary"
      >
        Change requests
      </h3>
      {requests.length === 0 ? (
        <p className="rounded-card bg-surface px-4 py-3 text-subheadline text-text-secondary shadow-card">
          No change requests yet. Changing a filled-in detail sends one for approval.
        </p>
      ) : (
        <ol
          aria-labelledby={titleId}
          className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card"
        >
          {requests.map((request) => (
            <ChangeRequestRow
              key={request.id}
              request={request}
              onResend={onResend}
              onChanged={onChanged}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

function ChangeRequestRow({
  request,
  onResend,
  onChanged,
}: {
  request: OwnChangeRequestListItem;
  onResend: (request: OwnChangeRequestListItem) => void;
  onChanged: (message: string) => void;
}) {
  const [cancelError, setCancelError] = useState<string | null>(null);

  async function cancel() {
    setCancelError(null);
    let failed: string | null = null;
    try {
      const result = await cancelChangeRequestAction(null, { changeRequestId: request.id });
      if (!result.ok) failed = result.formError ?? CANCEL_FAILED;
    } catch {
      failed = CANCEL_FAILED;
    }
    if (failed) {
      setCancelError(failed);
      // Keeps the dialog open with the error.
      throw new Error('Not cancelled');
    }
    onChanged('Change request cancelled.');
  }

  return (
    <li className="flex flex-col gap-1 py-2.5">
      <Link
        href={changeRequestHref(request.id)}
        className="-my-1 flex min-h-11 items-center gap-3 px-4 py-1 hover:bg-accent-subtle/30"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-subheadline font-semibold break-words">
              {request.sectionLabel}
            </span>
            <Badge tone={STATUS_TONES[request.status]}>{request.statusLabel}</Badge>
          </span>
          <span className="text-footnote break-words text-text-secondary">
            {request.summary} · Sent <span className="numeric">{formatDate(request.sentAt)}</span>
          </span>
        </span>
        <ChevronRight
          aria-hidden="true"
          strokeWidth={1.75}
          className="size-4.5 shrink-0 text-text-secondary"
        />
      </Link>
      {request.remarks ? (
        <p className="px-4 text-footnote break-words text-text-secondary">
          Remarks: <span className="text-text-primary">{request.remarks}</span>
        </p>
      ) : null}
      {request.canResend || request.canCancel ? (
        <div className="flex flex-wrap items-center gap-1 px-1">
          {request.canResend ? (
            <Button
              variant="plain"
              className="px-3"
              onClick={() => onResend(request)}
              aria-label={`Edit and send again: ${request.sectionLabel}`}
            >
              <Send aria-hidden="true" className="size-4.5" />
              Edit and send again
            </Button>
          ) : null}
          {request.canCancel ? (
            <DestructiveConfirmDialog
              trigger={
                <Button
                  variant="plain"
                  className="px-3 text-destructive-text hover:text-destructive-text"
                  aria-label={`Cancel request: ${request.sectionLabel}`}
                >
                  <XCircle aria-hidden="true" className="size-4.5" />
                  Cancel request
                </Button>
              }
              title={`Cancel this ${request.sectionLabel.toLowerCase()} request?`}
              description="Nothing in it is saved. The request is kept, marked cancelled, and can’t be sent again."
              confirmLabel="Cancel request"
              cancelLabel="Keep it"
              onConfirm={cancel}
              error={cancelError}
            />
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
