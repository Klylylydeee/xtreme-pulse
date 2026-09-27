'use client';

import { useState, type MouseEvent, type ReactNode } from 'react';
import {
  createColumnHelper,
  createSortedRowModel,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  sortFn_datetime,
  sortFn_text,
  tableFeatures,
  useTable,
  type ColumnDef,
  type Row,
  type RowData,
  type SortingState,
} from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ChevronRight, ChevronsUpDown } from 'lucide-react';
import { cn } from '../lib/utils';
import { Button } from './button';
import { Select } from './form';
import { Skeleton } from './skeleton';

/** Per-column display options for the data table. */
export type DataTableColumnMeta = {
  /** `end` for numbers and amounts, which also get tabular numerals. */
  align?: 'start' | 'end';
  /** Tabular numerals without end alignment (times, dates). */
  numeric?: boolean;
  /** A fixed column width, e.g. `8rem`. */
  width?: string;
  /** Hide this column below the `md` breakpoint when the table scrolls on phones. */
  hideOnPhone?: boolean;
};

/**
 * The table features every data table uses: sorting, with the built-in sort functions registered.
 * Build columns with `createDataTableColumns<Row>()` so they type-check against these.
 */
export const dataTableFeatures = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: {
    alphanumeric: sortFn_alphanumeric,
    basic: sortFn_basic,
    datetime: sortFn_datetime,
    text: sortFn_text,
  },
  columnMeta: {} as DataTableColumnMeta,
});

export type DataTableFeatures = typeof dataTableFeatures;
export type DataTableColumn<TData extends RowData> = ColumnDef<DataTableFeatures, TData, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export type DataTableRow<TData extends RowData> = Row<DataTableFeatures, TData>;

/** The TanStack column helper for data table columns. */
export function createDataTableColumns<TData extends RowData>() {
  return createColumnHelper<DataTableFeatures, TData>();
}

const LOADING_ROWS = 5;

function NothingToShow() {
  return <p className="py-8 text-center text-subheadline text-text-secondary">Nothing to show.</p>;
}

/**
 * The data table for lists (DESIGN_SYSTEM.md › Shared components), on TanStack Table.
 *
 * - Sortable headers are buttons that announce the sort (`aria-sort`).
 * - With `onRowSelect`, each row opens the item (e.g. in an inspector panel) by a click anywhere on
 *   it, or by its button in the first cell (Tab, then Enter or Space). The selected row is marked
 *   with `aria-current`.
 * - On phones, `renderPhoneRow` shows the rows as an inset list instead; without it the table
 *   scrolls sideways inside its own card, never the page.
 * - `loading` shows skeleton rows; `empty` is shown when there are no rows.
 */
export function DataTable<TData extends RowData>({
  caption,
  captionHidden = false,
  columns,
  data,
  getRowId,
  onRowSelect,
  rowActionLabel,
  selectedRowId,
  renderPhoneRow,
  initialSorting,
  loading = false,
  empty,
  className,
}: {
  /** The table's accessible name. */
  caption: string;
  /** Hide the caption visually when a heading beside the table already names it. */
  captionHidden?: boolean;
  columns: DataTableColumn<TData>[];
  /** Keep the array stable (state or memo) so the table doesn't rebuild every render. */
  data: TData[];
  getRowId: (row: TData) => string;
  /** Opens a row. `element` is the row's button, where focus should return on close. */
  onRowSelect?: (row: TData, element: HTMLElement) => void;
  /**
   * The accessible name of each row's button, e.g. "Details for Wed Sep 16". Include the visible
   * text of the first cell. Defaults to that text.
   */
  rowActionLabel?: (row: TData) => string;
  selectedRowId?: string | null;
  renderPhoneRow?: (row: TData) => ReactNode;
  initialSorting?: SortingState;
  loading?: boolean;
  /** Shown in place of the rows when there are none, e.g. an EmptyState. */
  empty?: ReactNode;
  className?: string;
}) {
  const [sorting, setSorting] = useState<SortingState>(initialSorting ?? []);
  const table = useTable({
    features: dataTableFeatures,
    columns,
    data,
    getRowId,
    state: { sorting },
    onSortingChange: setSorting,
  });

  const rows = table.getRowModel().rows;
  const headerGroups = table.getHeaderGroups();
  const columnCount = table.getAllLeafColumns().length;
  const isEmpty = !loading && rows.length === 0;

  const colWidths = table.getAllLeafColumns().map((column) => column.columnDef.meta?.width);

  // A click anywhere on a row opens it; the row's button (in its first cell) is what keyboard and
  // screen reader users reach, and where focus returns.
  function rowClick(event: MouseEvent<HTMLElement>, row: TData) {
    const action = event.currentTarget.querySelector<HTMLElement>('[data-row-action]');
    onRowSelect?.(row, action ?? event.currentTarget);
  }

  const sortable = table.getAllLeafColumns().filter((column) => column.getCanSort());
  const sortedBy = sorting[0];
  const columnName = (id: string) => {
    const header = table.getColumn(id)?.columnDef.header;
    return typeof header === 'string' ? header : id;
  };

  // Phones have no header row, so a compact sort control sits above the list.
  const phoneSort =
    renderPhoneRow && sortable.length > 0 ? (
      <div className="mb-2 flex items-center justify-end gap-2 md:hidden">
        <Select
          aria-label="Sort by"
          value={sortedBy?.id ?? ''}
          onChange={(event) => {
            const id = event.target.value;
            const column = id ? table.getColumn(id) : undefined;
            setSorting(column ? [{ id, desc: column.getAutoSortDir() === 'desc' }] : []);
          }}
          className="w-auto min-w-40"
        >
          <option value="">Default order</option>
          {sortable.map((column) => (
            <option key={column.id} value={column.id}>
              Sort by {columnName(column.id)}
            </option>
          ))}
        </Select>
        <Button
          variant="secondary"
          size="icon"
          disabled={!sortedBy}
          aria-label={
            sortedBy?.desc
              ? 'Sorted descending. Sort ascending'
              : 'Sorted ascending. Sort descending'
          }
          onClick={() => sortedBy && setSorting([{ id: sortedBy.id, desc: !sortedBy.desc }])}
        >
          {sortedBy?.desc ? <ArrowDown aria-hidden="true" /> : <ArrowUp aria-hidden="true" />}
        </Button>
      </div>
    ) : null;

  const phoneList = renderPhoneRow ? (
    <div
      data-slot="data-table-phone"
      className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card md:hidden"
    >
      {loading
        ? Array.from({ length: LOADING_ROWS }, (_, index) => (
            <div key={index} className="flex items-center gap-3 px-4 py-3">
              <Skeleton className="size-11 rounded-xl" />
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            </div>
          ))
        : rows.map((row) =>
            onRowSelect ? (
              <button
                key={row.id}
                type="button"
                aria-current={row.id === selectedRowId ? 'true' : undefined}
                onClick={(event) => onRowSelect(row.original, event.currentTarget)}
                className={cn(
                  'flex min-h-18 w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left',
                  'transition-colors duration-fast hover:bg-accent-subtle/50 focus-visible:-outline-offset-2',
                  'aria-[current=true]:bg-accent-subtle',
                )}
              >
                <span className="flex min-w-0 flex-1 items-center gap-3">
                  {renderPhoneRow(row.original)}
                </span>
                <ChevronRight aria-hidden="true" className="size-4.5 shrink-0 text-text-tertiary" />
              </button>
            ) : (
              <div key={row.id} className="flex min-h-18 items-center gap-3 px-4 py-2.5">
                {renderPhoneRow(row.original)}
              </div>
            ),
          )}
      {isEmpty ? <div className="p-4">{empty ?? <NothingToShow />}</div> : null}
    </div>
  ) : null;

  return (
    <div data-slot="data-table" className={cn('min-w-0', className)}>
      {phoneSort}
      {phoneList}
      <div
        className={cn(
          'overflow-hidden rounded-card bg-surface shadow-card',
          renderPhoneRow && 'hidden md:block',
        )}
      >
        {/* Scrolls sideways here, inside the card, when the columns don't fit. */}
        <div className="overflow-x-auto overscroll-x-contain">
          <table
            aria-busy={loading || undefined}
            className="w-full border-collapse text-subheadline text-text-primary"
          >
            <caption
              className={cn('px-5 pt-4 pb-2 text-left text-headline', captionHidden && 'sr-only')}
            >
              {caption}
            </caption>
            {colWidths.some(Boolean) ? (
              <colgroup>
                {colWidths.map((width, index) => (
                  <col key={index} style={width ? { width } : undefined} />
                ))}
              </colgroup>
            ) : null}
            <thead>
              {headerGroups.map((group) => (
                <tr key={group.id}>
                  {group.headers.map((header) => {
                    const meta = header.column.columnDef.meta;
                    const sorted = header.column.getIsSorted();
                    const canSort = header.column.getCanSort();
                    const end = meta?.align === 'end';
                    return (
                      <th
                        key={header.id}
                        scope="col"
                        aria-sort={
                          sorted === 'asc'
                            ? 'ascending'
                            : sorted === 'desc'
                              ? 'descending'
                              : undefined
                        }
                        className={cn(
                          'h-11 border-b border-separator px-3 text-footnote font-semibold whitespace-nowrap text-text-secondary first:pl-5 last:pr-5',
                          end ? 'text-right' : 'text-left',
                          meta?.hideOnPhone && 'hidden md:table-cell',
                        )}
                      >
                        {header.isPlaceholder ? null : canSort ? (
                          <button
                            type="button"
                            onClick={header.column.getToggleSortingHandler()}
                            className={cn(
                              '-mx-2 inline-flex min-h-11 cursor-pointer items-center gap-1 rounded-md px-2',
                              'transition-colors duration-fast hover:text-text-primary',
                              end && 'flex-row-reverse',
                              sorted && 'text-text-primary',
                            )}
                          >
                            <table.FlexRender header={header} />
                            {sorted === 'asc' ? (
                              <ArrowUp aria-hidden="true" className="size-3.5" />
                            ) : sorted === 'desc' ? (
                              <ArrowDown aria-hidden="true" className="size-3.5" />
                            ) : (
                              <ChevronsUpDown aria-hidden="true" className="size-3.5 opacity-60" />
                            )}
                          </button>
                        ) : (
                          <table.FlexRender header={header} />
                        )}
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
            <tbody>
              {loading
                ? Array.from({ length: LOADING_ROWS }, (_, index) => (
                    <tr key={index} aria-hidden="true">
                      {Array.from({ length: columnCount }, (_, cell) => (
                        <td
                          key={cell}
                          className="h-14 border-b border-separator px-3 first:pl-5 last:pr-5"
                        >
                          <Skeleton className="h-4 w-full max-w-32" />
                        </td>
                      ))}
                    </tr>
                  ))
                : rows.map((row) => {
                    const selected = row.id === selectedRowId;
                    return (
                      <tr
                        key={row.id}
                        aria-current={selected ? 'true' : undefined}
                        onClick={onRowSelect ? (event) => rowClick(event, row.original) : undefined}
                        className={cn(
                          'transition-colors duration-fast [&:last-child>td]:border-b-0',
                          onRowSelect && 'cursor-pointer hover:bg-accent-subtle/50',
                          selected && 'bg-accent-subtle hover:bg-accent-subtle',
                        )}
                      >
                        {row.getAllCells().map((cell, cellIndex) => {
                          const meta = cell.column.columnDef.meta;
                          return (
                            <td
                              key={cell.id}
                              className={cn(
                                'h-14 border-b border-separator px-3 first:pl-5 last:pr-5',
                                meta?.align === 'end' && 'text-right numeric',
                                meta?.numeric && 'numeric',
                                meta?.hideOnPhone && 'hidden md:table-cell',
                              )}
                            >
                              {onRowSelect && cellIndex === 0 ? (
                                <button
                                  type="button"
                                  data-row-action=""
                                  aria-label={rowActionLabel?.(row.original)}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    onRowSelect(row.original, event.currentTarget);
                                  }}
                                  className="-mx-2 inline-flex min-h-11 cursor-pointer items-center rounded-md px-2 text-left"
                                >
                                  <table.FlexRender cell={cell} />
                                </button>
                              ) : (
                                <table.FlexRender cell={cell} />
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
              {isEmpty ? (
                <tr>
                  <td colSpan={columnCount} className="p-4">
                    {empty ?? <NothingToShow />}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
