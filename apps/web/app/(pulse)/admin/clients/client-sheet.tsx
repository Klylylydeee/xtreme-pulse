'use client';

import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Building, CircleCheck, TriangleAlert } from 'lucide-react';
import {
  ADDRESS_MAX_LENGTH,
  DEFAULT_PRICE_DISPLAY,
  DEFAULT_VAT_TREATMENT,
  formatDate,
  INDUSTRY_MAX_LENGTH,
  MASTER_NAME_MAX_LENGTH,
  NOTES_MAX_LENGTH,
  PRICE_DISPLAY_LABELS,
  PRICE_DISPLAYS,
  TERMS_DAYS_MAX,
  TIN_HELP,
  VAT_TREATMENT_LABELS,
  VAT_TREATMENTS,
} from '@pulse/core';
import type { ClientDetailView, ClientNameMatch, ClientView } from '@pulse/core/server';
import { cn } from '@pulse/ui';
import { Button } from '@pulse/ui/components/button';
import { DestructiveConfirmDialog } from '@pulse/ui/components/confirm-dialog';
import { ErrorState } from '@pulse/ui/components/error-state';
import { FormField, FormSection, Input, Select, Textarea } from '@pulse/ui/components/form';
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
import {
  EmployeePicker,
  InactiveEmployeeBadge,
  type PickedEmployee,
} from '@/components/employee-picker';
import { FormAlert } from '@/components/form-alert';
import { plural, ReadOnlyField, useActionSubmit } from '@/components/org-structure';
import {
  createClientAction,
  findClientsNamedAction,
  getClientDetailAction,
  restoreClientAction,
  retireClientAction,
  searchAccountManagersAction,
  updateClientAction,
} from '@/lib/actions/clients';
import { ClientContactsSection } from './client-contacts-section';
import { ClientSitesSection } from './client-sites-section';

// Spec: docs/modules/core.md#managing-master-data and docs/modules/engage.md#clients-sites-and-contacts
// — one client's sheet: Details | Sites | Contacts. A new client is saved first; the sheet then
// edits it, and its sites and contacts unlock. Each site and contact is saved by its own action.
// A name another client has (ignoring case, retired ones included) shows the non-blocking warning
// (DESIGN_SYSTEM.md › Feedback & motion): the button becomes "Save anyway", which confirms it.
// A retired client is read-only, with Restore.

type Tab = 'details' | 'sites' | 'contacts';

const SUBMIT = ['mod', 'enter'] as const;
const NAME_CHECK_DELAY_MS = 300;
const LOAD_FAILED = 'The client’s sites and contacts couldn’t load. Try again.';

type DetailState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'done'; detail: ClientDetailView };

/** Loads the client with its sites and contacts, removed ones included. */
async function fetchDetail(id: string): Promise<DetailState> {
  try {
    const result = await getClientDetailAction(null, { id, includeRemoved: true });
    return result.ok
      ? { status: 'done', detail: result.data }
      : { status: 'error', message: result.formError ?? LOAD_FAILED };
  } catch {
    return { status: 'error', message: LOAD_FAILED };
  }
}

/** "30 days", or null when the default credit term applies. */
function termsLabel(days: number | null): string | null {
  return days === null ? null : plural(days, 'day', 'days');
}

function ClientSheetIcon() {
  return (
    <IconTile className="size-11 rounded-xl [&_svg]:size-5">
      <Building strokeWidth={1.75} />
    </IconTile>
  );
}

export function ClientSheet({
  client,
  onFinished,
  onListChanged,
}: {
  /** The client opened from the list, or null to add one. */
  client: ClientView | null;
  /** Closes the sheet and shows `message` on the page. */
  onFinished: (message: string) => void;
  /** Refreshes the list behind the sheet (counts, a client just added). */
  onListChanged: () => void;
}) {
  const [clientId, setClientId] = useState<string | null>(client?.id ?? null);
  const [createdName, setCreatedName] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('details');
  const [state, setState] = useState<DetailState>(
    client ? { status: 'loading' } : { status: 'idle' },
  );
  const [attempt, setAttempt] = useState(0);
  const latest = useRef(0);

  // Whatever started a load already showed the loading state (the create, or Try again); the
  // first one starts as loading.
  useEffect(() => {
    if (!clientId) return;
    const request = ++latest.current;
    void fetchDetail(clientId).then((next) => {
      if (request === latest.current) setState(next);
    });
  }, [clientId, attempt]);

  /** After a site or contact change: reloads the client, then refreshes the list's counts. */
  async function changed(): Promise<void> {
    if (clientId) {
      const request = ++latest.current;
      const next = await fetchDetail(clientId);
      if (request === latest.current) setState(next);
    }
    onListChanged();
  }

  const detail = state.status === 'done' ? state.detail : null;
  const view: ClientView | null = detail ?? client;
  const retired = Boolean(view?.retiredAt);
  const title = view?.name ?? createdName ?? 'Add client';
  const siteCount = view?.siteCount ?? 0;
  const contactCount = view?.contactCount ?? 0;
  const locked = clientId === null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SheetHeader title={title} leading={<ClientSheetIcon />} />
      <div className="shrink-0 px-4 pb-3 sm:px-5">
        <SegmentedControl<Tab>
          label="Client view"
          fullWidth
          value={tab}
          onValueChange={setTab}
          className="[&>button]:px-2"
          options={[
            { value: 'details', label: 'Details' },
            {
              value: 'sites',
              label: (
                <>
                  Sites
                  {locked ? null : <span className="numeric text-text-secondary">{siteCount}</span>}
                </>
              ),
              ariaLabel: locked ? 'Sites' : `Sites (${siteCount})`,
              disabled: locked,
            },
            {
              value: 'contacts',
              label: (
                <>
                  Contacts
                  {locked ? null : (
                    <span className="numeric text-text-secondary">{contactCount}</span>
                  )}
                </>
              ),
              ariaLabel: locked ? 'Contacts' : `Contacts (${contactCount})`,
              disabled: locked,
            },
          ]}
        />
      </div>
      <Panel active={tab === 'details'} label="Details">
        {retired && view ? (
          <RetiredClient client={view} onRestored={() => onFinished(`${view.name} restored.`)} />
        ) : (
          <ClientDetailsForm
            client={client}
            clientId={clientId}
            current={view}
            onCreated={(id, name) => {
              setCreatedName(name);
              setState({ status: 'loading' });
              setClientId(id);
              onListChanged();
            }}
            onSaved={(name) => onFinished(`${name} saved.`)}
            onRetired={(name) => onFinished(`${name} retired.`)}
          />
        )}
      </Panel>
      {(['sites', 'contacts'] as const).map((which) => (
        <Panel key={which} active={tab === which} label={which === 'sites' ? 'Sites' : 'Contacts'}>
          <SheetBody>
            {state.status === 'error' ? (
              <ErrorState
                variant="inline"
                headingLevel={3}
                title="Couldn’t load the client"
                description={state.message}
                action={
                  <Button
                    variant="tinted"
                    onClick={() => {
                      setState({ status: 'loading' });
                      setAttempt((count) => count + 1);
                    }}
                  >
                    Try again
                  </Button>
                }
              />
            ) : detail && clientId ? (
              which === 'sites' ? (
                <ClientSitesSection
                  clientId={clientId}
                  sites={detail.sites}
                  readOnly={retired}
                  onChanged={changed}
                />
              ) : (
                <ClientContactsSection
                  clientId={clientId}
                  contacts={detail.contacts}
                  readOnly={retired}
                  onChanged={changed}
                />
              )
            ) : (
              <RowsLoading label={which === 'sites' ? 'Loading sites…' : 'Loading contacts…'} />
            )}
          </SheetBody>
          <SheetFooter>
            {retired && view ? (
              <RestoreClientFooter
                client={view}
                onRestored={() => onFinished(`${view.name} restored.`)}
              />
            ) : (
              <SheetClose asChild>
                <Button variant="secondary" className="pr-3">
                  Done
                  <ShortcutHint keys={['escape']} className="hidden sm:inline-flex" />
                </Button>
              </SheetClose>
            )}
          </SheetFooter>
        </Panel>
      ))}
    </div>
  );
}

/** One view of the sheet. Inactive views stay mounted (keeping typed values) but hidden. */
function Panel({
  active,
  label,
  children,
}: {
  active: boolean;
  label: string;
  children: ReactNode;
}) {
  return (
    <div
      role="region"
      aria-label={label}
      hidden={!active}
      className={cn('min-h-0 flex-1 flex-col', active ? 'flex' : 'hidden')}
    >
      {children}
    </div>
  );
}

function RowsLoading({ label }: { label: string }) {
  return (
    <div role="status" className="flex flex-col gap-4">
      <span className="sr-only">{label}</span>
      <Skeleton className="h-11 w-36 rounded-lg" />
      <div className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="flex min-h-16 flex-col justify-center gap-2 px-4 py-3">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** "Another client is already named “Banco Uno” (retired)." */
function duplicateWarning(matches: ClientNameMatch[]): string {
  const [first] = matches;
  if (!first) return '';
  const more = matches.length > 1 ? ` and ${matches.length - 1} more` : '';
  return `Another client is already named “${first.name}”${first.retired ? ' (retired)' : ''}${more}. Check it isn’t the same client, then choose Save anyway.`;
}

/** Add or edit the client's details. */
function ClientDetailsForm({
  client,
  clientId,
  current,
  onCreated,
  onSaved,
  onRetired,
}: {
  /** The client as opened (the fields' starting values), or null for a new one. */
  client: ClientView | null;
  /** Set once the client exists (after adding it, the form edits it). */
  clientId: string | null;
  /** The latest copy, for Retire. */
  current: ClientView | null;
  onCreated: (id: string, name: string) => void;
  onSaved: (name: string) => void;
  onRetired: (name: string) => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const nameRef = useRef('');
  const creating = useRef(false);
  const checkRequest = useRef(0);
  const checkTimer = useRef<number | undefined>(undefined);
  const warningId = useId();
  const [manager, setManager] = useState<PickedEmployee | null>(
    client?.accountManagerEmployeeId
      ? {
          id: client.accountManagerEmployeeId,
          name: client.accountManagerName ?? 'Unknown employee',
        }
      : null,
  );
  // Other clients with the typed name: shown as the warning, and saving confirms it.
  const [duplicates, setDuplicates] = useState<ClientNameMatch[] | null>(null);
  // The server's duplicate refusal is shown as the warning, not as a red error.
  const [hideNameError, setHideNameError] = useState(false);
  const [added, setAdded] = useState(false);
  const save = useActionSubmit<unknown>(
    clientId ? updateClientAction : createClientAction,
    (data) => {
      if (creating.current) {
        const { id } = data as { id: string };
        setAdded(true);
        setDuplicates(null);
        onCreated(id, nameRef.current);
      } else {
        onSaved(nameRef.current);
      }
    },
  );
  // The saved Account Manager is no longer active, and is still the one picked.
  const managerInactive =
    client?.accountManagerActive === false &&
    manager !== null &&
    manager.id === client.accountManagerEmployeeId;
  const savedName = (current ?? client)?.name ?? null;

  useShortcut(SUBMIT, () => submitFormFromShortcut(formRef.current), { scope: formRef });
  useEffect(() => () => window.clearTimeout(checkTimer.current), []);

  /** Looks for other clients with this name; resolves to the matches, or null for none. */
  async function findDuplicates(name: string): Promise<ClientNameMatch[] | null> {
    const result = await findClientsNamedAction(null, { name, exceptId: clientId });
    return result.ok && result.data.length > 0 ? result.data : null;
  }

  /** On leaving the name field: checks it after a short pause, ignoring stale answers. */
  function checkName(value: string) {
    window.clearTimeout(checkTimer.current);
    const name = value.trim();
    const request = ++checkRequest.current;
    // An unchanged name is never refused, so it needs no warning.
    if (!name || name === savedName) return;
    checkTimer.current = window.setTimeout(async () => {
      try {
        const matches = await findDuplicates(name);
        if (request === checkRequest.current) setDuplicates(matches);
      } catch {
        // The server checks again on save.
      }
    }, NAME_CHECK_DELAY_MS);
  }

  /** Editing the name clears the warning, and the button goes back to its usual label. */
  function nameChanged() {
    window.clearTimeout(checkTimer.current);
    checkRequest.current += 1;
    setDuplicates(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const text = (key: string) => String(data.get(key) ?? '');
    const name = text('name');
    nameRef.current = name.trim();
    creating.current = clientId === null;
    setHideNameError(false);
    setAdded(false);
    const ok = await save.run({
      ...(clientId ? { id: clientId } : {}),
      name,
      tin: text('tin'),
      billingAddress: text('billingAddress'),
      vatTreatment: text('vatTreatment'),
      priceDisplay: text('priceDisplay'),
      creditTermsDays: text('creditTermsDays'),
      industry: text('industry'),
      accountManagerEmployeeId: manager?.id ?? '',
      notes: text('notes'),
      allowDuplicateName: duplicates !== null,
    });
    if (ok) return;
    // A refused name may be the server's duplicate check (another save got there first, or the
    // field was never left): show it as the warning, so "Save anyway" can confirm it.
    const request = ++checkRequest.current;
    const matches = name.trim() ? await findDuplicates(name.trim()).catch(() => null) : null;
    if (request === checkRequest.current && matches) {
      setDuplicates(matches);
      setHideNameError(true);
    }
    requestAnimationFrame(() => {
      form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    });
  }

  const nameError = duplicates || hideNameError ? undefined : save.fieldErrors.name;

  return (
    <form
      ref={formRef}
      noValidate
      onSubmit={(event) => void submit(event)}
      className="flex min-h-0 flex-1 flex-col"
    >
      <SheetBody>
        <FormAlert message={save.formError} />
        <p role="status" className="empty:hidden">
          {added ? (
            <span className="flex items-start gap-2 rounded-card bg-surface px-4 py-3 text-footnote font-medium text-success-text shadow-card">
              <CircleCheck aria-hidden="true" className="mt-px size-4 shrink-0" />
              Client added. You can now add its sites and contacts.
            </span>
          ) : null}
        </p>
        <FormSection
          title="Client"
          footer={clientId ? undefined : 'Save the client first, then add its sites and contacts.'}
        >
          <FormField label="Name" required error={nameError}>
            <Input
              name="name"
              defaultValue={client?.name ?? ''}
              maxLength={MASTER_NAME_MAX_LENGTH}
              autoComplete="off"
              autoFocus={!client}
              required
              aria-describedby={duplicates ? warningId : undefined}
              onChange={nameChanged}
              onBlur={(event) => checkName(event.currentTarget.value)}
            />
            <div aria-live="polite">
              {duplicates ? (
                <p
                  id={warningId}
                  className="flex items-start gap-1.5 text-footnote font-medium text-warning-text"
                >
                  <TriangleAlert aria-hidden="true" className="mt-px size-4 shrink-0" />
                  <span>{duplicateWarning(duplicates)}</span>
                </p>
              ) : null}
            </div>
          </FormField>
          <FormField label="TIN" hint={`Optional. ${TIN_HELP}`} error={save.fieldErrors.tin}>
            <Input
              name="tin"
              defaultValue={client?.tinDisplay ?? ''}
              inputMode="numeric"
              maxLength={30}
              autoComplete="off"
              spellCheck={false}
              className="numeric sm:max-w-60"
            />
          </FormField>
          <FormField label="Industry" error={save.fieldErrors.industry}>
            <Input
              name="industry"
              defaultValue={client?.industry ?? ''}
              maxLength={INDUSTRY_MAX_LENGTH}
              autoComplete="off"
            />
          </FormField>
          <FormField label="Billing address" error={save.fieldErrors.billingAddress}>
            <Textarea
              name="billingAddress"
              defaultValue={client?.billingAddress ?? ''}
              maxLength={ADDRESS_MAX_LENGTH}
              autoComplete="off"
            />
          </FormField>
        </FormSection>
        <FormSection title="Billing">
          <FormField label="VAT treatment" error={save.fieldErrors.vatTreatment}>
            <Select
              name="vatTreatment"
              defaultValue={client?.vatTreatment ?? DEFAULT_VAT_TREATMENT}
            >
              {VAT_TREATMENTS.map((value) => (
                <option key={value} value={value}>
                  {VAT_TREATMENT_LABELS[value]}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField
            label="Price display"
            hint="How this client’s quotations show prices."
            error={save.fieldErrors.priceDisplay}
          >
            <Select
              name="priceDisplay"
              defaultValue={client?.priceDisplay ?? DEFAULT_PRICE_DISPLAY}
            >
              {PRICE_DISPLAYS.map((value) => (
                <option key={value} value={value}>
                  {PRICE_DISPLAY_LABELS[value]}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField
            label="Credit terms (days)"
            hint={`Optional. A whole number of days from 0 to ${TERMS_DAYS_MAX}. Empty uses the default credit term.`}
            error={save.fieldErrors.creditTermsDays}
          >
            <Input
              name="creditTermsDays"
              type="number"
              inputMode="numeric"
              min={0}
              max={TERMS_DAYS_MAX}
              step={1}
              defaultValue={client?.creditTermsDays ?? ''}
              className="tabular-nums sm:max-w-40"
            />
          </FormField>
        </FormSection>
        <FormSection
          title="Account Manager"
          footer="Optional. Any employee with an active account, from any department."
        >
          <FormField
            label="Owning Account Manager"
            hint={
              managerInactive
                ? 'No longer an active employee. Kept until you pick someone else.'
                : undefined
            }
            error={save.fieldErrors.accountManagerEmployeeId}
          >
            <EmployeePicker
              name="accountManagerEmployeeId"
              value={manager}
              onChange={setManager}
              search={searchAccountManagersAction}
              valueInactive={managerInactive}
              noneLabel="No Account Manager"
              chooseLabel="Choose the owning Account Manager"
              listLabel="Account Manager"
              emptyDescription="An Account Manager is picked from employees with an active account. You can save without one and set it later."
            />
          </FormField>
        </FormSection>
        <FormSection title="Notes">
          <FormField label="Notes" error={save.fieldErrors.notes}>
            <Textarea
              name="notes"
              defaultValue={client?.notes ?? ''}
              maxLength={NOTES_MAX_LENGTH}
            />
          </FormField>
        </FormSection>
      </SheetBody>
      <SheetFooter>
        {clientId && current ? <RetireClientButton client={current} onRetired={onRetired} /> : null}
        <SheetClose asChild>
          <Button variant="secondary" className="pr-3">
            {added ? 'Done' : 'Cancel'}
            <ShortcutHint keys={['escape']} className="hidden sm:inline-flex" />
          </Button>
        </SheetClose>
        <Button
          type="submit"
          loading={save.pending}
          aria-keyshortcuts={ariaKeyShortcuts(SUBMIT)}
          className="pr-3"
        >
          {duplicates ? 'Save anyway' : clientId ? 'Save' : 'Add client'}
          <ShortcutHint keys={SUBMIT} tone="on-fill" className="hidden sm:inline-flex" />
        </Button>
      </SheetFooter>
    </form>
  );
}

/** Retire, after the destructive confirmation. A refused retire is shown in the dialog. */
function RetireClientButton({
  client,
  onRetired,
}: {
  client: ClientView;
  onRetired: (name: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const retire = useActionSubmit(retireClientAction, () => onRetired(client.name));

  return (
    <>
      <Button
        variant="plain"
        onClick={() => {
          retire.reset();
          setConfirming(true);
        }}
        className="mr-auto text-destructive-text hover:bg-bg-grouped hover:text-destructive-text"
      >
        Retire
      </Button>
      <DestructiveConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Retire ${client.name}?`}
        description="It can’t be picked for new records, and its sites and contacts can’t be changed. They stay as they are, and come back when you restore it from “Show retired”."
        confirmLabel="Retire client"
        error={retire.formError}
        onConfirm={async () => {
          const ok = await retire.run({ id: client.id });
          // Keeps the dialog open, showing why, when the retire was refused.
          if (!ok) throw new Error('Retire refused');
        }}
      />
    </>
  );
}

/** A retired client's details, read-only, with Restore. */
function RetiredClient({ client, onRestored }: { client: ClientView; onRestored: () => void }) {
  const terms = termsLabel(client.creditTermsDays);
  return (
    <>
      <SheetBody>
        <FormSection
          title="Client"
          footer={
            client.retiredAt
              ? `Retired on ${formatDate(client.retiredAt)}. Restore it to edit it or pick it again.`
              : undefined
          }
        >
          <ReadOnlyField label="Name">{client.name}</ReadOnlyField>
          <ReadOnlyField label="TIN">
            <span className="numeric">{client.tinDisplay ?? 'None'}</span>
          </ReadOnlyField>
          <ReadOnlyField label="Industry">{client.industry ?? 'None'}</ReadOnlyField>
          <ReadOnlyField label="Billing address">
            <span className="whitespace-pre-line">{client.billingAddress ?? 'None'}</span>
          </ReadOnlyField>
        </FormSection>
        <FormSection title="Billing">
          <ReadOnlyField label="VAT treatment">
            {VAT_TREATMENT_LABELS[client.vatTreatment]}
          </ReadOnlyField>
          <ReadOnlyField label="Price display">
            {PRICE_DISPLAY_LABELS[client.priceDisplay]}
          </ReadOnlyField>
          <ReadOnlyField label="Credit terms">{terms ?? 'The default credit term'}</ReadOnlyField>
        </FormSection>
        <FormSection title="Account Manager">
          <ReadOnlyField label="Owning Account Manager">
            {client.accountManagerEmployeeId ? (
              <span className="inline-flex flex-wrap items-center gap-2">
                {client.accountManagerName ?? 'Unknown employee'}
                {client.accountManagerActive === false ? <InactiveEmployeeBadge /> : null}
              </span>
            ) : (
              'None'
            )}
          </ReadOnlyField>
        </FormSection>
        <FormSection title="Notes">
          <ReadOnlyField label="Notes">
            <span className="whitespace-pre-line">{client.notes ?? 'None'}</span>
          </ReadOnlyField>
        </FormSection>
      </SheetBody>
      <SheetFooter>
        <RestoreClientFooter client={client} onRestored={onRestored} />
      </SheetFooter>
    </>
  );
}

/** Close and Restore, for a retired client's footer. A refused restore shows above them. */
function RestoreClientFooter({
  client,
  onRestored,
}: {
  client: ClientView;
  onRestored: () => void;
}) {
  const restore = useActionSubmit(restoreClientAction, onRestored);
  return (
    <>
      {restore.formError ? (
        <div className="w-full">
          <FormAlert message={restore.formError} />
        </div>
      ) : null}
      <SheetClose asChild>
        <Button variant="secondary" className="pr-3">
          Close
          <ShortcutHint keys={['escape']} className="hidden sm:inline-flex" />
        </Button>
      </SheetClose>
      <Button loading={restore.pending} onClick={() => void restore.run({ id: client.id })}>
        Restore client
      </Button>
    </>
  );
}
