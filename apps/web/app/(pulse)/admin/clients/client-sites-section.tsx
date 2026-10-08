'use client';

import { useId, useState, type FormEvent } from 'react';
import { MapPin, Plus } from 'lucide-react';
import { ADDRESS_MAX_LENGTH, CITY_MAX_LENGTH, MASTER_NAME_MAX_LENGTH } from '@pulse/core';
import type { ClientSiteView } from '@pulse/core/server';
import { Button } from '@pulse/ui/components/button';
import { EmptyState } from '@pulse/ui/components/empty-state';
import { FormField, FormSection, Input, Textarea } from '@pulse/ui/components/form';
import { FormAlert } from '@/components/form-alert';
import { Badge, useActionSubmit } from '@/components/org-structure';
import {
  addClientSiteAction,
  removeClientSiteAction,
  restoreClientSiteAction,
  updateClientSiteAction,
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
// — a client's sites, each added, edited, removed (a soft delete) or restored by its own action. A
// site name is unique within the client, removed sites included; the refusal points to Restore.
// Nothing changes on a retired client: the list is read-only until the client is restored.

/** "Makati City · 123 Ayala Ave", or null. */
function siteSummary(site: ClientSiteView): string | null {
  const parts = [site.city, site.address].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

export function ClientSitesSection({
  clientId,
  sites,
  readOnly,
  onChanged,
}: {
  clientId: string;
  /** Live and removed sites. */
  sites: ClientSiteView[];
  /** The client is retired: no changes until it is restored. */
  readOnly: boolean;
  /** Reloads the sites (and refreshes the client list's counts). */
  onChanged: () => Promise<void>;
}) {
  const baseId = useId();
  const addId = `${baseId}-add`;
  const editId = (id: string) => `${baseId}-edit-${id}`;
  const focusLater = useFocusLater();
  // 'new', a site's id, or null: one form open at a time.
  const [editing, setEditing] = useState<string | null>(null);
  const [showRemoved, setShowRemoved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const live = sites.filter((site) => !site.removedAt);
  const removed = sites.filter((site) => site.removedAt);
  const shown = showRemoved ? sites : live;

  function closeForm(focusId: string) {
    setEditing(null);
    focusLater(focusId);
  }

  return (
    <section aria-label="Sites" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        {readOnly ? (
          <p className="text-footnote text-text-secondary">
            Restore the client to change its sites.
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
            Add site
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
        <SiteForm
          clientId={clientId}
          site={null}
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
          icon={<MapPin strokeWidth={1.75} />}
          title="No sites yet"
          description="Sites are the client’s locations, such as branches and offices, where work and deliveries go."
        />
      ) : shown.length > 0 ? (
        <RowCard label="Sites">
          {shown.map((site) =>
            editing === site.id ? (
              <li key={site.id} className="p-2">
                <SiteForm
                  clientId={clientId}
                  site={site}
                  onCancel={() => closeForm(editId(site.id))}
                  onSaved={async () => {
                    await onChanged();
                    closeForm(editId(site.id));
                  }}
                />
              </li>
            ) : (
              <Row
                key={site.id}
                removed={Boolean(site.removedAt)}
                actions={
                  readOnly ? null : site.removedAt ? (
                    <RestoreRowButton
                      id={site.id}
                      label={`Restore ${site.name}`}
                      action={restoreClientSiteAction}
                      onError={setError}
                      onRestored={async () => {
                        await onChanged();
                        focusLater(editId(site.id));
                      }}
                    />
                  ) : (
                    <>
                      <EditRowButton
                        id={editId(site.id)}
                        label={`Edit ${site.name}`}
                        onClick={() => {
                          setError(null);
                          setEditing(site.id);
                        }}
                      />
                      <RemoveRowButton
                        id={site.id}
                        label={`Remove ${site.name}`}
                        title={`Remove ${site.name}?`}
                        description="It can’t be picked for new records, and its name stays reserved for this client. You can restore it later from “Show removed”."
                        confirmLabel="Remove site"
                        action={removeClientSiteAction}
                        onRemoved={async () => {
                          await onChanged();
                          focusLater(addId);
                        }}
                      />
                    </>
                  )
                }
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-subheadline font-medium text-text-primary">
                    {site.name}
                  </span>
                  {site.removedAt ? <Badge>Removed</Badge> : null}
                </span>
                {siteSummary(site) ? (
                  <span className="text-footnote break-words whitespace-pre-line text-text-secondary">
                    {siteSummary(site)}
                  </span>
                ) : null}
                {site.siteContact ? (
                  <span className="text-footnote text-text-secondary">
                    Site contact: {site.siteContact}
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

/** The inline add or edit form for one site. */
function SiteForm({
  clientId,
  site,
  onCancel,
  onSaved,
}: {
  clientId: string;
  site: ClientSiteView | null;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const save = useActionSubmit<unknown>(
    site ? updateClientSiteAction : addClientSiteAction,
    () => undefined,
  );
  const [settling, setSettling] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const text = (key: string) => String(data.get(key) ?? '');
    const ok = await save.run({
      ...(site ? { id: site.id } : { clientId }),
      name: text('name'),
      address: text('address'),
      city: text('city'),
      siteContact: text('siteContact'),
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
      <FormSection title={site ? `Edit ${site.name}` : 'New site'}>
        <FormField label="Name" required error={save.fieldErrors.name}>
          <Input
            name="name"
            defaultValue={site?.name ?? ''}
            maxLength={MASTER_NAME_MAX_LENGTH}
            autoComplete="off"
            autoFocus
            required
          />
        </FormField>
        <FormField label="City" error={save.fieldErrors.city}>
          <Input
            name="city"
            defaultValue={site?.city ?? ''}
            maxLength={CITY_MAX_LENGTH}
            autoComplete="off"
          />
        </FormField>
        <FormField label="Address" error={save.fieldErrors.address}>
          <Textarea
            name="address"
            defaultValue={site?.address ?? ''}
            maxLength={ADDRESS_MAX_LENGTH}
            autoComplete="off"
          />
        </FormField>
        <FormField
          label="Site contact"
          hint="Optional. Who to ask for at the site."
          error={save.fieldErrors.siteContact}
        >
          <Input
            name="siteContact"
            defaultValue={site?.siteContact ?? ''}
            maxLength={MASTER_NAME_MAX_LENGTH}
            autoComplete="off"
          />
        </FormField>
      </FormSection>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" loading={save.pending || settling}>
          {site ? 'Save site' : 'Add site'}
        </Button>
      </div>
    </form>
  );
}
