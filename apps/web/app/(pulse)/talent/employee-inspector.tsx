'use client';

import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { CircleAlert, CircleCheck, RotateCw, TriangleAlert } from 'lucide-react';
import type { EmployeeRecordView, WorkScheduleSectionView } from '@pulse/talent';
import { Avatar } from '@pulse/ui/components/avatar';
import { Button } from '@pulse/ui/components/button';
import { ErrorState } from '@pulse/ui/components/error-state';
import { InspectorPanel } from '@pulse/ui/components/inspector-panel';
import { Sheet, SheetContent } from '@pulse/ui/components/sheet';
import { Skeleton } from '@pulse/ui/components/skeleton';
import { useReturnFocus } from '@pulse/ui/hooks/use-return-focus';
import { Badge } from '@/components/org-structure';
import { getEmployeeRecordAction, getWorkScheduleSectionAction } from '@/lib/actions/talent';
import type { UploadHints } from '@/lib/upload-hints';
import type { DocumentHandlers } from './employee-documents-sections';
import {
  type BrandOption,
  type DocumentSheet,
  DocumentRecordSheet,
} from './employee-documents-sheets';
import {
  EmployeeRecordSections,
  type RecordSectionActionKey,
  type RecordSectionKey,
  WorkScheduleSection,
} from './employee-record-sections';
import { RecordSectionSheet, WorkScheduleSheet } from './employee-record-sheets';
import { MarkVerifiedButton, OnboardingBlock, useEmployeeOnboarding } from './onboarding-section';
import { CorrectionSheet, usePayrollOpening } from './opening-balances/opening-balance-sheets';
import { PhotoControls } from './photo-controls';
import {
  PayrollOpeningBlock,
  TimeOffBlock,
  type TimeOffSectionData,
  useTimeOffSection,
} from './time-off-section';

// Spec: docs/modules/talent.md#the-employee-record-build-step-21 (decision 168) — the employee
// record in the inspector on `/talent` (a full-height sheet on a phone). `?employee=<employeeId>`
// opens it, also when a link sets it again; closing drops it. The record is loaded through a
// Server Action that checks Talent Read, and the service builds each section for this viewer, so
// what can't be seen never reaches the browser. Each section's Edit sheet is rendered beside the
// panel, not inside it, so its Escape closes only the sheet. After a save the record reloads (a
// new `version`) and the list behind it refreshes. Nothing here is logged or cached.
//
// From step 2.2 the record also has the photo (Change and Remove), the e-signature status, the 201
// file and Skills & certifications, with their sheets (`employee-documents-sheets.tsx`).
//
// From step 2.3 the Compensation section opens "Assign allowance" too, and a salary saved with no
// minimum wage on file for the region shows the save's note under the confirmation.
//
// From step 2.4 (docs/modules/talent.md#work-schedules-and-daily-time-entries-build-step-24) the
// Work schedule section loads beside the record through its own Server Action (Talent Read; the
// service checks again), so a failure there never blanks the record. It has "Set schedule" when
// the server's `canSet` allows it, and "Timesheet", a link to the read-only timesheet (every
// inspector viewer has Talent Read).
//
// From step 2.6 (docs/modules/talent.md#onboarding-checklist-and-change-requests-build-step-26) the
// Onboarding section loads on its own too (`onboarding-section.tsx`), with "Confirm no supervisor",
// and the Government IDs and Payroll bank account headers get "Mark verified" when the server's
// `can` flags allow it. A refused action shows its message above the record.
//
// From step 2.8 (docs/modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28)
// a Time off section follows Work schedule, and the Compensation section ends with year-to-date
// pay at go-live; each loads on its own (`time-off-section.tsx`). "Add correction" opens its
// sheet beside the panel like the others.

const LOAD_FAILED = 'This record couldn’t load. Check your connection and try again.';

/** The line shown after a change, for one opening of one record; `note` is a second, warning line. */
interface Notice {
  for: string;
  message: string;
  note: string | null;
  /** Step 2.6: a refused "Mark verified", shown as an error instead of a confirmation. */
  error?: boolean;
}

function replaceEmployeeParam(employeeId: string | null) {
  const params = new URLSearchParams(window.location.search);
  if (employeeId) params.set('employee', employeeId);
  else params.delete('employee');
  const query = params.toString();
  window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
}

/** The inspector's open state, driven by `?employee=`. */
export function useEmployeeInspector() {
  const searchParams = useSearchParams();
  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState(0);
  const returnFocus = useRef<HTMLElement | null>(null);

  function show(id: string) {
    setEmployeeId(id);
    setSession((count) => count + 1);
    setOpen(true);
  }

  const param = searchParams.get('employee');
  const [seenParam, setSeenParam] = useState<string | null>(null);
  if (param !== seenParam) {
    setSeenParam(param);
    if (param) show(param);
  }

  function openEmployee(id: string, trigger?: HTMLElement | null) {
    if (trigger) returnFocus.current = trigger;
    replaceEmployeeParam(id);
    setSeenParam(id);
    show(id);
  }

  function changeOpen(next: boolean) {
    setOpen(next);
    if (!next && new URLSearchParams(window.location.search).has('employee')) {
      replaceEmployeeParam(null);
      setSeenParam(null);
    }
  }

  return { employeeId, open, session, returnFocus, openEmployee, changeOpen };
}

type RecordState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'gone' }
  | { status: 'done'; view: EmployeeRecordView; refreshing: boolean };

function useEmployeeRecord(id: string | null, session: number, separated: boolean) {
  const [state, setState] = useState<RecordState>({ status: 'idle' });
  const [attempt, setAttempt] = useState(0);

  const key = id ? `${id}:${session}` : null;
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  if (key !== loadedFor) {
    setLoadedFor(key);
    setState(id ? { status: 'loading' } : { status: 'idle' });
  }

  useEffect(() => {
    if (!id) return;
    let current = true;
    getEmployeeRecordAction(null, { employeeId: id, separated })
      .then((result) => {
        if (!current) return;
        if (!result.ok) setState({ status: 'error', message: result.formError ?? LOAD_FAILED });
        else if (!result.data) setState({ status: 'gone' });
        else setState({ status: 'done', view: result.data, refreshing: false });
      })
      .catch(() => {
        if (current) setState({ status: 'error', message: LOAD_FAILED });
      });
    return () => {
      current = false;
    };
  }, [id, session, attempt, separated]);

  function reload() {
    setState((previous) =>
      previous.status === 'done' ? { ...previous, refreshing: true } : { status: 'loading' },
    );
    setAttempt((count) => count + 1);
  }

  return { state, reload };
}

const SCHEDULE_LOAD_FAILED =
  'The work schedule couldn’t load. Check your connection and try again.';

type ScheduleState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'done'; section: WorkScheduleSectionView | null };

/** The Work schedule section (step 2.4), loaded on its own beside the record. */
function useWorkSchedule(id: string | null, session: number) {
  const [state, setState] = useState<ScheduleState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  const key = id ? `${id}:${session}` : null;
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  if (key !== loadedFor) {
    setLoadedFor(key);
    setState({ status: 'loading' });
  }

  useEffect(() => {
    if (!id) return;
    let current = true;
    getWorkScheduleSectionAction(null, { employeeId: id })
      .then((result) => {
        if (!current) return;
        if (!result.ok) {
          setState({ status: 'error', message: result.formError ?? SCHEDULE_LOAD_FAILED });
        } else setState({ status: 'done', section: result.data });
      })
      .catch(() => {
        if (current) setState({ status: 'error', message: SCHEDULE_LOAD_FAILED });
      });
    return () => {
      current = false;
    };
  }, [id, session, attempt]);

  return { state, reload: () => setAttempt((count) => count + 1) };
}

/** What the inspector's sheets need from the page: the product picker and the upload limits. */
export interface InspectorTools {
  brands: BrandOption[];
  uploads: UploadHints;
}

type OpenSheet =
  | { type: 'section'; section: RecordSectionKey; session: number }
  | { type: 'document'; sheet: DocumentSheet; session: number }
  | { type: 'schedule'; session: number }
  | { type: 'correction'; data: TimeOffSectionData; session: number };

/** What the list already knows, for the title while the record loads. */
export interface EmployeePreview {
  name: string;
  positionName: string | null;
}

export function EmployeeInspector({
  open,
  onOpenChange,
  employeeId,
  session,
  returnFocus,
  preview,
  separated,
  tools,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employeeId: string | null;
  session: number;
  returnFocus: RefObject<HTMLElement | null>;
  preview: EmployeePreview | null;
  /** "Show separated" is on: a separated employee's record opens too. */
  separated: boolean;
  tools: InspectorTools;
}) {
  const router = useRouter();
  const { state, reload } = useEmployeeRecord(employeeId, session, separated);
  const schedule = useWorkSchedule(employeeId, session);
  const onboarding = useEmployeeOnboarding(employeeId, session, separated);
  const timeOff = useTimeOffSection(employeeId, session);
  const payrollOpening = usePayrollOpening(employeeId, session);
  const scheduleSection = schedule.state.status === 'done' ? schedule.state.section : null;
  const view = state.status === 'done' ? state.view : null;
  const title = view
    ? `${view.identity.firstName} ${view.identity.lastName}`
    : (preview?.name ?? 'Employee record');
  const position = view ? (view.identity.position?.name ?? null) : (preview?.positionName ?? null);

  const sheetFocus = useReturnFocus();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheet, setSheet] = useState<OpenSheet | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  function remember() {
    sheetFocus.remember(document.activeElement as HTMLElement | null);
    setNotice(null);
  }

  function openSheet(section: RecordSectionKey) {
    remember();
    setSheet((previous) => ({ type: 'section', section, session: (previous?.session ?? 0) + 1 }));
    setSheetOpen(true);
  }

  function openDocumentSheet(next: DocumentSheet) {
    remember();
    setSheet((previous) => ({
      type: 'document',
      sheet: next,
      session: (previous?.session ?? 0) + 1,
    }));
    setSheetOpen(true);
  }

  function openCorrectionSheet(data: TimeOffSectionData) {
    remember();
    setSheet((previous) => ({ type: 'correction', data, session: (previous?.session ?? 0) + 1 }));
    setSheetOpen(true);
  }

  function openScheduleSheet() {
    remember();
    setSheet((previous) => ({ type: 'schedule', session: (previous?.session ?? 0) + 1 }));
    setSheetOpen(true);
  }

  /**
   * After a change: show `message` (and `note`, such as "No minimum wage on file …"), reload the
   * record and refresh the list behind it.
   */
  function changed(message: string, note?: string) {
    setNotice({ for: `${employeeId}:${session}`, message, note: note ?? null });
    reload();
    schedule.reload();
    onboarding.reload();
    timeOff.reload();
    payrollOpening.reload();
    router.refresh();
  }

  /** A refused action (step 2.6's "Mark verified"): its message, and the record reloaded. */
  function refused(message: string) {
    setNotice({ for: `${employeeId}:${session}`, message, note: null, error: true });
    reload();
  }

  const documentHandlers: DocumentHandlers = {
    onAddDocument: () => openDocumentSheet({ kind: 'addDocument' }),
    onEditDocument: (doc) => openDocumentSheet({ kind: 'editDocument', document: doc }),
    onArchiveDocument: (doc) => openDocumentSheet({ kind: 'archiveDocument', document: doc }),
    onEditSkills: () => openDocumentSheet({ kind: 'skills' }),
    onAddCertification: () => openDocumentSheet({ kind: 'addCertification' }),
    onEditCertification: (certification) =>
      openDocumentSheet({ kind: 'editCertification', certification }),
    onChanged: changed,
  };

  return (
    <>
      <InspectorPanel
        open={open}
        onOpenChange={onOpenChange}
        eyebrow="Employee record"
        title={title}
        description={position ?? undefined}
        returnFocus={returnFocus}
        closeLabel="Close record"
      >
        {employeeId ? (
          <RecordBody
            state={state}
            onReload={reload}
            onEdit={openSheet}
            documentHandlers={documentHandlers}
            imageUpload={tools.uploads.image}
            onPhotoChanged={changed}
            workSchedule={
              <WorkScheduleBlock
                state={schedule.state}
                onRetry={schedule.reload}
                onSet={openScheduleSheet}
                employeeId={employeeId}
                name={title}
              />
            }
            timeOff={
              <TimeOffBlock
                state={timeOff.state}
                onRetry={timeOff.reload}
                employeeId={employeeId}
                name={title}
                onCorrect={openCorrectionSheet}
              />
            }
            payrollOpening={
              <PayrollOpeningBlock
                state={payrollOpening.state}
                onRetry={payrollOpening.reload}
                employeeId={employeeId}
              />
            }
            notice={notice && notice.for === `${employeeId}:${session}` ? notice : null}
            onboarding={(record) => (
              <OnboardingBlock
                state={onboarding.state}
                onRetry={onboarding.reload}
                record={record}
                onChanged={changed}
              />
            )}
            sectionActions={(record) => ({
              governmentIds: record.can.markGovernmentIdsVerified ? (
                <MarkVerifiedButton
                  record={record}
                  group="governmentIds"
                  onChanged={changed}
                  onError={refused}
                />
              ) : null,
              bankAccount: record.can.markBankAccountVerified ? (
                <MarkVerifiedButton
                  record={record}
                  group="bankAccount"
                  onChanged={changed}
                  onError={refused}
                />
              ) : null,
            })}
          />
        ) : null}
      </InspectorPanel>
      {view && sheet ? (
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetContent aria-describedby={undefined} onCloseAutoFocus={sheetFocus.onCloseAutoFocus}>
            {sheet.type === 'correction' ? (
              <CorrectionSheet
                key={sheet.session}
                employeeId={view.employeeId}
                name={title}
                leaveTypes={sheet.data.leave.balances.map((balance) => ({
                  key: balance.typeKey,
                  name: balance.name,
                  shortName: balance.shortName,
                }))}
                onSaved={(message) => {
                  setSheetOpen(false);
                  changed(message);
                }}
              />
            ) : sheet.type === 'schedule' ? (
              scheduleSection ? (
                <WorkScheduleSheet
                  key={sheet.session}
                  section={scheduleSection}
                  view={view}
                  onSaved={(message) => {
                    setSheetOpen(false);
                    changed(message);
                  }}
                />
              ) : null
            ) : sheet.type === 'section' ? (
              <RecordSectionSheet
                key={sheet.session}
                section={sheet.section}
                view={view}
                onSaved={(message, note) => {
                  setSheetOpen(false);
                  changed(message, note);
                }}
                onReload={() => {
                  setSheetOpen(false);
                  reload();
                  router.refresh();
                }}
              />
            ) : (
              <DocumentRecordSheet
                key={sheet.session}
                sheet={sheet.sheet}
                view={view}
                brands={tools.brands}
                documentUpload={tools.uploads.document}
                onSaved={(message) => {
                  setSheetOpen(false);
                  changed(message);
                }}
                onReload={() => {
                  setSheetOpen(false);
                  reload();
                  router.refresh();
                }}
              />
            )}
          </SheetContent>
        </Sheet>
      ) : null}
    </>
  );
}

function RecordBody({
  state,
  onReload,
  onEdit,
  documentHandlers,
  imageUpload,
  onPhotoChanged,
  workSchedule,
  timeOff,
  payrollOpening,
  notice,
  onboarding,
  sectionActions,
}: {
  state: RecordState;
  onReload: () => void;
  onEdit: (section: RecordSectionKey) => void;
  documentHandlers: DocumentHandlers;
  imageUpload: UploadHints['image'];
  onPhotoChanged: (message: string) => void;
  workSchedule: ReactNode;
  /** Step 2.8: the Time off section, after Work schedule. */
  timeOff: ReactNode;
  /** Step 2.8: year-to-date pay at go-live, shown in Compensation for salary viewers only. */
  payrollOpening: ReactNode;
  notice: Notice | null;
  /** Step 2.6: the Onboarding section, after the record. */
  onboarding: (record: EmployeeRecordView) => ReactNode;
  /** Step 2.6: "Mark verified" in the Government IDs and Payroll bank account headers. */
  sectionActions: (
    record: EmployeeRecordView,
  ) => Partial<Record<RecordSectionActionKey, ReactNode>>;
}) {
  if (state.status === 'idle' || state.status === 'loading') {
    return (
      <div role="status" className="flex flex-col gap-4">
        <span className="sr-only">Loading the record…</span>
        <div className="flex items-center gap-3">
          <Skeleton className="size-12 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="flex flex-col gap-3 rounded-card bg-surface p-4 shadow-card">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ))}
      </div>
    );
  }
  if (state.status === 'gone') {
    return (
      <ErrorState
        variant="inline"
        headingLevel={3}
        title="This employee isn’t in the list"
        description="They may have left the company, or the link is wrong. Turn on “Show separated” or close this to see the list."
      />
    );
  }
  if (state.status === 'error') {
    return (
      <ErrorState
        variant="inline"
        headingLevel={3}
        title="Couldn’t load the record"
        description={state.message}
        action={
          <Button variant="tinted" onClick={onReload}>
            <RotateCw aria-hidden="true" className="size-4.5" />
            Try again
          </Button>
        }
      />
    );
  }

  const { view, refreshing } = state;
  const { identity } = view;
  return (
    <div className="flex flex-col gap-5" aria-busy={refreshing || undefined}>
      <div role="alert" className="empty:hidden">
        {notice?.error ? (
          <p className="flex items-start gap-2 rounded-card bg-surface px-4 py-3 text-footnote font-medium text-destructive-text shadow-card">
            <CircleAlert aria-hidden="true" className="mt-px size-4 shrink-0" />
            <span>{notice.message}</span>
          </p>
        ) : null}
      </div>
      <div role="status" className="empty:hidden">
        {notice && !notice.error ? (
          <div className="flex flex-col gap-2 rounded-card bg-surface px-4 py-3 text-footnote font-medium shadow-card">
            <p className="flex items-start gap-2 text-success-text">
              <CircleCheck aria-hidden="true" className="mt-px size-4 shrink-0" />
              <span>{notice.message}</span>
            </p>
            {notice.note ? (
              <p className="flex items-start gap-2 text-warning-text">
                <TriangleAlert aria-hidden="true" className="mt-px size-4 shrink-0" />
                <span>{notice.note}</span>
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-3">
        <Avatar
          firstName={identity.firstName}
          lastName={identity.lastName}
          photoUrl={view.photoUrl}
          size="lg"
        />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="numeric text-footnote text-text-secondary">
            {identity.employeeNumber}
          </span>
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={identity.separated ? 'neutral' : 'accent'}>
              {identity.employmentStatus}
            </Badge>
            {view.filledIn ? null : <Badge>Not filled in</Badge>}
          </span>
        </div>
      </div>
      <EmployeeRecordSections
        view={view}
        onEdit={onEdit}
        documentHandlers={documentHandlers}
        workSchedule={
          <>
            {workSchedule}
            {timeOff}
          </>
        }
        payrollOpening={view.compensation ? payrollOpening : null}
        photoSlot={
          <PhotoControls
            target={{ kind: 'employee', employeeId: view.employeeId }}
            photoUrl={view.photoUrl}
            firstName={identity.firstName}
            lastName={identity.lastName}
            canChange={view.can.changePhoto}
            accept={imageUpload.accept}
            hint={imageUpload.hint}
            onChanged={onPhotoChanged}
          />
        }
        sectionActions={sectionActions(view)}
      />
      {onboarding(view)}
    </div>
  );
}

/** The Work schedule section, or its skeleton or error while it loads on its own. */
function WorkScheduleBlock({
  state,
  onRetry,
  onSet,
  employeeId,
  name,
}: {
  state: ScheduleState;
  onRetry: () => void;
  onSet: () => void;
  employeeId: string;
  name: string;
}) {
  if (state.status === 'loading') {
    return (
      <div role="status" className="flex flex-col gap-3 rounded-card bg-surface p-4 shadow-card">
        <span className="sr-only">Loading the work schedule…</span>
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <ErrorState
        variant="inline"
        headingLevel={3}
        title="Couldn’t load the work schedule"
        description={state.message}
        action={
          <Button variant="tinted" onClick={onRetry}>
            <RotateCw aria-hidden="true" className="size-4.5" />
            Try again
          </Button>
        }
      />
    );
  }
  if (!state.section) return null;
  return (
    <WorkScheduleSection
      section={state.section}
      onSet={onSet}
      timesheetHref={`/talent/timesheets/${employeeId}`}
      timesheetLabel={`Timesheet for ${name}`}
    />
  );
}
