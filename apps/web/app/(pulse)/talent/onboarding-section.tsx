'use client';

import { useEffect, useId, useState } from 'react';
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Clock,
  Lock,
  Package,
  RotateCw,
  ShieldCheck,
  UserX,
} from 'lucide-react';
import { formatDate } from '@pulse/core';
import {
  DOCUMENT_201_TYPE_LABELS,
  type EmployeeOnboardingView,
  type EmployeeRecordView,
  ONBOARDING_HIDDEN_ITEM_NOTICE,
  ONBOARDING_ITEM_STATE_LABELS,
  type OnboardingItemView,
  type OnboardingProgress,
  type OnboardingSettingsView,
  onboardingProgressText,
  type VerificationGroup,
} from '@pulse/talent';
import { cn } from '@pulse/ui';
import { Button } from '@pulse/ui/components/button';
import { ErrorState } from '@pulse/ui/components/error-state';
import { FormSection } from '@pulse/ui/components/form';
import { Skeleton } from '@pulse/ui/components/skeleton';
import {
  addOnboardingSettingsVersionAction,
  getEmployeeOnboardingAction,
  markVerifiedAction,
  setNoSupervisorConfirmationAction,
} from '@/lib/actions/talent';
import { FormSheet } from './employee-documents-sheets';
import { RecordSection } from './record-ui';

// Spec: docs/modules/talent.md#onboarding-checklist-and-change-requests-build-step-26 ("Screens",
// "Verification", "No supervisor"; decisions 259, 260, 265, 274 and 275 in docs/BUILD_PLAN.md) and
// SECURITY.md#sensitive-data — step 2.6's HR side of the onboarding checklist:
//
// - The inspector's **Onboarding** section (Talent Read): the employee's items and the items set
//   up by HR, each with its state as text (never color alone), their progress, and "Confirm no
//   supervisor" or "Withdraw" for HR, a Board member or the System Administrator. It loads on its
//   own beside the record (like the Work schedule), so a failure never blanks the record. An item
//   about a section the viewer can't see (government IDs, bank account, salary, 201 documents)
//   comes from the server as hidden, with any count that includes it, and shows "Visible to HR,
//   Accounting and the System Administrator" instead of its state.
// - **"Mark verified"** in the Government IDs and Payroll bank account headers, when the server's
//   `can` flags allow it (a verifier, the group complete and not yet verified, never one's own).
// - **"Required onboarding documents"** in Settings on /talent (Talent Owner).
//
// Every action checks access on the server again and answers only a `version`; nothing here holds
// a sensitive value.

const LOAD_FAILED = 'The onboarding checklist couldn’t load. Check your connection and try again.';
const SAVE_FAILED = 'That wasn’t saved. Check your connection and try again.';

// --- Loading -------------------------------------------------------------------------------------

export type OnboardingState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'done'; view: EmployeeOnboardingView | null };

/** The Onboarding section, loaded on its own beside the record, again on `reload`. */
export function useEmployeeOnboarding(id: string | null, session: number, separated: boolean) {
  const [state, setState] = useState<OnboardingState>({ status: 'loading' });
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
    getEmployeeOnboardingAction(null, { employeeId: id, separated })
      .then((result) => {
        if (!current) return;
        if (!result.ok) setState({ status: 'error', message: result.formError ?? LOAD_FAILED });
        else setState({ status: 'done', view: result.data });
      })
      .catch(() => {
        if (current) setState({ status: 'error', message: LOAD_FAILED });
      });
    return () => {
      current = false;
    };
  }, [id, session, attempt, separated]);

  return { state, reload: () => setAttempt((count) => count + 1) };
}

// --- The inspector's Onboarding section ----------------------------------------------------------

/** The section, or its skeleton or error while it loads. */
export function OnboardingBlock({
  state,
  onRetry,
  record,
  onChanged,
}: {
  state: OnboardingState;
  onRetry: () => void;
  /** The record, for the name and the `version` "No supervisor" sends back (HANDOFF item 112). */
  record: EmployeeRecordView;
  onChanged: (message: string) => void;
}) {
  if (state.status === 'loading') {
    return (
      <div role="status" className="flex flex-col gap-3 rounded-card bg-surface p-4 shadow-card">
        <span className="sr-only">Loading the onboarding checklist…</span>
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
        title="Couldn’t load the onboarding checklist"
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
  if (!state.view) return null;
  return <OnboardingSection view={state.view} record={record} onChanged={onChanged} />;
}

const STATE_DISPLAY = {
  done: { Icon: CircleCheck, tone: 'text-success-text' },
  todo: { Icon: CircleDashed, tone: 'text-text-secondary' },
  waitingForVerification: { Icon: Clock, tone: 'text-warning-text' },
  placeholder: { Icon: Package, tone: 'text-text-secondary' },
} as const;

/** An item's state: an icon and the words, so color is never the only signal. */
function ItemState({ item }: { item: OnboardingItemView }) {
  if (item.state === 'hidden') {
    return (
      <span className="inline-flex items-start gap-1.5 text-footnote text-text-secondary">
        <Lock aria-hidden="true" className="mt-px size-3.5 shrink-0" />
        {ONBOARDING_HIDDEN_ITEM_NOTICE}
      </span>
    );
  }
  const { Icon, tone } = STATE_DISPLAY[item.state];
  return (
    <span className={cn('inline-flex items-start gap-1.5 text-footnote font-semibold', tone)}>
      <Icon aria-hidden="true" className="mt-px size-3.5 shrink-0" strokeWidth={2} />
      {ONBOARDING_ITEM_STATE_LABELS[item.state]}
    </span>
  );
}

function ItemList({
  title,
  items,
  progress,
}: {
  title: string;
  items: OnboardingItemView[];
  progress: OnboardingProgress | null;
}) {
  const titleId = useId();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 px-4">
        <h4 id={titleId} className="text-footnote font-semibold text-text-secondary">
          {title}
        </h4>
        {progress ? (
          <span className="numeric text-footnote text-text-secondary">
            {onboardingProgressText(progress)}
          </span>
        ) : null}
      </div>
      <ul
        aria-labelledby={titleId}
        className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card"
      >
        {items.map((item) => (
          <li key={item.key} className="flex flex-col gap-1 px-4 py-2.5">
            <span className="text-subheadline break-words">{item.label}</span>
            <ItemState item={item} />
            {item.state !== 'hidden' && item.state !== 'placeholder' && item.detail ? (
              <span className="text-footnote break-words text-text-secondary">{item.detail}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function OnboardingSection({
  view,
  record,
  onChanged,
}: {
  view: EmployeeOnboardingView;
  record: EmployeeRecordView;
  onChanged: (message: string) => void;
}) {
  const { noSupervisor } = view;
  const name = `${record.identity.firstName} ${record.identity.lastName}`;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function setConfirmed(confirmed: boolean) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await setNoSupervisorConfirmationAction(null, {
        employeeId: record.employeeId,
        version: record.version,
        confirmed,
      });
      if (!result.ok) {
        setError(result.formError ?? Object.values(result.fieldErrors)[0] ?? SAVE_FAILED);
        return;
      }
      onChanged(confirmed ? '“No supervisor” confirmed.' : '“No supervisor” withdrawn.');
    } catch {
      setError(SAVE_FAILED);
    } finally {
      setPending(false);
    }
  }

  const showNoSupervisor =
    noSupervisor.confirmed !== null || noSupervisor.canConfirm || noSupervisor.canWithdraw;

  return (
    <RecordSection
      title="Onboarding"
      action={
        view.complete ? (
          <span className="inline-flex items-center gap-1.5 pr-4 text-footnote font-semibold text-success-text">
            <ShieldCheck aria-hidden="true" className="size-4 shrink-0" />
            Complete
          </span>
        ) : null
      }
    >
      <ItemList
        title={`${name}’s items`}
        items={view.employeeItems}
        progress={view.employeeProgress}
      />
      <ItemList title="Set up by HR" items={view.hrItems} progress={view.hrProgress} />
      {showNoSupervisor ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-2 rounded-card bg-surface px-4 py-3 shadow-card">
            <p className="flex items-start gap-2 text-subheadline">
              <UserX aria-hidden="true" className="mt-0.5 size-4.5 shrink-0 text-text-secondary" />
              <span>
                {noSupervisor.confirmed ? (
                  <>
                    No supervisor, confirmed by {noSupervisor.confirmed.byName} on{' '}
                    <span className="numeric">{formatDate(noSupervisor.confirmed.at)}</span>.
                  </>
                ) : (
                  'No active supervisor in Reports to.'
                )}
              </span>
            </p>
            {noSupervisor.canConfirm || noSupervisor.canWithdraw ? (
              <div className="flex flex-wrap gap-2">
                {noSupervisor.canConfirm ? (
                  <Button variant="tinted" loading={pending} onClick={() => setConfirmed(true)}>
                    Confirm no supervisor
                  </Button>
                ) : null}
                {noSupervisor.canWithdraw ? (
                  <Button variant="secondary" loading={pending} onClick={() => setConfirmed(false)}>
                    Withdraw
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
          <p className="px-4 text-footnote text-text-secondary">
            Confirm “No supervisor” only for someone who reports to no one, so their leave and
            offset time off go to HR. It no longer counts once a supervisor is set.
          </p>
          <div role="alert" className="empty:hidden">
            {error ? (
              <p className="flex items-start gap-2 px-4 text-footnote font-medium text-destructive-text">
                <CircleAlert aria-hidden="true" className="mt-px size-4 shrink-0" />
                <span>{error}</span>
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </RecordSection>
  );
}

// --- "Mark verified" -----------------------------------------------------------------------------

const GROUP_DONE: Record<VerificationGroup, string> = {
  governmentIds: 'Government IDs marked verified.',
  bankAccount: 'Payroll bank account marked verified.',
};
const GROUP_LABEL: Record<VerificationGroup, string> = {
  governmentIds: 'government IDs',
  bankAccount: 'payroll bank account',
};

/**
 * "Mark verified" in a section header: the server's `can` flag decides whether it shows. A refusal
 * goes to `onError` (the inspector shows it above the record).
 */
export function MarkVerifiedButton({
  record,
  group,
  onChanged,
  onError,
}: {
  record: EmployeeRecordView;
  group: VerificationGroup;
  onChanged: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [pending, setPending] = useState(false);
  const name = `${record.identity.firstName} ${record.identity.lastName}`;

  async function verify() {
    if (pending) return;
    setPending(true);
    try {
      const result = await markVerifiedAction(null, {
        employeeId: record.employeeId,
        version: record.version,
        group,
      });
      if (result.ok) onChanged(GROUP_DONE[group]);
      else onError(result.formError ?? Object.values(result.fieldErrors)[0] ?? SAVE_FAILED);
    } catch {
      onError(SAVE_FAILED);
    } finally {
      setPending(false);
    }
  }

  return (
    <Button
      variant="plain"
      loading={pending}
      onClick={verify}
      aria-label={`Mark ${name}’s ${GROUP_LABEL[group]} verified`}
    >
      <ShieldCheck aria-hidden="true" className="size-4.5" />
      Mark verified
    </Button>
  );
}

// --- Settings: "Required onboarding documents" ---------------------------------------------------

/** The Settings sheet for `talent.onboardingSettings` (Talent Owner). */
export function OnboardingDocumentsSheet({
  settings,
  onSaved,
}: {
  settings: OnboardingSettingsView;
  onSaved: (message: string) => void;
}) {
  const errorId = useId();
  return (
    <FormSheet
      title="Required onboarding documents"
      description="The 201 documents each employee uploads during onboarding: one unarchived, unexpired document of each type checked."
      action={addOnboardingSettingsVersionAction}
      submitLabel="Save"
      disabled={settings.changedToday}
      onSaved={() => onSaved('Required onboarding documents saved. They take effect today.')}
    >
      {(errors) => (
        <>
          {settings.changedToday ? (
            <p className="rounded-card bg-surface px-4 py-3 text-footnote font-medium text-text-secondary shadow-card">
              These documents were already changed today. Only one change can take effect per day:
              change them again tomorrow.
            </p>
          ) : null}
          <FormSection
            title="Document types"
            footer={
              settings.effectiveFrom
                ? `In effect since ${formatDate(settings.effectiveFrom)}. With none checked, the 201 documents item is done for everyone. A change takes effect today and is recorded in the audit log.`
                : 'The seeded list is in effect. With none checked, the 201 documents item is done for everyone. A change takes effect today and is recorded in the audit log.'
            }
          >
            <fieldset
              aria-describedby={errors.requiredDocumentTypes ? errorId : undefined}
              aria-invalid={errors.requiredDocumentTypes ? true : undefined}
              disabled={settings.changedToday}
              className="flex min-w-0 flex-col divide-y divide-separator"
            >
              <legend className="sr-only">Required onboarding documents</legend>
              {settings.options.map((type) => (
                <label
                  key={type}
                  className="flex min-h-12 cursor-pointer items-center gap-3 px-4 py-2 has-disabled:cursor-not-allowed"
                >
                  <input
                    type="checkbox"
                    name="requiredDocumentTypes"
                    value={type}
                    defaultChecked={settings.requiredDocumentTypes.includes(type)}
                    className="size-5 shrink-0 cursor-pointer accent-accent disabled:cursor-not-allowed"
                  />
                  <span className="text-body md:text-subheadline">
                    {DOCUMENT_201_TYPE_LABELS[type]}
                  </span>
                </label>
              ))}
            </fieldset>
          </FormSection>
          <div aria-live="polite" className="-mt-2 empty:hidden">
            {errors.requiredDocumentTypes ? (
              <p
                id={errorId}
                className="flex items-start gap-1.5 px-4 text-footnote font-medium text-destructive-text"
              >
                <CircleAlert aria-hidden="true" className="mt-px size-4 shrink-0" />
                <span>{errors.requiredDocumentTypes}</span>
              </p>
            ) : null}
          </div>
        </>
      )}
    </FormSheet>
  );
}
