'use client';

import { useId, useState, type FormEvent } from 'react';
import { Plus, UsersRound } from 'lucide-react';
import {
  CONTACT_EMAIL_MAX_LENGTH,
  CONTACT_MOBILE_MAX_LENGTH,
  CONTACT_POSITION_MAX_LENGTH,
  PERSON_NAME_MAX_LENGTH,
  PH_MOBILE_HELP,
} from '@pulse/core';
import type { ClientContactView } from '@pulse/core/server';
import { Button } from '@pulse/ui/components/button';
import { EmptyState } from '@pulse/ui/components/empty-state';
import { FormField, FormSection, Input, Switch } from '@pulse/ui/components/form';
import { FormAlert } from '@/components/form-alert';
import { Badge, useActionSubmit } from '@/components/org-structure';
import {
  addClientContactAction,
  removeClientContactAction,
  restoreClientContactAction,
  updateClientContactAction,
} from '@/lib/actions/clients';
import {
  EditRowButton,
  RemoveRowButton,
  RestoreRowButton,
  Row,
  RowCard,
  SectionAlert,
  ShowRemovedSwitch,
  useFocusLater,
} from './client-row-list';

// Spec: docs/modules/engage.md#clients-sites-and-contacts and docs/modules/core.md#managing-master-data
// — a client's contacts, each added, edited, removed (a soft delete) or restored by its own action.
// At most one is primary: marking one primary clears the old one (in the service's transaction).
// Removing the primary contact clears its flag, so a restored contact comes back not primary.
// Nothing changes on a retired client: the list is read-only until the client is restored.

export function ClientContactsSection({
  clientId,
  contacts,
  readOnly,
  onChanged,
}: {
  clientId: string;
  /** Live and removed contacts, the primary first. */
  contacts: ClientContactView[];
  /** The client is retired: no changes until it is restored. */
  readOnly: boolean;
  /** Reloads the contacts (and refreshes the client list's counts). */
  onChanged: () => Promise<void>;
}) {
  const baseId = useId();
  const addId = `${baseId}-add`;
  const editId = (id: string) => `${baseId}-edit-${id}`;
  const focusLater = useFocusLater();
  // 'new', a contact's id, or null: one form open at a time.
  const [editing, setEditing] = useState<string | null>(null);
  const [showRemoved, setShowRemoved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const live = contacts.filter((contact) => !contact.removedAt);
  const removed = contacts.filter((contact) => contact.removedAt);
  const shown = showRemoved ? contacts : live;
  const primary = live.find((contact) => contact.isPrimary) ?? null;

  function closeForm(focusId: string) {
    setEditing(null);
    focusLater(focusId);
  }

  return (
    <section aria-label="Contacts" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        {readOnly ? (
          <p className="text-footnote text-text-secondary">
            Restore the client to change its contacts.
          </p>
        ) : (
          <Button
            id={addId}
            variant="tinted"
            disabled={editing === 'new'}
            onClick={() => {
              setError(null);
              setEditing('new');
            }}
          >
            <Plus aria-hidden="true" className="size-5" />
            Add contact
          </Button>
        )}
        {removed.length > 0 ? (
          <ShowRemovedSwitch
            checked={showRemoved}
            onCheckedChange={setShowRemoved}
            count={removed.length}
          />
        ) : null}
      </div>
      <SectionAlert message={error} />
      {editing === 'new' ? (
        <ContactForm
          clientId={clientId}
          contact={null}
          primary={primary}
          onCancel={() => closeForm(addId)}
          onSaved={async () => {
            await onChanged();
            closeForm(addId);
          }}
        />
      ) : null}
      {shown.length === 0 && editing !== 'new' ? (
        <EmptyState
          variant="inline"
          headingLevel={3}
          icon={<UsersRound strokeWidth={1.75} />}
          title="No contacts yet"
          description="Add the people Xtreme Works deals with at this client, and mark one as the primary contact."
        />
      ) : shown.length > 0 ? (
        <RowCard label="Contacts">
          {shown.map((contact) =>
            editing === contact.id ? (
              <li key={contact.id} className="p-2">
                <ContactForm
                  clientId={clientId}
                  contact={contact}
                  primary={primary}
                  onCancel={() => closeForm(editId(contact.id))}
                  onSaved={async () => {
                    await onChanged();
                    closeForm(editId(contact.id));
                  }}
                />
              </li>
            ) : (
              <Row
                key={contact.id}
                removed={Boolean(contact.removedAt)}
                actions={
                  readOnly ? null : contact.removedAt ? (
                    <RestoreRowButton
                      id={contact.id}
                      label={`Restore ${contact.name}`}
                      action={restoreClientContactAction}
                      onError={setError}
                      onRestored={async () => {
                        await onChanged();
                        focusLater(editId(contact.id));
                      }}
                    />
                  ) : (
                    <>
                      <EditRowButton
                        id={editId(contact.id)}
                        label={`Edit ${contact.name}`}
                        onClick={() => {
                          setError(null);
                          setEditing(contact.id);
                        }}
                      />
                      <RemoveRowButton
                        id={contact.id}
                        label={`Remove ${contact.name}`}
                        title={`Remove ${contact.name}?`}
                        description={
                          contact.isPrimary
                            ? 'This is the primary contact: the client will have none until you mark another. You can restore it later from “Show removed”; it comes back not primary.'
                            : 'It can’t be picked for new records. You can restore it later from “Show removed”.'
                        }
                        confirmLabel="Remove contact"
                        action={removeClientContactAction}
                        onRemoved={async () => {
                          await onChanged();
                          focusLater(addId);
                        }}
                      />
                    </>
                  )
                }
              >
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="truncate text-subheadline font-medium text-text-primary">
                    {contact.name}
                  </span>
                  {contact.isPrimary ? <Badge tone="accent">Primary</Badge> : null}
                  {contact.removedAt ? <Badge>Removed</Badge> : null}
                </span>
                {contact.position ? (
                  <span className="text-footnote text-text-secondary">{contact.position}</span>
                ) : null}
                {contact.email || contact.mobile ? (
                  <span className="text-footnote break-all text-text-secondary">
                    {[contact.email, contact.mobile].filter(Boolean).join(' · ')}
                  </span>
                ) : null}
              </Row>
            ),
          )}
        </RowCard>
      ) : null}
    </section>
  );
}

/** The inline add or edit form for one contact. */
function ContactForm({
  clientId,
  contact,
  primary,
  onCancel,
  onSaved,
}: {
  clientId: string;
  contact: ClientContactView | null;
  /** The client's current primary contact, if any. */
  primary: ClientContactView | null;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const save = useActionSubmit<unknown>(
    contact ? updateClientContactAction : addClientContactAction,
    () => undefined,
  );
  const [isPrimary, setIsPrimary] = useState(contact?.isPrimary ?? false);
  const [settling, setSettling] = useState(false);
  // Another contact is primary now: marking this one takes over from it.
  const replaces = isPrimary && primary && primary.id !== contact?.id ? primary : null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const text = (key: string) => String(data.get(key) ?? '');
    const ok = await save.run({
      ...(contact ? { id: contact.id } : { clientId }),
      name: text('name'),
      position: text('position'),
      email: text('email'),
      mobile: text('mobile'),
      isPrimary,
    });
    if (!ok) {
      requestAnimationFrame(() => {
        form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
      });
      return;
    }
    setSettling(true);
    try {
      await onSaved();
    } finally {
      setSettling(false);
    }
  }

  // A retired client is refused on `clientId`: shown above the fields.
  const formError = save.formError ?? save.fieldErrors.clientId ?? null;

  return (
    <form noValidate onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
      <FormAlert message={formError} />
      <FormSection title={contact ? `Edit ${contact.name}` : 'New contact'}>
        <FormField label="Name" required error={save.fieldErrors.name}>
          <Input
            name="name"
            defaultValue={contact?.name ?? ''}
            maxLength={PERSON_NAME_MAX_LENGTH}
            autoComplete="off"
            autoFocus
            required
          />
        </FormField>
        <FormField label="Position" error={save.fieldErrors.position}>
          <Input
            name="position"
            defaultValue={contact?.position ?? ''}
            maxLength={CONTACT_POSITION_MAX_LENGTH}
            autoComplete="off"
          />
        </FormField>
        <FormField label="Email" error={save.fieldErrors.email}>
          <Input
            name="email"
            type="email"
            inputMode="email"
            defaultValue={contact?.email ?? ''}
            maxLength={CONTACT_EMAIL_MAX_LENGTH}
            autoComplete="off"
            spellCheck={false}
          />
        </FormField>
        <FormField
          label="Mobile"
          hint={`Optional. ${PH_MOBILE_HELP}`}
          error={save.fieldErrors.mobile}
        >
          <Input
            name="mobile"
            type="tel"
            inputMode="tel"
            defaultValue={contact?.mobile ?? ''}
            maxLength={CONTACT_MOBILE_MAX_LENGTH}
            autoComplete="off"
            className="numeric sm:max-w-60"
          />
        </FormField>
        <FormField
          label="Primary contact"
          layout="inline"
          hint={
            replaces
              ? `${replaces.name} is the primary contact now. Saving makes this one primary instead.`
              : 'A client has at most one primary contact.'
          }
          error={save.fieldErrors.isPrimary}
        >
          <Switch checked={isPrimary} onCheckedChange={setIsPrimary} />
        </FormField>
      </FormSection>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" loading={save.pending || settling}>
          {contact ? 'Save contact' : 'Add contact'}
        </Button>
      </div>
    </form>
  );
}
