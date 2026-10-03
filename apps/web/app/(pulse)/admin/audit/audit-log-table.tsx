'use client';

import { useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { formatDateTime } from '@pulse/core';
import type { AuditEntryView } from '@pulse/core/server';
import {
  createDataTableColumns,
  DataTable,
  type DataTableColumn,
} from '@pulse/ui/components/data-table';
import { IconTile } from '@pulse/ui/components/icon-tile';
import { InspectorLayout, InspectorPanel } from '@pulse/ui/components/inspector-panel';
import { auditActionLabel, moduleDisplay } from '@/lib/module-labels';
import { SnapshotChanges } from './snapshot-changes';

// Spec: docs/modules/core.md#audit-log — one page of entries, newest first. A row opens the
// inspector with the entry's details and its before → after comparison. The page is already
// sorted by time on the server (keyset paging), so the columns don't re-sort it.

const column = createDataTableColumns<AuditEntryView>();

function actorName(entry: AuditEntryView): string {
  return entry.actorEmail ?? (entry.actorId ? 'Unknown user' : 'System');
}

function recordName(entry: AuditEntryView): string {
  return entry.record.label ?? entry.record.type;
}

const COLUMNS: DataTableColumn<AuditEntryView>[] = column.columns([
  column.accessor('createdAt', {
    header: 'Time',
    enableSorting: false,
    cell: (info) => (
      <time dateTime={info.getValue().toISOString()} className="whitespace-nowrap">
        {formatDateTime(info.getValue())}
      </time>
    ),
    meta: { numeric: true, width: '12rem' },
  }),
  column.accessor((entry) => actorName(entry), {
    id: 'actor',
    header: 'Actor',
    enableSorting: false,
    cell: (info) => <span className="whitespace-nowrap">{info.getValue()}</span>,
  }),
  column.accessor('module', {
    header: 'Module',
    enableSorting: false,
    cell: (info) => (
      <span className="whitespace-nowrap">{moduleDisplay(info.getValue()).title}</span>
    ),
    meta: { width: '9rem' },
  }),
  column.accessor('action', {
    header: 'Action',
    enableSorting: false,
    cell: (info) => <span className="whitespace-nowrap">{auditActionLabel(info.getValue())}</span>,
    meta: { width: '10rem' },
  }),
  column.accessor((entry) => recordName(entry), {
    id: 'record',
    header: 'Record',
    enableSorting: false,
    cell: (info) => (
      <span className="flex min-w-40 flex-col">
        <span className="whitespace-nowrap">{info.getValue()}</span>
        {info.row.original.record.label ? (
          <span className="text-footnote text-text-secondary">{info.row.original.record.type}</span>
        ) : null}
      </span>
    ),
  }),
]);

function DetailRow({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 px-3.5 py-2.5">
      <dt className="text-footnote text-text-secondary">{term}</dt>
      <dd className="text-subheadline break-words text-text-primary">{children}</dd>
    </div>
  );
}

function FilterLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="-mx-1 inline-flex min-h-11 items-center rounded-md px-1 text-subheadline font-medium text-accent hover:underline"
    >
      {children}
    </Link>
  );
}

function EntryDetails({ entry }: { entry: AuditEntryView }) {
  const recordQuery = new URLSearchParams({ recordType: entry.record.type });
  if (entry.record.id) recordQuery.set('recordId', entry.record.id);
  return (
    <>
      <dl className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface">
        <DetailRow term="When">
          <time dateTime={entry.createdAt.toISOString()} className="numeric">
            {formatDateTime(entry.createdAt)}
          </time>
        </DetailRow>
        <DetailRow term="Actor">
          <span className="flex flex-col items-start">
            <span className="break-all">{actorName(entry)}</span>
            {entry.actorId ? (
              <>
                <span className="text-footnote break-all text-text-secondary numeric">
                  {entry.actorId}
                </span>
                <FilterLink href={`/admin/audit?actorId=${entry.actorId}`}>
                  Show this actor’s entries
                </FilterLink>
              </>
            ) : null}
          </span>
        </DetailRow>
        <DetailRow term="Record">
          <span className="flex flex-col items-start">
            <span className="break-all">{recordName(entry)}</span>
            <span className="text-footnote break-all text-text-secondary">
              {entry.record.type}
              {entry.record.id ? <span className="numeric"> · {entry.record.id}</span> : null}
            </span>
            <FilterLink href={`/admin/audit?${recordQuery.toString()}`}>
              Show this record’s entries
            </FilterLink>
          </span>
        </DetailRow>
        {entry.fields.length > 0 ? (
          <DetailRow term={entry.action === 'export' ? 'Fields exported' : 'Fields revealed'}>
            <ul className="mt-1 flex flex-wrap gap-1.5">
              {entry.fields.map((field) => (
                <li
                  key={field}
                  className="rounded-md bg-accent-subtle px-2 py-0.5 text-footnote font-medium text-accent"
                >
                  {field}
                </li>
              ))}
            </ul>
          </DetailRow>
        ) : null}
        <DetailRow term="Reason">
          {entry.reason ? (
            <span className="whitespace-pre-wrap">{entry.reason}</span>
          ) : (
            <span className="text-text-secondary italic">None given</span>
          )}
        </DetailRow>
      </dl>
      <SnapshotChanges before={entry.before} after={entry.after} />
    </>
  );
}

export function AuditLogTable({ entries }: { entries: AuditEntryView[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The row that opened the inspector, where focus returns on close.
  const rowRef = useRef<HTMLElement | null>(null);
  const selected = useMemo(
    () => entries.find((entry) => entry.id === selectedId) ?? null,
    [entries, selectedId],
  );

  return (
    <InspectorLayout>
      <div className="min-w-0 flex-1">
        <DataTable
          caption="Audit log entries, newest first"
          captionHidden
          columns={COLUMNS}
          data={entries}
          getRowId={(entry) => entry.id}
          selectedRowId={selectedId}
          rowActionLabel={(entry) =>
            `Details for ${auditActionLabel(entry.action)}, ${formatDateTime(entry.createdAt)}`
          }
          onRowSelect={(entry, element) => {
            rowRef.current = element;
            setSelectedId(entry.id);
          }}
          renderPhoneRow={(entry) => {
            const { Icon } = moduleDisplay(entry.module);
            return (
              <>
                <IconTile className="size-11 rounded-xl [&_svg]:size-5">
                  <Icon strokeWidth={1.75} />
                </IconTile>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-subheadline font-semibold">
                    {auditActionLabel(entry.action)} · {recordName(entry)}
                  </span>
                  <span className="truncate text-footnote text-text-secondary">
                    {actorName(entry)}
                  </span>
                  <time
                    dateTime={entry.createdAt.toISOString()}
                    className="text-footnote text-text-secondary numeric"
                  >
                    {formatDateTime(entry.createdAt)}
                  </time>
                </span>
              </>
            );
          }}
        />
      </div>
      <InspectorPanel
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
        eyebrow={selected ? moduleDisplay(selected.module).title : undefined}
        title={selected ? auditActionLabel(selected.action) : ''}
        returnFocus={rowRef}
        closeLabel="Close entry details"
      >
        {selected ? <EntryDetails entry={selected} /> : null}
      </InspectorPanel>
    </InspectorLayout>
  );
}
