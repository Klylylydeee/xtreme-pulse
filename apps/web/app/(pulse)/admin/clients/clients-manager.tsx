'use client';

import { useId, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Building, CircleCheck, Plus, Search } from 'lucide-react';
import type { ClientView } from '@pulse/core/server';
import { Button } from '@pulse/ui/components/button';
import {
  createDataTableColumns,
  DataTable,
  type DataTableColumn,
} from '@pulse/ui/components/data-table';
import { EmptyState } from '@pulse/ui/components/empty-state';
import { Input } from '@pulse/ui/components/form';
import { IconTile } from '@pulse/ui/components/icon-tile';
import { PageHeader } from '@pulse/ui/components/page-header';
import { Sheet, SheetContent } from '@pulse/ui/components/sheet';
import { useReturnFocus } from '@pulse/ui/hooks/use-return-focus';
import { InactiveEmployeeBadge } from '@/components/employee-picker';
import { Badge, plural, ShowRetiredSwitch } from '@/components/org-structure';
import { ClientSheet } from './client-sheet';

// Spec: docs/modules/core.md#managing-master-data and docs/modules/engage.md#clients-sites-and-contacts
// — the clients list, with search. A row opens its sheet: Details, Sites and Contacts for a live
// client, or the same read-only with Restore for a retired one. A new client is saved first;
// its sites and contacts then unlock in the same sheet.

/** "2 sites · 1 contact". */
export function sitesAndContacts(client: Pick<ClientView, 'siteCount' | 'contactCount'>): string {
  return `${plural(client.siteCount, 'site', 'sites')} · ${plural(client.contactCount, 'contact', 'contacts')}`;
}

/** True when the search text matches the client's name, TIN, industry or Account Manager. */
function matches(client: ClientView, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  const digits = needle.replace(/[\s-]/g, '');
  return (
    client.name.toLocaleLowerCase().includes(needle) ||
    (digits !== '' && /^\d+$/.test(digits) && (client.tin ?? '').includes(digits)) ||
    (client.industry ?? '').toLocaleLowerCase().includes(needle) ||
    (client.accountManagerName ?? '').toLocaleLowerCase().includes(needle)
  );
}

/** The Account Manager's name with its Inactive badge, or "None". */
function AccountManager({ client }: { client: ClientView }) {
  if (!client.accountManagerEmployeeId) {
    return <span className="text-text-secondary">None</span>;
  }
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="truncate">{client.accountManagerName ?? 'Unknown employee'}</span>
      {client.accountManagerActive === false ? <InactiveEmployeeBadge /> : null}
    </span>
  );
}

const column = createDataTableColumns<ClientView>();

const COLUMNS: DataTableColumn<ClientView>[] = column.columns([
  column.accessor('name', {
    header: 'Name',
    sortFn: 'text',
    cell: (info) => (
      <span className="flex min-w-40 items-center gap-2">
        <span className="font-medium">{info.getValue()}</span>
        {info.row.original.retiredAt ? <Badge>Retired</Badge> : null}
      </span>
    ),
  }),
  column.accessor((client) => client.tinDisplay ?? '', {
    id: 'tin',
    header: 'TIN',
    sortFn: 'text',
    cell: (info) =>
      info.getValue() ? (
        <span className="whitespace-nowrap numeric">{info.getValue()}</span>
      ) : (
        <span className="text-text-secondary">None</span>
      ),
    meta: { width: '12rem' },
  }),
  column.accessor((client) => client.accountManagerName ?? '', {
    id: 'accountManager',
    header: 'Account Manager',
    sortFn: 'text',
    cell: (info) => <AccountManager client={info.row.original} />,
  }),
  column.accessor((client) => client.siteCount, {
    id: 'sites',
    header: 'Sites and contacts',
    sortFn: 'basic',
    cell: (info) => (
      <span className="whitespace-nowrap numeric">{sitesAndContacts(info.row.original)}</span>
    ),
    meta: { width: '12rem' },
  }),
]);

function ClientPhoneRow({ client }: { client: ClientView }) {
  return (
    <>
      <IconTile className="size-11 rounded-xl [&_svg]:size-5">
        <Building strokeWidth={1.75} />
      </IconTile>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-subheadline font-semibold">{client.name}</span>
          {client.retiredAt ? <Badge>Retired</Badge> : null}
        </span>
        <span className="flex min-w-0 items-center gap-2 text-footnote text-text-secondary">
          <span className="truncate">
            {client.accountManagerName ?? 'No Account Manager'}
            {client.tinDisplay ? (
              <>
                {' · TIN '}
                <span className="numeric">{client.tinDisplay}</span>
              </>
            ) : null}
          </span>
          {client.accountManagerActive === false ? <InactiveEmployeeBadge /> : null}
        </span>
        <span className="truncate text-footnote text-text-secondary numeric">
          {sitesAndContacts(client)}
        </span>
      </span>
    </>
  );
}

export function ClientsManager({
  clients,
  showRetired,
}: {
  clients: ClientView[];
  showRetired: boolean;
}) {
  const router = useRouter();
  const returnFocus = useReturnFocus();
  const searchId = useId();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  // Kept while the sheet closes, so its content doesn't change during the animation.
  const [target, setTarget] = useState<ClientView | null>(null);
  // A new sheet (fresh fields, tab and errors) every time it opens.
  const [session, setSession] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  function openSheet(client: ClientView | null, trigger?: HTMLElement | null) {
    returnFocus.remember(trigger);
    setTarget(client);
    setSession((count) => count + 1);
    setNotice(null);
    setOpen(true);
  }

  function finished(message: string) {
    setOpen(false);
    setNotice(message);
    router.refresh();
  }

  const shown = useMemo(() => clients.filter((client) => matches(client, query)), [clients, query]);
  const retiredCount = clients.filter((client) => client.retiredAt).length;
  const liveCount = clients.length - retiredCount;

  return (
    <>
      <PageHeader
        title="Clients"
        description="The companies Xtreme Works sells to, with their sites and contacts."
        actions={
          <Button onClick={(event) => openSheet(null, event.currentTarget)}>
            <Plus aria-hidden="true" className="size-5" />
            Add client
          </Button>
        }
      />
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <div className="flex w-full flex-col gap-1.5 sm:w-72">
          <label htmlFor={searchId} className="text-footnote font-semibold text-text-secondary">
            Search
          </label>
          <div className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 size-4.5 -translate-y-1/2 text-text-secondary"
            />
            <Input
              id={searchId}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Name, TIN, industry or Account Manager"
              autoComplete="off"
              spellCheck={false}
              maxLength={100}
              className="pl-10"
            />
          </div>
        </div>
        <ShowRetiredSwitch checked={showRetired} />
      </div>
      <p role="status" className="-mt-2 text-footnote text-text-secondary">
        {notice ? (
          <span className="inline-flex items-center gap-1.5 font-medium text-success-text">
            <CircleCheck aria-hidden="true" className="size-4 shrink-0" />
            {notice}
          </span>
        ) : (
          <span className="numeric">
            {query.trim()
              ? `${shown.length} of ${plural(clients.length, 'client', 'clients')}`
              : plural(liveCount, 'client', 'clients')}
            {showRetired && !query.trim() ? `, ${retiredCount} retired` : null}
          </span>
        )}
      </p>
      {clients.length === 0 ? (
        <EmptyState
          icon={<Building strokeWidth={1.75} />}
          title={showRetired ? 'No clients' : 'No clients yet'}
          description="Add the companies Xtreme Works sells to, then their sites and contacts."
          action={
            <Button variant="tinted" onClick={(event) => openSheet(null, event.currentTarget)}>
              <Plus aria-hidden="true" className="size-5" />
              Add client
            </Button>
          }
        />
      ) : shown.length === 0 ? (
        <EmptyState
          icon={<Search strokeWidth={1.75} />}
          title="No clients match"
          description="Try another name, TIN, industry or Account Manager."
          action={
            <Button variant="tinted" onClick={() => setQuery('')}>
              Clear search
            </Button>
          }
        />
      ) : (
        <DataTable
          caption="Clients"
          captionHidden
          columns={COLUMNS}
          data={shown}
          getRowId={(client) => client.id}
          initialSorting={[{ id: 'name', desc: false }]}
          selectedRowId={open ? target?.id : null}
          rowActionLabel={(client) =>
            client.retiredAt ? `Details for ${client.name}` : `Edit ${client.name}`
          }
          onRowSelect={(client, element) => openSheet(client, element)}
          renderPhoneRow={(client) => <ClientPhoneRow client={client} />}
        />
      )}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent aria-describedby={undefined} onCloseAutoFocus={returnFocus.onCloseAutoFocus}>
          <ClientSheet
            key={session}
            client={target}
            onFinished={finished}
            onListChanged={() => router.refresh()}
          />
        </SheetContent>
      </Sheet>
    </>
  );
}
