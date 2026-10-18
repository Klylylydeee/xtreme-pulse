'use client';

import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowUpRight,
  Ban,
  CircleCheck,
  CircleDashed,
  CircleMinus,
  Clock,
  CornerUpLeft,
  History,
  Info,
  RotateCw,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import {
  APPROVAL_CHANGED_ELSEWHERE,
  APPROVAL_DECISION_LABELS,
  APPROVAL_REMARKS_MAX_LENGTH,
  APPROVAL_STATUS_LABELS,
  approvalHref,
  type ApprovalDecision,
  type ApprovalStatus,
  type ApprovalStepStatus,
  decideApprovalSchema,
  decisionNeedsRemarks,
  formatDateTime,
  isInternalHref,
} from '@pulse/core';
import type { ApprovalDetail, ApprovalStepView } from '@pulse/core/server';
import { cn } from '@pulse/ui';
import { Avatar } from '@pulse/ui/components/avatar';
import { Button } from '@pulse/ui/components/button';
import { ErrorState } from '@pulse/ui/components/error-state';
import { FormField, FormSection, Textarea } from '@pulse/ui/components/form';
import {
  ariaKeyShortcuts,
  ShortcutHint,
  submitFormFromShortcut,
  useShortcut,
} from '@pulse/ui/components/shortcut-hint';
import { Skeleton } from '@pulse/ui/components/skeleton';
import { FormAlert } from '@/components/form-alert';
import {
  type ApprovalInspectorDetail,
  decideApprovalAction,
  getApprovalAction,
} from '@/lib/actions/approvals';

// Spec: docs/modules/core.md#approvals-list — the inspector (a full-height sheet on a phone) for
// one request: where it stands, a link to the record, the decision form when the request waits for
// the user (Approve ⌘↵ / Ctrl+Enter; Return and, when the type allows it, Reject, each with
// required remarks shown inline), and every step with its approvers and their decisions. The
// service decides what the user may do (`allowedDecisions`); a decision it refuses (someone else
// settled the step, or the request changed since it loaded) shows the message and reloads. From
// step 2.2 the requester shows with their photo, and each approve decision says whether it was
// signed with an e-signature (its version, as text; the image is never shown here). From step 2.6
// (decision 264) a viewer with no e-signature sees "Approving needs your e-signature. Upload it in
// My record." above the buttons and a disabled Approve, while Return and Reject stay; a change
// request adds "Approving applies the change to <name>'s record" (the server builds both lines).

const APPROVE = ['mod', 'enter'] as const;
const LOAD_FAILED = 'The request couldn’t load. Check your connection and try again.';
const DECIDE_FAILED = 'Your decision wasn’t saved. Check your connection and try again.';
const NUMBER = new Intl.NumberFormat('en-PH');

// --- Loading -----------------------------------------------------------------------------------

export type ApprovalDetailState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'gone' }
  | { status: 'done'; detail: ApprovalInspectorDetail; refreshing: boolean };

/**
 * Loads request `id` for the inspector, again whenever `session` changes (a new open) or `reload`
 * is called. A reload keeps the loaded request on screen while it refreshes, so the decision form
 * and its remarks stay put. `onLoaded` gets each loaded request (to refresh its row in the list).
 */
export function useApprovalDetail(
  id: string | null,
  session: number,
  onLoaded: (detail: ApprovalDetail) => void,
): { state: ApprovalDetailState; reload: () => void } {
  const [state, setState] = useState<ApprovalDetailState>({ status: 'idle' });
  const [attempt, setAttempt] = useState(0);
  const onLoadedRef = useRef(onLoaded);
  useEffect(() => {
    onLoadedRef.current = onLoaded;
  }, [onLoaded]);

  // A new request (or a new open) starts from the skeleton; a reload keeps what is shown.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const key = id ? `${id}:${session}` : null;
  if (key !== loadedFor) {
    setLoadedFor(key);
    setState(id ? { status: 'loading' } : { status: 'idle' });
  }

  useEffect(() => {
    if (!id) return;
    let current = true;
    getApprovalAction(null, { id })
      .then((result) => {
        if (!current) return;
        if (!result.ok) setState({ status: 'error', message: result.formError ?? LOAD_FAILED });
        else if (!result.data) setState({ status: 'gone' });
        else {
          setState({ status: 'done', detail: result.data, refreshing: false });
          onLoadedRef.current(result.data);
        }
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

// --- Small parts -------------------------------------------------------------------------------

const STATUS_TONES = {
  pending: 'text-accent',
  approved: 'text-success-text',
  returned: 'text-warning-text',
  rejected: 'text-destructive-text',
} as const satisfies Record<ApprovalStatus, string>;

const STATUS_ICONS = {
  pending: Clock,
  approved: CircleCheck,
  returned: CornerUpLeft,
  rejected: Ban,
} as const satisfies Record<ApprovalStatus, unknown>;

/** A request's status: an icon and the word, in the status colour (never colour alone). */
export function ApprovalStatusPill({
  status,
  className,
}: {
  status: ApprovalStatus;
  className?: string;
}) {
  const Icon = STATUS_ICONS[status];
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-md bg-bg-grouped px-2 py-0.5 text-footnote font-semibold whitespace-nowrap',
        STATUS_TONES[status],
        className,
      )}
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0" strokeWidth={2} />
      {APPROVAL_STATUS_LABELS[status]}
    </span>
  );
}

/** "Sent to you as System Administrator": the step was routed to the System Administrator. */
export function SentAsAdministratorHint({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md bg-accent-subtle px-2 py-0.5 text-footnote font-medium text-accent',
        className,
      )}
    >
      <ShieldCheck aria-hidden="true" className="size-3.5 shrink-0" strokeWidth={2} />
      Sent to you as System Administrator
    </span>
  );
}

/** "1 of 2 approved", for an all-of step. */
export function progressLabel(progress: { approved: number; required: number }): string {
  return `${progress.approved} of ${progress.required} approved`;
}

const STEP_STATUS = {
  waiting: { label: 'Not started', Icon: CircleDashed, tone: 'text-text-secondary' },
  pending: { label: 'Waiting', Icon: Clock, tone: 'text-accent' },
  approved: { label: 'Approved', Icon: CircleCheck, tone: 'text-success-text' },
  returned: { label: 'Returned', Icon: CornerUpLeft, tone: 'text-warning-text' },
  rejected: { label: 'Rejected', Icon: Ban, tone: 'text-destructive-text' },
  skipped: { label: 'Skipped', Icon: CircleMinus, tone: 'text-text-secondary' },
} as const satisfies Record<ApprovalStepStatus, unknown>;

const DECISION_DISPLAY = {
  approve: { label: 'Approved', Icon: CircleCheck, tone: 'text-success-text' },
  return: { label: 'Returned', Icon: CornerUpLeft, tone: 'text-warning-text' },
  reject: { label: 'Rejected', Icon: Ban, tone: 'text-destructive-text' },
} as const satisfies Record<ApprovalDecision, unknown>;

function DetailRow({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 px-4 py-2.5">
      <dt className="text-footnote text-text-secondary">{term}</dt>
      <dd className="text-subheadline break-words">{children}</dd>
    </div>
  );
}

/** The requester's photo, or the initials of the first and last word of their name. */
function RequesterAvatar({ requester }: { requester: ApprovalDetail['requester'] }) {
  const words = requester.name.trim().split(/\s+/);
  return (
    <Avatar
      size="sm"
      firstName={words[0]}
      lastName={words.length > 1 ? words[words.length - 1] : null}
      photoUrl={requester.photoUrl}
    />
  );
}

// --- The inspector body ------------------------------------------------------------------------

/** What the page shows above the request after a decision, or when one was refused. */
export type InspectorNotice = { tone: 'success' | 'error'; message: string };

export function ApprovalInspectorBody({
  state,
  notice,
  onReload,
  onOpenRequest,
  onDecided,
  onRefused,
}: {
  state: ApprovalDetailState;
  notice: InspectorNotice | null;
  onReload: () => void;
  /** Opens another request here (the one this follows). */
  onOpenRequest: (requestId: string) => void;
  /** The decision was saved. */
  onDecided: (decision: ApprovalDecision, detail: ApprovalDetail) => void;
  /** The service refused the decision with `message` (settled elsewhere, changed, not allowed). */
  onRefused: (message: string) => void;
}) {
  if (state.status === 'idle' || state.status === 'loading') {
    return (
      <div role="status" className="flex flex-col gap-4">
        <span className="sr-only">Loading the request…</span>
        <div className="flex flex-col gap-2 rounded-card bg-surface p-4 shadow-card">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-4 w-1/2" />
        </div>
        <Skeleton className="h-11 w-full rounded-lg" />
        <div className="flex flex-col gap-2 rounded-card bg-surface p-4 shadow-card">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-3 w-2/3" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      </div>
    );
  }
  if (state.status === 'gone') {
    return (
      <ErrorState
        variant="inline"
        headingLevel={3}
        title="This request isn’t available"
        description="It may not exist, or it isn’t one you were asked to approve or sent yourself. Close this to see your list."
      />
    );
  }
  if (state.status === 'error') {
    return (
      <ErrorState
        variant="inline"
        headingLevel={3}
        title="Couldn’t load the request"
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

  const { detail, refreshing } = state;
  return (
    <div className="flex flex-col gap-5" aria-busy={refreshing || undefined}>
      <NoticeBanner notice={notice} onReload={onReload} refreshing={refreshing} />
      <RequestSummary detail={detail} onOpenRequest={onOpenRequest} />
      {detail.allowedDecisions.length > 0 ? (
        <DecisionForm
          // A new request gets a fresh form; a reload of the same one keeps the remarks typed.
          key={detail.id}
          detail={detail}
          onDecided={(decision) => onDecided(decision, detail)}
          onRefused={onRefused}
        />
      ) : null}
      <StepList steps={detail.steps} />
    </div>
  );
}

function NoticeBanner({
  notice,
  onReload,
  refreshing,
}: {
  notice: InspectorNotice | null;
  onReload: () => void;
  refreshing: boolean;
}) {
  // Both regions are always present, so a new message is announced as it appears.
  return (
    <>
      <div role="status" className="empty:hidden">
        {notice?.tone === 'success' ? (
          <p className="flex items-start gap-2 rounded-card bg-surface px-4 py-3 text-footnote font-medium text-success-text shadow-card">
            <CircleCheck aria-hidden="true" className="mt-px size-4 shrink-0" />
            <span>{notice.message}</span>
          </p>
        ) : null}
      </div>
      <div role="alert" className="empty:hidden">
        {notice?.tone === 'error' ? (
          <div className="flex flex-col gap-3 rounded-card bg-surface px-4 py-3 shadow-card">
            <p className="text-footnote font-medium text-destructive-text">{notice.message}</p>
            {notice.message === APPROVAL_CHANGED_ELSEWHERE ? (
              <Button
                variant="tinted"
                onClick={onReload}
                loading={refreshing}
                className="self-start"
              >
                <RotateCw aria-hidden="true" className="size-4.5" />
                Reload
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </>
  );
}

function RequestSummary({
  detail,
  onOpenRequest,
}: {
  detail: ApprovalDetail;
  onOpenRequest: (requestId: string) => void;
}) {
  const settled = detail.status !== 'pending';
  return (
    <section aria-label="Request" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <ApprovalStatusPill status={detail.status} />
        {detail.status === 'pending' ? (
          <span className="text-footnote text-text-secondary">
            At {detail.step.label}
            {detail.progress ? (
              <span className="numeric"> · {progressLabel(detail.progress)}</span>
            ) : null}
          </span>
        ) : null}
        {detail.sentToYouAsSystemAdministrator ? <SentAsAdministratorHint /> : null}
      </div>
      {detail.summary ? (
        <p className="rounded-card bg-surface px-4 py-3 text-subheadline whitespace-pre-wrap break-words shadow-card">
          {detail.summary}
        </p>
      ) : null}
      <dl className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
        <DetailRow term="Record">{detail.record.label}</DetailRow>
        <DetailRow term="Requested by">
          <span className="flex items-center gap-2">
            <RequesterAvatar requester={detail.requester} />
            <span className="min-w-0 break-words">{detail.requester.name}</span>
          </span>
        </DetailRow>
        <DetailRow term="Submitted">
          <time dateTime={new Date(detail.submittedAt).toISOString()} className="numeric">
            {formatDateTime(new Date(detail.submittedAt))}
          </time>
        </DetailRow>
        {settled && detail.settledAt ? (
          <DetailRow term={APPROVAL_STATUS_LABELS[detail.status]}>
            <time dateTime={new Date(detail.settledAt).toISOString()} className="numeric">
              {formatDateTime(new Date(detail.settledAt))}
            </time>
            {detail.settledBy ? ` by ${detail.settledBy.name}` : null}
          </DetailRow>
        ) : null}
      </dl>
      <div className="flex flex-wrap gap-2">
        {isInternalHref(detail.href) ? (
          <Button asChild variant="tinted">
            <Link href={detail.href}>
              Open {detail.record.label}
              <ArrowUpRight aria-hidden="true" className="size-4.5" />
            </Link>
          </Button>
        ) : null}
        {detail.previousRequestId ? (
          <Button asChild variant="plain">
            <a
              href={approvalHref(detail.previousRequestId)}
              onClick={(event) => {
                // A plain click opens it here, in the same segment; a modified click opens a tab.
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                if (detail.previousRequestId) onOpenRequest(detail.previousRequestId);
              }}
            >
              <History aria-hidden="true" className="size-4.5" />
              Earlier request
            </a>
          </Button>
        ) : null}
      </div>
    </section>
  );
}

// --- Deciding ----------------------------------------------------------------------------------

/** The remarks message for `decision`, from the shared schema (the server runs the same check). */
function remarksIssue(detail: ApprovalDetail, decision: ApprovalDecision, remarks: string) {
  const parsed = decideApprovalSchema.safeParse({
    requestId: detail.id,
    decision,
    remarks,
    version: detail.version,
  });
  if (parsed.success) return null;
  return parsed.error.issues.find((issue) => issue.path[0] === 'remarks')?.message ?? null;
}

type Mode = 'approve' | 'return' | 'reject';

function DecisionForm({
  detail,
  onDecided,
  onRefused,
}: {
  detail: ApprovalInspectorDetail;
  onDecided: (decision: ApprovalDecision) => void;
  onRefused: (message: string) => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const remarksRef = useRef<HTMLTextAreaElement>(null);
  const [mode, setMode] = useState<Mode>('approve');
  const [remarks, setRemarks] = useState('');
  const [remarksError, setRemarksError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const gateId = useId();

  const allowed = detail.allowedDecisions;
  // Step 2.6: with no e-signature on file, Approve shows disabled under the gate notice.
  const gate = detail.approveGate;
  const canApprove = allowed.includes('approve') && gate === null;
  const length = remarks.trim().length;
  const over = length > APPROVAL_REMARKS_MAX_LENGTH;
  const required = decisionNeedsRemarks(mode);

  useShortcut(APPROVE, () => submitFormFromShortcut(formRef.current), {
    enabled: mode === 'approve' && canApprove,
  });

  // Choosing Return or Reject shows the required remarks: move there to type them.
  useEffect(() => {
    if (mode !== 'approve') remarksRef.current?.focus();
  }, [mode]);

  function choose(next: Mode) {
    setMode(next);
    setRemarksError(null);
    setFormError(null);
  }

  async function submit() {
    if (busy.current) return;
    const issue = remarksIssue(detail, mode, remarks);
    if (issue) {
      setRemarksError(issue);
      remarksRef.current?.focus();
      return;
    }
    busy.current = true;
    setPending(true);
    setFormError(null);
    try {
      const result = await decideApprovalAction(null, {
        requestId: detail.id,
        decision: mode,
        remarks,
        version: detail.version,
      });
      if (result.ok) {
        onDecided(mode);
        return;
      }
      const fieldMessage = result.fieldErrors.remarks;
      if (fieldMessage) {
        setRemarksError(fieldMessage);
        remarksRef.current?.focus();
        return;
      }
      onRefused(result.formError ?? Object.values(result.fieldErrors)[0] ?? DECIDE_FAILED);
    } catch {
      setFormError(DECIDE_FAILED);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  const remarksLabel =
    mode === 'return'
      ? 'What needs fixing'
      : mode === 'reject'
        ? 'Why you’re rejecting it'
        : 'Remarks';

  return (
    <form
      ref={formRef}
      noValidate
      aria-label="Your decision"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className="flex flex-col gap-3"
    >
      <FormAlert message={formError} />
      <FormSection
        title="Your decision"
        footer={
          mode === 'approve'
            ? 'Optional when approving. Returning or rejecting needs remarks.'
            : mode === 'return'
              ? `${detail.requester.name} sees your remarks and can send it again.`
              : 'A rejected request is final. The requester sees your remarks.'
        }
      >
        <FormField
          label={remarksLabel}
          required={required}
          error={remarksError ?? undefined}
          hint={
            <span className={cn('numeric', over && 'font-medium text-destructive-text')}>
              {NUMBER.format(length)} of {NUMBER.format(APPROVAL_REMARKS_MAX_LENGTH)} characters
            </span>
          }
        >
          <Textarea
            ref={remarksRef}
            name="remarks"
            value={remarks}
            rows={mode === 'approve' ? 2 : 4}
            onChange={(event) => {
              setRemarks(event.target.value);
              if (remarksError) setRemarksError(null);
            }}
            disabled={pending}
            placeholder={mode === 'approve' ? 'Add a note (optional)' : undefined}
          />
        </FormField>
      </FormSection>

      {mode === 'approve' && detail.changeRequestNotice ? (
        <p className="flex items-start gap-2 px-4 text-footnote text-text-secondary">
          <Info aria-hidden="true" className="mt-px size-4 shrink-0" />
          <span>{detail.changeRequestNotice}</span>
        </p>
      ) : null}
      {mode === 'approve' && gate && allowed.includes('approve') ? (
        <p
          id={gateId}
          className="flex items-start gap-2 rounded-card bg-surface px-4 py-3 text-footnote font-medium text-warning-text shadow-card"
        >
          <TriangleAlert aria-hidden="true" className="mt-px size-4 shrink-0" />
          <span>
            {gate.notice}{' '}
            <Link
              href={gate.href}
              className="font-semibold text-accent underline-offset-2 hover:underline"
            >
              Open My record
            </Link>
          </span>
        </p>
      ) : null}
      {mode === 'approve' ? (
        <div className="flex flex-col gap-2 sm:flex-row-reverse sm:flex-wrap sm:justify-start">
          {canApprove ? (
            <Button
              type="submit"
              loading={pending}
              aria-keyshortcuts={ariaKeyShortcuts(APPROVE)}
              className="pr-3"
            >
              {APPROVAL_DECISION_LABELS.approve}
              <ShortcutHint keys={APPROVE} tone="on-fill" className="hidden sm:inline-flex" />
            </Button>
          ) : gate && allowed.includes('approve') ? (
            <Button type="button" disabled aria-describedby={gateId}>
              {APPROVAL_DECISION_LABELS.approve}
            </Button>
          ) : null}
          {allowed.includes('return') ? (
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={() => choose('return')}
            >
              <CornerUpLeft aria-hidden="true" className="size-4.5" />
              {APPROVAL_DECISION_LABELS.return}
            </Button>
          ) : null}
          {allowed.includes('reject') ? (
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={() => choose('reject')}
              className="text-destructive-text"
            >
              <Ban aria-hidden="true" className="size-4.5" />
              {APPROVAL_DECISION_LABELS.reject}
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-2 sm:flex-row-reverse sm:flex-wrap sm:justify-start">
          <Button
            type="submit"
            variant={mode === 'reject' ? 'destructive' : 'primary'}
            loading={pending}
          >
            {mode === 'reject' ? 'Reject request' : 'Return request'}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            onClick={() => choose('approve')}
          >
            Cancel
          </Button>
        </div>
      )}
    </form>
  );
}

// --- Steps -------------------------------------------------------------------------------------

function StepList({ steps }: { steps: ApprovalStepView[] }) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-2">
      <h3 id={titleId} className="px-4 text-footnote font-semibold text-text-secondary">
        Steps
      </h3>
      <ol className="flex flex-col gap-2">
        {steps.map((step) => (
          <StepCard key={step.index} step={step} total={steps.length} />
        ))}
      </ol>
    </section>
  );
}

function StepCard({ step, total }: { step: ApprovalStepView; total: number }) {
  const status = STEP_STATUS[step.status];
  const settledStep = step.status !== 'waiting' && step.status !== 'pending';
  const approved = new Set(
    step.approvers
      .filter((approver) => approver.decision?.decision === 'approve')
      .map((approver) => approver.userId),
  ).size;
  const members = step.approvers.filter((approver) => !approver.asSystemAdministrator).length;
  const required =
    members + (step.approvers.some((approver) => approver.asSystemAdministrator) ? 1 : 0);
  const rule =
    step.rule === 'all'
      ? `Everyone approves · ${approved} of ${required} approved`
      : 'Any one approves';

  return (
    <li className="flex flex-col overflow-hidden rounded-card bg-surface shadow-card">
      <div className="flex items-start gap-3 px-4 py-3">
        <span
          aria-hidden="true"
          className="numeric inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-bg-grouped text-footnote font-semibold text-text-secondary"
        >
          {step.index + 1}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h4 className="text-subheadline font-semibold break-words">
            <span className="sr-only">
              Step {step.index + 1} of {total}:{' '}
            </span>
            {step.label}
          </h4>
          <p className="numeric text-footnote text-text-secondary">{rule}</p>
          {step.routedToSystemAdministrator ? (
            <p className="text-footnote text-text-secondary">
              Sent to the System Administrator, since the requester can’t approve their own request.
            </p>
          ) : null}
        </div>
        <span
          className={cn(
            'inline-flex shrink-0 items-center gap-1 text-footnote font-semibold whitespace-nowrap',
            status.tone,
          )}
        >
          <status.Icon aria-hidden="true" className="size-4 shrink-0" strokeWidth={2} />
          {status.label}
        </span>
      </div>
      {step.approvers.length > 0 ? (
        <ul className="flex flex-col divide-y divide-separator border-t border-separator">
          {step.approvers.map((approver) => (
            <li key={approver.userId} className="flex flex-col gap-1 px-4 py-2.5">
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="text-subheadline break-words">{approver.name}</span>
                  {approver.asSystemAdministrator ? (
                    <span className="text-footnote text-text-secondary">
                      as System Administrator
                    </span>
                  ) : null}
                </span>
                <ApproverOutcome
                  decision={approver.decision}
                  stepStatus={step.status}
                  settledStep={settledStep}
                />
              </div>
              {approver.decision?.decision === 'approve' ? (
                <p className="text-footnote text-text-secondary">
                  {approver.decision.signatureVersion !== null ? (
                    <>
                      Signed with e-signature, version{' '}
                      <span className="numeric">{approver.decision.signatureVersion}</span>
                    </>
                  ) : (
                    'Approved without an e-signature'
                  )}
                </p>
              ) : null}
              {approver.decision?.remarks ? (
                <p className="rounded-lg bg-bg-grouped px-3 py-2 text-footnote whitespace-pre-wrap break-words">
                  {approver.decision.remarks}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function ApproverOutcome({
  decision,
  stepStatus,
  settledStep,
}: {
  decision: ApprovalStepView['approvers'][number]['decision'];
  stepStatus: ApprovalStepStatus;
  settledStep: boolean;
}) {
  if (decision) {
    const shown = DECISION_DISPLAY[decision.decision];
    const at = new Date(decision.decidedAt);
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 text-footnote font-medium whitespace-nowrap',
          shown.tone,
        )}
      >
        <shown.Icon aria-hidden="true" className="size-4 shrink-0" strokeWidth={2} />
        {shown.label}
        <time dateTime={at.toISOString()} className="numeric font-normal text-text-secondary">
          · {formatDateTime(at)}
        </time>
      </span>
    );
  }
  const text =
    stepStatus === 'pending'
      ? 'Waiting'
      : stepStatus === 'waiting'
        ? 'Not asked yet'
        : settledStep
          ? 'No action needed'
          : '';
  return <span className="text-footnote whitespace-nowrap text-text-secondary">{text}</span>;
}
