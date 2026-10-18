'use client';

import { type ChangeEvent, type ReactNode, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Clock,
  FileUp,
  ImageUp,
  PenLine,
} from 'lucide-react';
import { fieldError } from '@pulse/core';
import {
  type EmployeeRecordView,
  type OnboardingItemKey,
  type OnboardingItemView,
  ONBOARDING_ITEM_STATE_LABELS,
  type OwnOnboardingView,
  type OwnSection,
} from '@pulse/talent';
import { cn } from '@pulse/ui';
import { Button, buttonVariants } from '@pulse/ui/components/button';
import { notifyOnboardingChanged } from '@/components/onboarding-progress';
import { setOwnPhotoAction, uploadOwnESignatureAction } from '@/lib/actions/talent-self';
import { onboardingDoneText, onboardingFraction } from '@/lib/onboarding';
import type { UploadHints } from '@/lib/upload-hints';
import { OwnSectionAction, SavedNotice, useOwnSheets } from '../me/own-record';
import type { OwnBrandOption, OwnSectionStates } from '../me/own-record-sheets';

// Spec: docs/modules/talent.md#onboarding-checklist-and-change-requests-build-step-26 ("Screens":
// `/talent/onboarding`) and docs/DESIGN_SYSTEM.md#feedback--motion ("Onboarding progress") — the
// checklist: "5 of 8 done" with a progress bar, then two inset grouped sections. **Your items**,
// each with its text status badge ("Done", "To do", "Waiting for HR to verify") and, while To do,
// the action that opens the same sheet as on My record (Edit, Upload, Add photo, Upload
// e-signature); and **Set up by HR**, status only, the assets row reading "Available when Pulse
// Supply is set up". "Skip for now" goes to Home: never a modal, never a blocked page.
//
// Every action acts on the signed-in user's own employee. After a change the page and the toolbar
// pill are refreshed from the server, which derives every state again.

const UPLOAD_FAILED = 'The image wasn’t uploaded. Check your connection and try again.';

/** The sheet each item opens. */
const ITEM_SECTIONS: Partial<Record<OnboardingItemKey, OwnSection>> = {
  personalInfo: 'personal',
  emergencyContact: 'personal',
  governmentIds: 'governmentIds',
  bankAccount: 'bankAccount',
};

const STATE_STYLES = {
  done: { tone: 'bg-accent-subtle text-accent', Icon: CircleCheck },
  todo: { tone: 'bg-bg-grouped text-text-secondary', Icon: CircleDashed },
  waitingForVerification: { tone: 'bg-bg-grouped text-warning-text', Icon: Clock },
} as const;

/** The item's state as a text badge with an icon: never color alone. */
function StateBadge({ state }: { state: OnboardingItemView['state'] }) {
  if (state === 'placeholder' || state === 'hidden') return null;
  const { tone, Icon } = STATE_STYLES[state];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-footnote font-medium whitespace-nowrap',
        tone,
      )}
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0" strokeWidth={2} />
      {ONBOARDING_ITEM_STATE_LABELS[state]}
    </span>
  );
}

export function OnboardingChecklist({
  onboarding,
  view,
  states,
  uploads,
  brands,
}: {
  onboarding: OwnOnboardingView;
  view: EmployeeRecordView;
  states: OwnSectionStates;
  uploads: UploadHints;
  brands: OwnBrandOption[];
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const sheets = useOwnSheets({
    view,
    states,
    brands,
    documentUpload: uploads.document,
    uploadTypes: onboarding.uploadTypes,
    onChanged: setNotice,
  });
  const progress = onboarding.employeeProgress;
  const yoursId = useId();
  const hrId = useId();

  function changed(message: string) {
    setNotice(message);
    sheets.refresh();
  }

  function actionFor(item: OnboardingItemView): ReactNode {
    if (item.state !== 'todo') return null;
    const section = ITEM_SECTIONS[item.key];
    if (section) {
      return (
        <OwnSectionAction
          section={section}
          states={states}
          onEdit={(next) => {
            setNotice(null);
            sheets.openSheet({ kind: 'section', section: next });
          }}
        />
      );
    }
    switch (item.key) {
      case 'documents':
        return (
          <Button
            variant="plain"
            className="px-3"
            onClick={() => {
              setNotice(null);
              sheets.openSheet({ kind: 'addDocument' });
            }}
          >
            <FileUp aria-hidden="true" className="size-4.5" />
            Upload
          </Button>
        );
      case 'photo':
        return (
          <ImagePickButton
            kind="photo"
            label="Add photo"
            accept={uploads.image.accept}
            onDone={() => changed('Photo added.')}
          />
        );
      case 'eSignature':
        return (
          <ImagePickButton
            kind="signature"
            label="Upload e-signature"
            accept={uploads.image.accept}
            onDone={(version) => changed(`E-signature uploaded as version ${version}.`)}
          />
        );
      default:
        return null;
    }
  }

  return (
    <div className="flex w-full max-w-2xl flex-col gap-5">
      <SavedNotice message={notice} />
      {progress ? (
        <section
          aria-label="Your progress"
          className="flex flex-col gap-3 rounded-card bg-surface p-4 shadow-card"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="numeric text-headline">{onboardingDoneText(progress)}</p>
            <Link href="/" className={buttonVariants({ variant: 'secondary' })}>
              Skip for now
              <ArrowRight aria-hidden="true" className="size-4.5" />
            </Link>
          </div>
          <div aria-hidden="true" className="h-2 overflow-hidden rounded-full bg-bg-grouped">
            <div
              className="h-full rounded-full bg-accent"
              style={{ width: `${Math.round(onboardingFraction(progress) * 100)}%` }}
            />
          </div>
          <p className="text-footnote text-text-secondary">
            {onboarding.showReminder
              ? 'Only a few actions wait on these items: approving needs your e-signature, for example. Everything else works now.'
              : 'Your items are done. HR verifies your government IDs and bank account before your first payroll.'}
          </p>
        </section>
      ) : null}

      <section aria-labelledby={yoursId} className="flex flex-col gap-2">
        <h2 id={yoursId} className="pl-4 text-footnote font-semibold text-text-secondary">
          Your items
        </h2>
        <ol className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
          {onboarding.employeeItems.map((item) => (
            <ItemRow key={item.key} item={item} action={actionFor(item)} />
          ))}
        </ol>
      </section>

      <section aria-labelledby={hrId} className="flex flex-col gap-2">
        <h2 id={hrId} className="pl-4 text-footnote font-semibold text-text-secondary">
          Set up by HR
        </h2>
        <ol className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
          {onboarding.hrItems.map((item) => (
            <ItemRow key={item.key} item={item} />
          ))}
        </ol>
        <p className="px-4 text-footnote text-text-secondary">
          HR completes these. Ask HR if something looks wrong.
        </p>
      </section>
      {sheets.host}
    </div>
  );
}

function ItemRow({ item, action }: { item: OnboardingItemView; action?: ReactNode }) {
  const detail =
    item.state === 'placeholder' ? ONBOARDING_ITEM_STATE_LABELS.placeholder : item.detail;
  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-subheadline font-medium break-words">{item.label}</span>
          <StateBadge state={item.state} />
        </span>
        {detail ? (
          <span className="text-footnote break-words text-text-secondary">{detail}</span>
        ) : null}
      </div>
      {action ? (
        <div className="-mx-3 flex shrink-0 flex-wrap items-center gap-1 sm:mx-0">{action}</div>
      ) : null}
    </li>
  );
}

/** Picks an image and uploads it at once: the own photo, or a new e-signature version. */
function ImagePickButton({
  kind,
  label,
  accept,
  onDone,
}: {
  kind: 'photo' | 'signature';
  label: string;
  accept: string;
  onDone: (version?: number) => void;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function choose(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    // Clear the input, so choosing the same file again still uploads it.
    event.currentTarget.value = '';
    if (!file) return;
    const formData = new FormData();
    formData.set(kind, file);
    setError(null);
    setUploading(true);
    try {
      if (kind === 'photo') {
        const result = await setOwnPhotoAction(null, formData);
        if (result.ok) {
          notifyOnboardingChanged();
          onDone();
        } else setError(fieldError(result, 'photo') ?? result.formError ?? UPLOAD_FAILED);
      } else {
        const result = await uploadOwnESignatureAction(null, formData);
        if (result.ok) {
          notifyOnboardingChanged();
          onDone(result.data.version);
        } else setError(fieldError(result, 'signature') ?? result.formError ?? UPLOAD_FAILED);
      }
    } catch {
      setError(UPLOAD_FAILED);
    } finally {
      setUploading(false);
      router.refresh();
    }
  }

  const Icon = kind === 'photo' ? ImageUp : PenLine;
  return (
    <div className="flex flex-col items-start gap-1">
      <input
        ref={inputRef}
        type="file"
        name={kind}
        accept={accept}
        hidden
        tabIndex={-1}
        onChange={(event) => void choose(event)}
      />
      <Button
        variant="plain"
        className="px-3"
        loading={uploading}
        disabled={!accept}
        aria-describedby={error ? errorId : undefined}
        onClick={() => inputRef.current?.click()}
      >
        <Icon aria-hidden="true" className="size-4.5" strokeWidth={1.75} />
        {label}
      </Button>
      <div id={errorId} role="alert" className="empty:hidden">
        {error ? (
          <p className="flex items-start gap-1.5 px-3 text-footnote font-medium text-destructive-text">
            <CircleAlert aria-hidden="true" className="mt-px size-4 shrink-0" />
            <span>{error}</span>
          </p>
        ) : null}
      </div>
    </div>
  );
}
