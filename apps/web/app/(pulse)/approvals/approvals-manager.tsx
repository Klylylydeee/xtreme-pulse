'use client';

import { useCallback, useRef, useState, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { CircleCheck, ListChecks } from 'lucide-react';
import { type ApprovalDecision, formatDateTime, formatRelativeTime } from '@pulse/core';
import type { ApprovalDetail, ApprovalPage, ApprovalRow } from '@pulse/core/server';
import { cn } from '@pulse/ui';
import { Button } from '@pulse/ui/components/button';
import { EmptyState } from '@pulse/ui/components/empty-state';
import { IconTile } from '@pulse/ui/components/icon-tile';
import { InspectorLayout, InspectorPanel } from '@pulse/ui/components/inspector-panel';
import { PageHeader } from '@pulse/ui/components/page-header';
import { SegmentedControl } from '@pulse/ui/components/segmented-control';
import { FormAlert } from '@/components/form-alert';
import { listApprovalsAction } from '@/lib/actions/approvals';
import { moduleDisplay } from '@/lib/module-labels';
import {
  ApprovalInspectorBody,
  ApprovalStatusPill,
  type InspectorNotice,
  progressLabel,
  SentAsAdministratorHint,
  useApprovalDetail,
} from './approval-inspector';

// Spec: docs/modules/core.md#approvals-list — the Approvals list (build step 1.9). Two segments:
// Waiting for you (pending requests whose pending step names the user, newest submitted first) and
// Decided (requests where the user's part in a step ended, even while a later step is pending,
// newest first by when it ended; a pending one shows its status and step), with "Load more"
// over the services' keyset cursors. Each row shows the type, the title, the requester, when it
// was submitted, the step, an all-of step's progress and "Sent to you as System Administrator". A
// row opens the inspector (a full-height sheet on a phone), and so does `?request=<id>`, the link
// every approval notification carries. After a decision the row is refreshed from the server: it
// leaves Waiting for you once nothing more is asked of the user.

export type ApprovalsView = 'waiting' | 'decided';

const LOAD_MORE_FAILED = 'More requests couldn’t load. Check your connection and try again.';

const DECIDED_MESSAGES = {
  approve: 'You approved this request.',
  return: 'You returned this request.',
  reject: 'You rejected this request.',
} as const satisfies Record<ApprovalDecision, string>;

/** A request's row, from its inspector detail (the detail holds every row field). */
function rowOf(detail: ApprovalDetail): ApprovalRow {
  return {
    id: detail.id,
    type: detail.type,
    typeLabel: detail.typeLabel,
    module: detail.module,
    record: detail.record,
    title: detail.title,
    summary: detail.summary,
    href: detail.href,
    requester: detail.requester,
    status: detail.status,
    submittedAt: detail.submittedAt,
    settledAt: detail.settledAt,
    step: detail.step,
    progress: detail.progress,
    sentToYouAsSystemAdministrator: detail.sentToYouAsSystemAdministrator,
    version: detail.version,
  };
}

/** Sets or drops `?request=` in the address bar without a navigation (keeping `?view=`). */
function replaceRequestParam(pathname: string, requestId: string | null) {
  const params = new URLSearchParams(window.location.search);
  if (requestId) params.set('request', requestId);
  else params.delete('request');
  const query = params.toString();
  window.history.replaceState(null, '', `${pathname}${query ? `?${query}` : ''}`);
}

// --- Rows --------------------------------------------------------------------------------------

function ApprovalRowButton({
  row,
  view,
  reference,
  selected,
  onOpen,
}: {
  row: ApprovalRow;
  view: ApprovalsView;
  reference: Date;
  selected: boolean;
  onOpen: (row: ApprovalRow, trigger: HTMLElement) => void;
}) {
  const { Icon } = moduleDisplay(row.module);
  const submittedAt = new Date(row.submittedAt);
  const submitted = formatRelativeTime(submittedAt, reference);
  const showStatus = view === 'decided';
  const stepText = row.status === 'pending' ? row.step.label : null;
  const label = [
    `${row.typeLabel}: ${row.title}`,
    `from ${row.requester.name}`,
    `submitted ${submitted}`,
    showStatus ? row.status : null,
    stepText ? `at ${stepText}` : null,
    row.progress && row.status === 'pending' ? progressLabel(row.progress) : null,
    row.sentToYouAsSystemAdministrator ? 'sent to you as System Administrator' : null,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <li className="rounded-card bg-surface shadow-card md:rounded-none md:bg-transparent md:shadow-none">
      <button
        type="button"
        aria-current={selected || undefined}
        aria-label={label}
        onClick={(event) => onOpen(row, event.currentTarget)}
        className={cn(
          'flex min-h-18 w-full cursor-pointer items-start gap-3 rounded-card px-4 py-3 text-left transition-colors duration-fast',
          'hover:bg-bg-grouped/60 aria-[current=true]:bg-accent-subtle/60',
          'focus-visible:outline-offset-[-2px] md:rounded-none md:px-5',
        )}
      >
        <IconTile className="size-11 shrink-0 rounded-xl [&_svg]:size-5">
          <Icon strokeWidth={1.75} />
        </IconTile>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-footnote font-medium text-text-secondary">{row.typeLabel}</span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 text-subheadline font-semibold break-words">{row.title}</span>
            {showStatus ? <ApprovalStatusPill status={row.status} /> : null}
          </span>
          <span className="text-footnote break-words text-text-secondary">
            {row.requester.name}
            {stepText ? ` · ${stepText}` : null}
            {row.progress && row.status === 'pending' ? (
              <span className="numeric"> · {progressLabel(row.progress)}</span>
            ) : null}
          </span>
          {row.sentToYouAsSystemAdministrator ? (
            <SentAsAdministratorHint className="mt-1 self-start" />
          ) : null}
        </span>
        <time
          dateTime={submittedAt.toISOString()}
          title={formatDateTime(submittedAt)}
          className="numeric shrink-0 pt-0.5 text-footnote text-text-secondary"
          suppressHydrationWarning
        >
          {submitted}
        </time>
      </button>
    </li>
  );
}

// --- The page ----------------------------------------------------------------------------------

export function ApprovalsManager({
  view,
  initialPage,
  waitingCount,
  reference,
}: {
  view: ApprovalsView;
  /** The segment's first page, from the server. */
  initialPage: ApprovalPage;
  /** How many requests wait for the user (the sidebar badge's count). */
  waitingCount: number;
  /** "Now" for the relative times, the same for every row. */
  reference: Date;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [switching, startSwitching] = useTransition();

  // The list: the first page from the server, then the pages "Load more" adds.
  const [rows, setRows] = useState(initialPage.rows);
  const [nextCursor, setNextCursor] = useState(initialPage.nextCursor);
  const [loadedMore, setLoadedMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  // A fresh first page from the server (after a decision, or a refresh) replaces the list, unless
  // more pages were loaded: then the rows already shown are kept, refreshed one by one.
  const [lastInitial, setLastInitial] = useState(initialPage);
  if (initialPage !== lastInitial) {
    setLastInitial(initialPage);
    if (!loadedMore) {
      setRows(initialPage.rows);
      setNextCursor(initialPage.nextCursor);
    }
  }

  // The inspector. The id is kept while it closes, so its content doesn't change mid-animation.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState(0);
  const [notice, setNotice] = useState<InspectorNotice | null>(null);
  const rowRef = useRef<HTMLElement | null>(null);
  // Requests the user just decided (or tried to): they leave Waiting for you once nothing more is
  // asked of the user.
  const [decided, setDecided] = useState<ReadonlySet<string>>(() => new Set());

  const onLoaded = useCallback(
    (detail: ApprovalDetail) => {
      const leaves =
        view === 'waiting' && decided.has(detail.id) && detail.allowedDecisions.length === 0;
      setRows((current) =>
        leaves
          ? current.filter((row) => row.id !== detail.id)
          : current.map((row) => (row.id === detail.id ? rowOf(detail) : row)),
      );
    },
    [view, decided],
  );
  const { state, reload } = useApprovalDetail(selectedId, session, onLoaded);

  function openRequest(requestId: string) {
    setSelectedId(requestId);
    setSession((count) => count + 1);
    setNotice(null);
    setOpen(true);
  }

  // `?request=<id>` opens that request: on first load, and whenever a link sets it again.
  const requestParam = searchParams.get('request');
  const [seenRequestParam, setSeenRequestParam] = useState<string | null>(null);
  if (requestParam !== seenRequestParam) {
    setSeenRequestParam(requestParam);
    if (requestParam) {
      openRequest(requestParam);
    }
  }

  function openRow(row: ApprovalRow, trigger: HTMLElement) {
    rowRef.current = trigger;
    openRequest(row.id);
  }

  /** Closing drops `?request=` from the address, so a reload doesn't reopen it. */
  function changeOpen(next: boolean) {
    setOpen(next);
    if (!next && new URLSearchParams(window.location.search).has('request')) {
      replaceRequestParam(pathname, null);
    }
  }

  function changeView(next: ApprovalsView) {
    startSwitching(() => {
      router.push(next === 'decided' ? `${pathname}?view=decided` : pathname, { scroll: false });
    });
  }

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const result = await listApprovalsAction(null, { view, cursor: nextCursor });
      if (!result.ok) {
        setMoreError(result.formError ?? LOAD_MORE_FAILED);
        return;
      }
      setRows((current) => {
        const shown = new Set(current.map((row) => row.id));
        return [...current, ...result.data.rows.filter((row) => !shown.has(row.id))];
      });
      setNextCursor(result.data.nextCursor);
      setLoadedMore(true);
    } catch {
      setMoreError(LOAD_MORE_FAILED);
    } finally {
      setLoadingMore(false);
    }
  }

  function markDecided(requestId: string) {
    setDecided((current) => new Set(current).add(requestId));
  }

  const selectedRow = selectedId ? (rows.find((row) => row.id === selectedId) ?? null) : null;
  const shown = state.status === 'done' ? state.detail : selectedRow;

  return (
    <>
      <PageHeader
        title="Approvals"
        description={
          waitingCount > 0 ? (
            <span className="numeric">{waitingCount} waiting for you</span>
          ) : (
            'Nothing is waiting for you.'
          )
        }
      />
      <SegmentedControl<ApprovalsView>
        label="Show"
        track="page"
        value={view}
        options={[
          { value: 'waiting', label: 'Waiting for you' },
          { value: 'decided', label: 'Decided' },
        ]}
        onValueChange={changeView}
        disabled={switching}
        className="w-full sm:w-auto"
        fullWidth
      />

      <InspectorLayout>
        <div
          className={cn('flex min-w-0 flex-1 flex-col gap-4', switching && 'opacity-60')}
          aria-busy={switching || undefined}
        >
          {rows.length === 0 ? (
            view === 'waiting' ? (
              <EmptyState
                icon={<CircleCheck strokeWidth={1.75} />}
                title="Nothing is waiting for you"
                description="Requests you’re asked to approve show up here, and you get a notification for each one."
                action={
                  <Button variant="tinted" onClick={() => changeView('decided')}>
                    See decided requests
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={<ListChecks strokeWidth={1.75} />}
                title="No decided requests yet"
                description="Requests you approve, return or reject show up here, with the ones settled while you were asked."
                action={
                  <Button variant="tinted" onClick={() => changeView('waiting')}>
                    See what’s waiting
                  </Button>
                }
              />
            )
          ) : (
            <>
              <ul
                aria-label={view === 'waiting' ? 'Waiting for you' : 'Decided'}
                className="flex flex-col gap-2 md:gap-0 md:divide-y md:divide-separator md:overflow-hidden md:rounded-card md:bg-surface md:shadow-card"
              >
                {rows.map((row) => (
                  <ApprovalRowButton
                    key={row.id}
                    row={row}
                    view={view}
                    reference={reference}
                    selected={open && row.id === selectedId}
                    onOpen={openRow}
                  />
                ))}
              </ul>
              <div className="flex flex-col items-stretch gap-2 sm:items-center">
                <p role="status" className="numeric text-center text-footnote text-text-secondary">
                  {nextCursor
                    ? `Showing the newest ${rows.length}`
                    : `${rows.length} ${rows.length === 1 ? 'request' : 'requests'}`}
                </p>
                <FormAlert message={moreError} />
                {nextCursor ? (
                  <Button
                    variant="tinted"
                    loading={loadingMore}
                    onClick={() => void loadMore()}
                    className="w-full sm:w-auto"
                  >
                    {moreError ? 'Try again' : 'Load more'}
                  </Button>
                ) : null}
              </div>
            </>
          )}
        </div>

        <InspectorPanel
          open={open}
          onOpenChange={changeOpen}
          eyebrow={shown?.typeLabel}
          title={shown?.title ?? 'Request'}
          description={shown ? `From ${shown.requester.name}` : undefined}
          returnFocus={rowRef}
          closeLabel="Close request"
        >
          {selectedId ? (
            <ApprovalInspectorBody
              state={state}
              notice={notice}
              onReload={reload}
              onOpenRequest={(requestId) => {
                replaceRequestParam(pathname, requestId);
                setSeenRequestParam(requestId);
                openRequest(requestId);
              }}
              onDecided={(decision, detail) => {
                markDecided(detail.id);
                setNotice({ tone: 'success', message: DECIDED_MESSAGES[decision] });
                reload();
              }}
              onRefused={(message) => {
                if (selectedId) markDecided(selectedId);
                setNotice({ tone: 'error', message });
                reload();
                // The waiting count may have changed elsewhere too.
                router.refresh();
              }}
            />
          ) : null}
        </InspectorPanel>
      </InspectorLayout>
    </>
  );
}
