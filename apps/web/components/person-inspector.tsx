'use client';

import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { CircleCheck, Mail, PencilLine, RotateCw, UserRound, Users } from 'lucide-react';
import {
  type DirectoryCard,
  type DirectoryPersonLink,
  type FieldErrors,
  OWN_REPORTING_LINES,
  reportingLinesChangedMessage,
} from '@pulse/core';
import { cn } from '@pulse/ui';
import { Button } from '@pulse/ui/components/button';
import { ErrorState } from '@pulse/ui/components/error-state';
import { FormSection } from '@pulse/ui/components/form';
import { InspectorPanel } from '@pulse/ui/components/inspector-panel';
import {
  ariaKeyShortcuts,
  ShortcutHint,
  submitFormFromShortcut,
  useShortcut,
} from '@pulse/ui/components/shortcut-hint';
import { Skeleton } from '@pulse/ui/components/skeleton';
import { FormAlert } from '@/components/form-alert';
import { Badge } from '@/components/org-structure';
import { PersonAvatar } from '@/components/person-avatar';
import { type PickedSupervisor, SupervisorPicker } from '@/components/supervisor-picker';
import {
  getDirectoryPersonAction,
  searchReportingLineSupervisorsAction,
  setReportingLinesAction,
} from '@/lib/actions/directory';

// Spec: docs/modules/core.md#company-directory, #org-chart and #reporting-lines (build step 1.11)
// — the directory card in the inspector (a full-height sheet on a phone), shared by `/directory`
// and `/org-chart`. It shows the directory fields only: the avatar (initials until Phase 2), name,
// employee number, position, department, the login email as a mail link, "Reports to" and "Direct
// reports", each person opening their own card here. A line to an inactive supervisor shows, with
// an "Inactive" badge, only to the reporting line editors (the service decides; decision 136).
// For HR, Board members and System Administrators, "Edit reporting lines" turns "Reports to" into
// the supervisor picker inline (not a sheet), with Save (⌘↵ or Ctrl+Enter) and Cancel. The save
// sends the supervisors the card opened with (`expected`), so a stale card is refused with the
// service's message and a Reload. `?person=<employeeId>` opens the card directly
// (usePersonInspector). Nothing here is logged or cached.

const SAVE = ['mod', 'enter'] as const;
const LOAD_FAILED = 'This card couldn’t load. Check your connection and try again.';
const SAVE_FAILED = 'The reporting lines weren’t saved. Check your connection and try again.';

/** Sets or drops `?person=` in the address bar without a navigation, keeping the other params. */
function replacePersonParam(personId: string | null) {
  const params = new URLSearchParams(window.location.search);
  if (personId) params.set('person', personId);
  else params.delete('person');
  const query = params.toString();
  window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
}

// --- Opening -----------------------------------------------------------------------------------

/**
 * The inspector's open state for a page: which person, whether it is open, and a session that
 * changes on every open (a fresh card and form). `?person=<employeeId>` opens that card on first
 * load and whenever a link sets it again (the command bar, a notification); closing drops it.
 */
export function usePersonInspector() {
  const searchParams = useSearchParams();
  const [personId, setPersonId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState(0);
  const returnFocus = useRef<HTMLElement | null>(null);

  function show(id: string) {
    setPersonId(id);
    setSession((count) => count + 1);
    setOpen(true);
  }

  const param = searchParams.get('person');
  const [seenParam, setSeenParam] = useState<string | null>(null);
  if (param !== seenParam) {
    setSeenParam(param);
    if (param) show(param);
  }

  /** Opens `id`'s card, from a row or card (`trigger`, where focus returns) or from the card. */
  function openPerson(id: string, trigger?: HTMLElement | null) {
    if (trigger) returnFocus.current = trigger;
    replacePersonParam(id);
    setSeenParam(id);
    show(id);
  }

  /** Closing drops `?person=` from the address, so a reload doesn't reopen it. */
  function changeOpen(next: boolean) {
    setOpen(next);
    if (!next && new URLSearchParams(window.location.search).has('person')) {
      replacePersonParam(null);
      setSeenParam(null);
    }
  }

  return { personId, open, session, returnFocus, openPerson, changeOpen };
}

// --- Loading -----------------------------------------------------------------------------------

type CardState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'gone' }
  | { status: 'done'; card: DirectoryCard; refreshing: boolean };

/**
 * Loads `id`'s card, again whenever `session` changes (a new open) or `reload` is called. A
 * reload keeps the loaded card on screen while it refreshes.
 */
function usePersonCard(id: string | null, session: number) {
  const [state, setState] = useState<CardState>({ status: 'idle' });
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
    getDirectoryPersonAction(null, { id })
      .then((result) => {
        if (!current) return;
        if (!result.ok) setState({ status: 'error', message: result.formError ?? LOAD_FAILED });
        else if (!result.data) setState({ status: 'gone' });
        else setState({ status: 'done', card: result.data, refreshing: false });
      })
      .catch(() => {
        if (current) setState({ status: 'error', message: LOAD_FAILED });
      });
    return () => {
      current = false;
    };
  }, [id, session, attempt]);

  function reload() {
    setState((previous) =>
      previous.status === 'done' ? { ...previous, refreshing: true } : { status: 'loading' },
    );
    setAttempt((count) => count + 1);
  }

  return { state, reload };
}

// --- The inspector -----------------------------------------------------------------------------

/** Who is looking, from the server (the services decide again on every read and save). */
export interface PersonInspectorViewer {
  /** Null for the bootstrap system account. */
  employeeId: string | null;
  /** HR, a Board member or a System Administrator (`canEditReportingLines`). */
  canEditReportingLines: boolean;
  /** HR or a System Administrator: separated people's cards open. */
  canSeeSeparatedPeople: boolean;
}

/** What the page already knows about the person, for the title while the card loads. */
export interface PersonPreview {
  name: string;
  positionName: string | null;
}

export function PersonInspector({
  open,
  onOpenChange,
  personId,
  session,
  returnFocus,
  onOpenPerson,
  preview,
  boardDepartmentCode,
  viewer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  personId: string | null;
  /** Changes on every open: a fresh card and form. */
  session: number;
  returnFocus: RefObject<HTMLElement | null>;
  /** Opens another person's card here ("Reports to", "Direct reports"). */
  onOpenPerson: (id: string) => void;
  preview: PersonPreview | null;
  /** The Board's department code: the "No supervisor" hint is for everyone outside it. */
  boardDepartmentCode: string;
  viewer: PersonInspectorViewer;
}) {
  const { state, reload } = usePersonCard(personId, session);
  const card = state.status === 'done' ? state.card : null;
  const title = card?.name ?? preview?.name ?? 'Directory card';
  const position = card ? card.positionName : (preview?.positionName ?? null);

  return (
    <InspectorPanel
      open={open}
      onOpenChange={onOpenChange}
      eyebrow="Directory card"
      title={title}
      description={position ?? undefined}
      returnFocus={returnFocus}
      closeLabel="Close card"
    >
      {personId ? (
        <PersonCardBody
          // A new person (or a new open) gets a fresh form; a reload keeps it.
          key={`${personId}:${session}`}
          state={state}
          onReload={reload}
          onOpenPerson={onOpenPerson}
          boardDepartmentCode={boardDepartmentCode}
          viewer={viewer}
        />
      ) : null}
    </InspectorPanel>
  );
}

function PersonCardBody({
  state,
  onReload,
  onOpenPerson,
  boardDepartmentCode,
  viewer,
}: {
  state: CardState;
  onReload: () => void;
  onOpenPerson: (id: string) => void;
  boardDepartmentCode: string;
  viewer: PersonInspectorViewer;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  if (state.status === 'idle' || state.status === 'loading') {
    return (
      <div role="status" className="flex flex-col gap-4">
        <span className="sr-only">Loading the card…</span>
        <div className="flex items-center gap-3">
          <Skeleton className="size-12 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
        <div className="flex flex-col gap-3 rounded-card bg-surface p-4 shadow-card">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-4 w-2/3" />
        </div>
        <div className="flex flex-col gap-2 rounded-card bg-surface p-4 shadow-card">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-2/5" />
        </div>
      </div>
    );
  }
  if (state.status === 'gone') {
    return (
      <ErrorState
        variant="inline"
        headingLevel={3}
        title="This person isn’t in the directory"
        description="They may have left the company, or the link is wrong. Close this to see the list."
      />
    );
  }
  if (state.status === 'error') {
    return (
      <ErrorState
        variant="inline"
        headingLevel={3}
        title="Couldn’t load the card"
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

  const { card, refreshing } = state;
  const isOwn = viewer.employeeId !== null && viewer.employeeId === card.id;
  const canOpen = (link: DirectoryPersonLink) => !link.inactive || viewer.canSeeSeparatedPeople;

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

      <section aria-label="Details" className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <PersonAvatar initials={card.initials} size="lg" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-headline break-words">{card.name}</span>
              {card.inactive ? <Badge>Inactive</Badge> : null}
              {isOwn ? <Badge>You</Badge> : null}
            </span>
            <span className="numeric text-footnote text-text-secondary">{card.employeeNumber}</span>
          </div>
        </div>
        <dl className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
          <DetailRow term="Position">{card.positionName ?? '—'}</DetailRow>
          <DetailRow term="Department">{card.departmentName ?? '—'}</DetailRow>
          <DetailRow term="Email">
            {card.email ? (
              <a
                href={`mailto:${card.email}`}
                className="inline-flex min-h-11 items-center gap-1.5 font-medium break-all text-accent underline-offset-2 hover:underline"
              >
                <Mail aria-hidden="true" className="size-4 shrink-0" />
                {card.email}
              </a>
            ) : (
              '—'
            )}
          </DetailRow>
        </dl>
      </section>

      {editing ? (
        <ReportingLinesForm
          card={card}
          showNoSupervisorHint={card.departmentCode !== boardDepartmentCode}
          onCancel={() => setEditing(false)}
          onSaved={(changed) => {
            setEditing(false);
            setNotice(
              changed ? 'Reporting lines saved.' : 'Nothing changed, so nothing was saved.',
            );
            onReload();
            // The list, the chart and Home's team tile show reporting lines too.
            if (changed) router.refresh();
          }}
          onReload={() => {
            setEditing(false);
            setNotice(null);
            onReload();
            router.refresh();
          }}
        />
      ) : (
        <PeopleSection
          title="Reports to"
          people={card.reportingTo}
          empty="No supervisor"
          canOpen={canOpen}
          onOpenPerson={onOpenPerson}
          action={
            card.canEditReportingLines ? (
              <Button
                variant="plain"
                onClick={() => {
                  setNotice(null);
                  setEditing(true);
                }}
              >
                <PencilLine aria-hidden="true" className="size-4.5" />
                Edit reporting lines
              </Button>
            ) : null
          }
          footer={
            viewer.canEditReportingLines && isOwn
              ? OWN_REPORTING_LINES
              : viewer.canEditReportingLines && card.inactive
                ? 'Reporting lines can’t be changed here for someone who has left.'
                : null
          }
        />
      )}

      <PeopleSection
        title="Direct reports"
        people={card.directReports}
        empty="No direct reports"
        canOpen={canOpen}
        onOpenPerson={onOpenPerson}
      />
    </div>
  );
}

function DetailRow({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 px-4 py-2.5">
      <dt className="text-footnote text-text-secondary">{term}</dt>
      <dd className="text-subheadline break-words">{children}</dd>
    </div>
  );
}

/** "Reports to" or "Direct reports": each person a button that opens their card here. */
function PeopleSection({
  title,
  people,
  empty,
  canOpen,
  onOpenPerson,
  action,
  footer,
}: {
  title: string;
  people: DirectoryPersonLink[];
  empty: string;
  canOpen: (link: DirectoryPersonLink) => boolean;
  onOpenPerson: (id: string) => void;
  action?: ReactNode;
  footer?: string | null;
}) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-2">
      <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 pl-4">
        <h3 id={titleId} className="text-footnote font-semibold text-text-secondary">
          {title}
        </h3>
        {action}
      </div>
      <div className="overflow-hidden rounded-card bg-surface shadow-card">
        {people.length === 0 ? (
          <p className="flex min-h-11 items-center gap-3 px-4 py-3 text-subheadline text-text-secondary">
            {title === 'Reports to' ? (
              <UserRound aria-hidden="true" className="size-4.5 shrink-0" />
            ) : (
              <Users aria-hidden="true" className="size-4.5 shrink-0" />
            )}
            {empty}
          </p>
        ) : (
          <ul aria-labelledby={titleId} className="flex flex-col divide-y divide-separator">
            {people.map((person) => (
              <li key={person.id}>
                <PersonLinkRow person={person} canOpen={canOpen(person)} onOpen={onOpenPerson} />
              </li>
            ))}
          </ul>
        )}
      </div>
      {footer ? <p className="px-4 text-footnote text-text-secondary">{footer}</p> : null}
    </section>
  );
}

function PersonLinkRow({
  person,
  canOpen,
  onOpen,
}: {
  person: DirectoryPersonLink;
  canOpen: boolean;
  onOpen: (id: string) => void;
}) {
  const detail = [person.positionName, person.departmentName].filter(Boolean).join(' · ');
  const content = (
    <>
      <PersonAvatar initials={person.initials} size="sm" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-subheadline break-words">{person.name}</span>
          {person.inactive ? <Badge>Inactive</Badge> : null}
        </span>
        <span className="text-footnote break-words text-text-secondary">
          <span className="numeric">{person.employeeNumber}</span>
          {detail ? ` · ${detail}` : null}
        </span>
      </span>
    </>
  );
  const className = 'flex min-h-14 w-full items-center gap-3 px-4 py-2 text-left';
  if (!canOpen) return <div className={className}>{content}</div>;
  return (
    <button
      type="button"
      onClick={() => onOpen(person.id)}
      aria-label={`${person.name}${person.inactive ? ', inactive' : ''}, open card`}
      className={cn(
        className,
        'cursor-pointer transition-colors duration-fast hover:bg-bg-grouped/60',
        'focus-visible:outline-offset-[-2px]',
      )}
    >
      {content}
    </button>
  );
}

// --- Editing reporting lines -------------------------------------------------------------------

/** The picker's error: a field error on `reportingTo` (or one of its items). */
function supervisorError(fieldErrors: FieldErrors): string | undefined {
  const key = Object.keys(fieldErrors).find(
    (name) => name === 'reportingTo' || name.startsWith('reportingTo.'),
  );
  return key ? fieldErrors[key] : undefined;
}

function ReportingLinesForm({
  card,
  showNoSupervisorHint,
  onCancel,
  onSaved,
  onReload,
}: {
  card: DirectoryCard;
  showNoSupervisorHint: boolean;
  onCancel: () => void;
  onSaved: (changed: boolean) => void;
  /** Leaves the form and loads the card again (after the stale-form message). */
  onReload: () => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  // What the card opened with, in order: sent back so a stale card is refused.
  const [expected] = useState(() => card.reportingTo.map((supervisor) => supervisor.id));
  const [supervisors, setSupervisors] = useState<PickedSupervisor[]>(() =>
    card.reportingTo.map((supervisor) => ({
      id: supervisor.id,
      name: supervisor.name,
      employeeNumber: supervisor.employeeNumber,
      active: !supervisor.inactive,
    })),
  );
  const [pickerError, setPickerError] = useState<string | undefined>(undefined);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const stale = formError === reportingLinesChangedMessage(card.name);

  useShortcut(SAVE, () => submitFormFromShortcut(formRef.current));

  // Opening the editor moves focus to its first control.
  useEffect(() => {
    formRef.current?.querySelector<HTMLElement>('button:not([disabled])')?.focus();
  }, []);

  async function submit(form: HTMLFormElement) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setFormError(null);
    setPickerError(undefined);
    try {
      const result = await setReportingLinesAction(null, new FormData(form));
      if (result.ok) {
        onSaved(result.data.changed);
        return;
      }
      const fieldMessage = supervisorError(result.fieldErrors);
      if (fieldMessage) setPickerError(fieldMessage);
      else setFormError(result.formError ?? Object.values(result.fieldErrors)[0] ?? SAVE_FAILED);
    } catch {
      setFormError(SAVE_FAILED);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  return (
    <form
      ref={formRef}
      noValidate
      aria-label={`Reporting lines for ${card.name}`}
      onSubmit={(event) => {
        event.preventDefault();
        void submit(event.currentTarget);
      }}
      className="flex flex-col gap-3"
    >
      <input type="hidden" name="employeeId" value={card.id} />
      {expected.map((id) => (
        <input key={id} type="hidden" name="expected" value={id} />
      ))}
      <FormAlert message={formError} />
      {stale ? (
        <Button type="button" variant="tinted" onClick={onReload} className="self-start">
          <RotateCw aria-hidden="true" className="size-4.5" />
          Reload
        </Button>
      ) : null}
      <FormSection title="Reports to">
        <SupervisorPicker
          value={supervisors}
          onChange={(next) => {
            setSupervisors(next);
            setPickerError(undefined);
          }}
          excludeEmployeeId={card.id}
          showNoSupervisorHint={showNoSupervisorHint}
          searchAction={searchReportingLineSupervisorsAction}
          disabled={pending}
          error={pickerError}
        />
      </FormSection>
      <div className="flex flex-col gap-2 sm:flex-row-reverse sm:flex-wrap sm:justify-start">
        <Button
          type="submit"
          loading={pending}
          disabled={stale}
          aria-keyshortcuts={ariaKeyShortcuts(SAVE)}
          className="pr-3"
        >
          Save
          <ShortcutHint keys={SAVE} tone="on-fill" className="hidden sm:inline-flex" />
        </Button>
        <Button type="button" variant="secondary" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
