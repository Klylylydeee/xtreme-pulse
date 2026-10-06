'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { CircleAlert, Info, Lock, RotateCw, ShieldCheck } from 'lucide-react';
import {
  ACCESS_CHANGED_ELSEWHERE,
  ACCESS_LEVEL_DESCRIPTIONS,
  ACCESS_LEVEL_LABELS,
  type AccessLevel,
  accessSummary,
  BOARD_ACCESS_HINT,
  formatDate,
  formatDateTime,
  fullModuleAccess,
  MODULE_ACCESS_LEVELS,
  MODULE_LABELS,
  type ModuleAccess,
  type ModuleKey,
  MODULES,
} from '@pulse/core';
import type { SaveUserAccessResult, UserAccessDetail, UserAccessRow } from '@pulse/core/server';
import { cn } from '@pulse/ui';
import { Button } from '@pulse/ui/components/button';
import { DestructiveConfirmDialog } from '@pulse/ui/components/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@pulse/ui/components/dialog';
import { ErrorState } from '@pulse/ui/components/error-state';
import { Switch } from '@pulse/ui/components/form';
import { IconTile } from '@pulse/ui/components/icon-tile';
import { SegmentedControl } from '@pulse/ui/components/segmented-control';
import { SheetBody, SheetClose, SheetFooter, SheetHeader } from '@pulse/ui/components/sheet';
import {
  ariaKeyShortcuts,
  ShortcutHint,
  submitFormFromShortcut,
  useShortcut,
} from '@pulse/ui/components/shortcut-hint';
import { Skeleton } from '@pulse/ui/components/skeleton';
import { FormAlert } from '@/components/form-alert';
import { Badge, useActionSubmit } from '@/components/org-structure';
import { getUserAccessAction, saveUserAccessAction } from '@/lib/actions/user-access';
import { moduleDisplay } from '@/lib/module-labels';

// Spec: docs/modules/core.md#user-access-page — the access sheet (decisions 65–80 in
// docs/BUILD_PLAN.md). One row per module with a None | Read | Write | Owner segmented control
// (None | Read on Insight) and the selected level's one-line description; Save applies all of them
// at once (⌘S / Ctrl+S). Above the rows, the System Administrator switch, shown only to System
// Administrators: on, the rows lock at Owner (Read on Insight) and the stored levels are kept;
// off again, the confirmation lists the stored levels that apply again. While the user is, or is
// about to become, a System Administrator the service ignores the levels sent, so the rows stay
// locked until that change is saved; turning it on drops unsaved level changes, and its
// confirmation says so. Read-only for everyone: one's own row and the system account;
// for HR, a System Administrator's. Board members get the Insight Read hint, never a grant. The
// footer previews what the user will see; "Last changed" comes from the account, not the audit
// log. A stale sheet is refused by the service and offers a reload.

const SAVE = ['mod', 's'] as const;

/** Initials until Pulse Talent adds profile photos (decision 78); the system account gets a shield. */
export function UserAvatar({
  row,
  size = 'md',
}: {
  row: Pick<UserAccessRow, 'firstName' | 'lastName' | 'email' | 'isSystemAccount'>;
  size?: 'md' | 'lg';
}) {
  const initials = row.isSystemAccount
    ? null
    : [row.firstName, row.lastName]
        .map((part) => part?.trim().charAt(0) ?? '')
        .join('')
        .toUpperCase() || row.email.charAt(0).toUpperCase();
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full bg-accent-subtle font-semibold text-accent',
        size === 'lg' ? 'size-12 text-callout' : 'size-11 text-subheadline',
      )}
    >
      {initials ?? <ShieldCheck strokeWidth={1.75} className="size-5" />}
    </span>
  );
}

/** The name the sheet uses: the person's name, or "System account". */
function sheetName(row: Pick<UserAccessRow, 'name' | 'email' | 'isSystemAccount'>): string {
  return row.isSystemAccount ? 'System account' : (row.name ?? row.email);
}

/** The first name in "After saving, Ana sees:". */
function firstNameOf(row: Pick<UserAccessRow, 'firstName' | 'name' | 'email' | 'isSystemAccount'>) {
  return row.firstName ?? sheetName(row);
}

/** Position · Department · number · Added <date>. */
function sheetDescription(row: UserAccessRow) {
  const parts = row.isSystemAccount
    ? [row.email]
    : [row.positionName, row.departmentName].filter((part): part is string => Boolean(part));
  return (
    <>
      {parts.join(' · ')}
      {row.employeeNumber ? <span className="numeric"> · {row.employeeNumber}</span> : null} · Added{' '}
      {formatDate(new Date(row.createdAt))}
    </>
  );
}

// --- Loading the user --------------------------------------------------------------------------

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'gone' }
  | { status: 'done'; detail: UserAccessDetail };

const LOAD_FAILED = 'The user’s access couldn’t load. Try again.';

export interface AccessSheetProps {
  /** The user to open, from a row or `?user=<id>`. */
  userId: string;
  /** Their row in the list, when it is there (for the header while the sheet loads). */
  row: UserAccessRow | null;
  /** The switch shows to System Administrators only. */
  actorIsSystemAdministrator: boolean;
  /** A save went through; the sheet closes and the page shows `message`. */
  onSaved: (message: string) => void;
}

/** Loads the user's access fresh (with the `changedAt` the save sends back), then the form. */
export function AccessSheetContent({ userId, row, ...props }: AccessSheetProps) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    getUserAccessAction(null, { id: userId })
      .then((result) => {
        if (!current) return;
        if (!result.ok) setState({ status: 'error', message: result.formError ?? LOAD_FAILED });
        else if (!result.data) setState({ status: 'gone' });
        else setState({ status: 'done', detail: result.data });
      })
      .catch(() => {
        if (current) setState({ status: 'error', message: LOAD_FAILED });
      });
    return () => {
      current = false;
    };
  }, [userId, attempt]);

  function reload() {
    setState({ status: 'loading' });
    setAttempt((count) => count + 1);
  }

  if (state.status === 'done') {
    return (
      <AccessForm
        key={`${state.detail.id}:${attempt}`}
        detail={state.detail}
        onReload={reload}
        {...props}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SheetHeader
        title={row ? sheetName(row) : 'User access'}
        description={row ? sheetDescription(row) : undefined}
        leading={row ? <UserAvatar row={row} size="lg" /> : undefined}
      />
      <SheetBody>
        {state.status === 'loading' ? (
          <div role="status" className="flex flex-col gap-2">
            <span className="sr-only">Loading the user’s access…</span>
            <Skeleton className="ml-4 h-3 w-28" />
            <div className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
              {MODULES.map((module) => (
                <div key={module} className="flex flex-col gap-2 px-4 py-3">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-11 w-full rounded-lg" />
                </div>
              ))}
            </div>
          </div>
        ) : state.status === 'gone' ? (
          <ErrorState
            headingLevel={3}
            title="This user isn’t active"
            description="They may have been separated or removed, so their access can’t be set. Close this to see the current list."
          />
        ) : (
          <ErrorState
            headingLevel={3}
            title="Couldn’t load the user’s access"
            description={state.message}
            action={
              <Button variant="tinted" onClick={reload}>
                Try again
              </Button>
            }
          />
        )}
      </SheetBody>
      <SheetFooter>
        <SheetClose asChild>
          <Button variant="secondary" className="pr-3">
            Close
            <ShortcutHint keys={['escape']} className="hidden sm:inline-flex" />
          </Button>
        </SheetClose>
      </SheetFooter>
    </div>
  );
}

// --- The form ----------------------------------------------------------------------------------

function levelOptions(module: ModuleKey) {
  return (MODULE_ACCESS_LEVELS[module] as readonly AccessLevel[]).map((level) => ({
    value: level,
    label: ACCESS_LEVEL_LABELS[level],
  }));
}

/** "Talent R, Fiscal O" for the switch-off confirmation; a plain phrase for None everywhere. */
function storedLevelsPhrase(stored: ModuleAccess): string {
  const chips = accessSummary(stored);
  return chips.length === 0 ? 'None on every module' : chips.join(', ');
}

function AccessForm({
  detail,
  actorIsSystemAdministrator,
  onSaved,
  onReload,
}: Omit<AccessSheetProps, 'userId' | 'row'> & {
  detail: UserAccessDetail;
  onReload: () => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [levels, setLevels] = useState<ModuleAccess>(detail.storedAccess);
  const [administrator, setAdministrator] = useState(detail.isSystemAdministrator);
  const [confirming, setConfirming] = useState<'on' | 'off' | null>(null);
  const switchId = useId();
  const switchHintId = useId();

  const name = sheetName(detail);
  const firstName = firstNameOf(detail);
  const readOnly = detail.readOnlyReason !== null;
  // The service ignores the levels while the user is, or is about to become, a System
  // Administrator (decision 65), so the rows stay locked until that change is saved.
  const locked = detail.isSystemAdministrator || administrator;
  const editable = !readOnly && !locked;
  const shown: ModuleAccess = readOnly
    ? detail.effectiveAccess
    : administrator
      ? fullModuleAccess()
      : levels;
  const preview = accessSummary(shown);
  const showSwitch = actorIsSystemAdministrator && !detail.isSystemAccount;
  const canToggle = detail.canToggleSystemAdministrator && !readOnly;
  // Unsaved level changes the switch drops: the service ignores the levels sent with it.
  const levelsEdited = MODULES.some((module) => levels[module] !== detail.storedAccess[module]);

  const save = useActionSubmit<SaveUserAccessResult>(saveUserAccessAction, (result) => {
    if (result.systemAdministratorChanged) {
      onSaved(
        administrator
          ? `${name} is now a System Administrator.`
          : `${name} is no longer a System Administrator.`,
      );
    } else if (result.changedModules.length > 0) {
      onSaved(`Access saved for ${name}.`);
    } else {
      onSaved(`No changes to ${name}’s access.`);
    }
  });
  const stale = save.formError === ACCESS_CHANGED_ELSEWHERE;

  useShortcut(SAVE, () => submitFormFromShortcut(formRef.current), {
    scope: formRef,
    enabled: !readOnly,
  });

  function changeLevel(module: ModuleKey, level: AccessLevel) {
    setLevels((current) => ({ ...current, [module]: level }) as ModuleAccess);
  }

  const lastChanged = detail.changedAt
    ? `Last changed ${formatDateTime(new Date(detail.changedAt))}${detail.changedByName ? ` by ${detail.changedByName}` : ''}`
    : 'Last changed: never';

  return (
    <>
      <form
        ref={formRef}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (readOnly) return;
          void save.run({
            id: detail.id,
            moduleAccess: levels,
            // Sent only by a System Administrator; the service checks it again.
            ...(canToggle ? { isSystemAdministrator: administrator } : {}),
            expectedChangedAt: detail.changedAt,
          });
        }}
        className="flex min-h-0 flex-1 flex-col"
      >
        <SheetHeader
          title={name}
          description={sheetDescription(detail)}
          leading={<UserAvatar row={detail} size="lg" />}
        />
        <SheetBody>
          {stale ? (
            <div
              role="alert"
              className="flex flex-col gap-3 rounded-card bg-surface px-4 py-3 shadow-card sm:flex-row sm:items-center"
            >
              <p className="flex flex-1 items-start gap-2 text-footnote font-medium text-destructive-text">
                <CircleAlert aria-hidden="true" className="mt-px size-4 shrink-0" />
                <span>{ACCESS_CHANGED_ELSEWHERE}</span>
              </p>
              <Button variant="tinted" onClick={onReload} className="shrink-0">
                <RotateCw aria-hidden="true" className="size-4.5" />
                Reload
              </Button>
            </div>
          ) : (
            <FormAlert message={save.formError} />
          )}

          {readOnly && detail.readOnlyMessage ? (
            <p className="flex items-start gap-2 rounded-card bg-surface px-4 py-3 text-footnote text-text-secondary shadow-card">
              <Lock aria-hidden="true" className="mt-px size-4 shrink-0" />
              <span>{detail.readOnlyMessage}</span>
            </p>
          ) : null}

          {showSwitch ? (
            <section aria-labelledby={`${switchId}-title`} className="flex flex-col gap-2">
              <h3
                id={`${switchId}-title`}
                className="px-4 text-footnote font-semibold text-text-secondary"
              >
                Role
              </h3>
              <div className="flex flex-col overflow-hidden rounded-card bg-surface shadow-card">
                <div className="flex min-h-14 items-center gap-4 px-4 py-3">
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <label
                      htmlFor={switchId}
                      className="text-subheadline font-medium text-text-primary"
                    >
                      System Administrator
                    </label>
                    <p id={switchHintId} className="text-footnote text-text-secondary">
                      Owner on every module and Read on Insight, plus company settings and the audit
                      log.
                    </p>
                  </div>
                  <Switch
                    id={switchId}
                    aria-describedby={switchHintId}
                    checked={administrator}
                    disabled={!canToggle || save.pending}
                    onCheckedChange={(next) => setConfirming(next ? 'on' : 'off')}
                  />
                </div>
              </div>
              {administrator !== detail.isSystemAdministrator ? (
                <p className="px-4 text-footnote font-medium text-accent">
                  {administrator
                    ? 'Takes effect when you save.'
                    : 'Takes effect when you save. Their stored levels apply again then.'}
                </p>
              ) : null}
            </section>
          ) : null}

          {detail.isBoardMember && !locked && !readOnly ? (
            <p className="flex items-start gap-2 rounded-card bg-accent-subtle px-4 py-3 text-footnote text-text-secondary">
              <Info aria-hidden="true" className="mt-px size-4 shrink-0 text-accent" />
              <span>{BOARD_ACCESS_HINT}</span>
            </p>
          ) : null}

          <section aria-labelledby={`${switchId}-modules`} className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-3 px-4">
              <h3
                id={`${switchId}-modules`}
                className="text-footnote font-semibold text-text-secondary"
              >
                Module access
              </h3>
              <span className="numeric text-footnote text-text-secondary">
                {MODULES.filter((module) => shown[module] !== 'none').length} of {MODULES.length}{' '}
                modules
              </span>
            </div>
            <div className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
              {MODULES.map((module) => (
                <ModuleRow
                  key={module}
                  module={module}
                  level={shown[module]}
                  disabled={!editable || save.pending}
                  onChange={(level) => changeLevel(module, level)}
                />
              ))}
            </div>
            <p className="px-4 text-footnote text-text-secondary">
              {locked && !readOnly
                ? detail.isSystemAdministrator && !administrator
                  ? `Save first: ${firstName}’s stored levels below apply again once the role is removed, and can be changed after that.`
                  : 'System Administrators have Owner on every module and Read on Insight. Their stored levels are kept, and apply again if the role is removed.'
                : 'Self-service (timesheet, leave, payslips, directory) works for everyone, whatever their access.'}
            </p>
          </section>

          <p className="px-4 text-footnote text-text-secondary">{lastChanged}</p>
        </SheetBody>
        <SheetFooter className="flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          {readOnly ? null : (
            <div className="flex min-w-0 flex-col gap-1.5 sm:basis-full" aria-live="polite">
              {preview.length > 0 ? (
                <>
                  <p className="text-footnote font-medium text-text-secondary">
                    After saving, {firstName} sees:
                  </p>
                  <span className="flex flex-wrap gap-1.5">
                    {preview.map((chip) => (
                      <Badge key={chip} tone="accent" className="numeric">
                        {chip}
                      </Badge>
                    ))}
                  </span>
                </>
              ) : (
                <p className="text-footnote font-medium text-text-secondary">
                  After saving: no module access. {firstName} sees Pulse Core and self-service only.
                </p>
              )}
            </div>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2 sm:ml-auto">
            <SheetClose asChild>
              <Button variant="secondary" className="pr-3">
                {readOnly ? 'Close' : detail.needsAccess ? 'Set access later' : 'Cancel'}
                <ShortcutHint keys={['escape']} className="hidden sm:inline-flex" />
              </Button>
            </SheetClose>
            {readOnly ? null : (
              <Button
                type="submit"
                loading={save.pending}
                aria-keyshortcuts={ariaKeyShortcuts(SAVE)}
                className="pr-3"
              >
                Save access
                <ShortcutHint keys={SAVE} tone="on-fill" className="hidden sm:inline-flex" />
              </Button>
            )}
          </div>
        </SheetFooter>
      </form>

      {/* Outside the form: React events bubble through portals, so a nested button would submit it. */}
      <MakeAdministratorDialog
        open={confirming === 'on'}
        name={name}
        discardsEdits={levelsEdited}
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          // Dropped here too, so switching off again before saving shows the stored levels.
          setLevels(detail.storedAccess);
          setAdministrator(true);
          setConfirming(null);
        }}
      />
      <DestructiveConfirmDialog
        open={confirming === 'off'}
        onOpenChange={(next) => {
          if (!next) setConfirming(null);
        }}
        title={`Remove ${name}’s System Administrator role?`}
        description={`When you save, they lose company settings and the audit log, and their stored levels apply again: ${storedLevelsPhrase(detail.storedAccess)}.`}
        confirmLabel="Remove role"
        onConfirm={() => setAdministrator(false)}
      />
    </>
  );
}

function ModuleRow({
  module,
  level,
  disabled,
  onChange,
}: {
  module: ModuleKey;
  level: AccessLevel;
  disabled: boolean;
  onChange: (level: AccessLevel) => void;
}) {
  const { Icon } = moduleDisplay(module);
  return (
    <div className="flex flex-col gap-2.5 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <IconTile className="size-9 shrink-0 rounded-lg [&_svg]:size-4.5">
          <Icon strokeWidth={1.75} />
        </IconTile>
        <div className="flex min-w-0 flex-col">
          <span className="text-subheadline font-semibold">{MODULE_LABELS[module]}</span>
          <span className="text-footnote text-text-secondary">
            {ACCESS_LEVEL_DESCRIPTIONS[level]}
          </span>
        </div>
      </div>
      <div className="sm:w-[17.5rem] sm:shrink-0">
        <SegmentedControl
          label={`${MODULE_LABELS[module]} access`}
          options={levelOptions(module)}
          value={level}
          onValueChange={onChange}
          tone="accent"
          fullWidth
          disabled={disabled}
          className={cn(module === 'insight' && 'sm:ml-auto sm:w-1/2')}
        />
      </div>
    </div>
  );
}

/** The confirmation to turn the switch on. Not destructive, so not red. */
function MakeAdministratorDialog({
  open,
  name,
  discardsEdits,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  name: string;
  /** The sheet has unsaved level changes, which the role replaces. */
  discardsEdits: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent
        className={[
          'top-1/2 left-1/2 flex w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col gap-5',
          'rounded-panel bg-surface p-6 text-text-primary shadow-float',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
        ].join(' ')}
      >
        <div className="flex items-start gap-4">
          <IconTile className="size-11 shrink-0 rounded-xl [&_svg]:size-5">
            <ShieldCheck strokeWidth={1.75} />
          </IconTile>
          <div className="flex min-w-0 flex-col gap-1.5">
            <DialogTitle>Make {name} a System Administrator?</DialogTitle>
            <DialogDescription>
              When you save, they get Owner on every module and Read on Insight, plus company
              settings and the audit log. Their stored levels are kept, and apply again if the role
              is removed.
              {discardsEdits ? ' The level changes you haven’t saved are discarded.' : null}
            </DialogDescription>
          </div>
        </div>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onCancel} className="gap-2.5">
            Cancel
            <ShortcutHint keys={['escape']} className="hidden sm:inline-flex" />
          </Button>
          <Button onClick={onConfirm} autoFocus>
            Make System Administrator
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
