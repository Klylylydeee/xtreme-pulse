'use client';

import { type RefObject, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { CircleCheck, RotateCw } from 'lucide-react';
import type { EmployeeRecordView } from '@pulse/talent';
import { Avatar } from '@pulse/ui/components/avatar';
import { Button } from '@pulse/ui/components/button';
import { ErrorState } from '@pulse/ui/components/error-state';
import { InspectorPanel } from '@pulse/ui/components/inspector-panel';
import { Sheet, SheetContent } from '@pulse/ui/components/sheet';
import { Skeleton } from '@pulse/ui/components/skeleton';
import { useReturnFocus } from '@pulse/ui/hooks/use-return-focus';
import { Badge } from '@/components/org-structure';
import { getEmployeeRecordAction } from '@/lib/actions/talent';
import { EmployeeRecordSections, type RecordSectionKey } from './employee-record-sections';
import { RecordSectionSheet } from './employee-record-sheets';

// Spec: docs/modules/talent.md#the-employee-record-build-step-21 (decision 168) — the employee
// record in the inspector on `/talent` (a full-height sheet on a phone). `?employee=<employeeId>`
// opens it, also when a link sets it again; closing drops it. The record is loaded through a
// Server Action that checks Talent Read, and the service builds each section for this viewer, so
// what can't be seen never reaches the browser. Each section's Edit sheet is rendered beside the
// panel, not inside it, so its Escape closes only the sheet. After a save the record reloads (a
// new `version`) and the list behind it refreshes. Nothing here is logged or cached.

const LOAD_FAILED = 'This record couldn’t load. Check your connection and try again.';

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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employeeId: string | null;
  session: number;
  returnFocus: RefObject<HTMLElement | null>;
  preview: EmployeePreview | null;
  /** "Show separated" is on: a separated employee's record opens too. */
  separated: boolean;
}) {
  const router = useRouter();
  const { state, reload } = useEmployeeRecord(employeeId, session, separated);
  const view = state.status === 'done' ? state.view : null;
  const title = view
    ? `${view.identity.firstName} ${view.identity.lastName}`
    : (preview?.name ?? 'Employee record');
  const position = view ? (view.identity.position?.name ?? null) : (preview?.positionName ?? null);

  const sheetFocus = useReturnFocus();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheet, setSheet] = useState<{ section: RecordSectionKey; session: number } | null>(null);
  const [notice, setNotice] = useState<{ for: string; message: string } | null>(null);

  function openSheet(section: RecordSectionKey) {
    sheetFocus.remember(document.activeElement as HTMLElement | null);
    setNotice(null);
    setSheet((previous) => ({ section, session: (previous?.session ?? 0) + 1 }));
    setSheetOpen(true);
  }

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
            notice={notice && notice.for === `${employeeId}:${session}` ? notice.message : null}
          />
        ) : null}
      </InspectorPanel>
      {view && sheet ? (
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetContent aria-describedby={undefined} onCloseAutoFocus={sheetFocus.onCloseAutoFocus}>
            <RecordSectionSheet
              key={sheet.session}
              section={sheet.section}
              view={view}
              onSaved={(message) => {
                setSheetOpen(false);
                setNotice({ for: `${employeeId}:${session}`, message });
                reload();
                router.refresh();
              }}
              onReload={() => {
                setSheetOpen(false);
                reload();
                router.refresh();
              }}
            />
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
  notice,
}: {
  state: RecordState;
  onReload: () => void;
  onEdit: (section: RecordSectionKey) => void;
  notice: string | null;
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
      <div role="status" className="empty:hidden">
        {notice ? (
          <p className="flex items-start gap-2 rounded-card bg-surface px-4 py-3 text-footnote font-medium text-success-text shadow-card">
            <CircleCheck aria-hidden="true" className="mt-px size-4 shrink-0" />
            <span>{notice}</span>
          </p>
        ) : null}
      </div>
      <div className="flex items-center gap-3">
        <Avatar firstName={identity.firstName} lastName={identity.lastName} size="lg" />
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
      <EmployeeRecordSections view={view} onEdit={onEdit} />
    </div>
  );
}
