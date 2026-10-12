'use client';

import { useId } from 'react';
import { CircleAlert, Plus, Trash2 } from 'lucide-react';
import type { FieldErrors } from '@pulse/core';
import { cn } from '@pulse/ui';
import { Button } from '@pulse/ui/components/button';
import { Input, Select } from '@pulse/ui/components/form';
import { getIn, setIn } from './payroll-format';

// Spec: docs/modules/talent.md#payroll-settings-and-allowances-build-step-23 ("Adding a version")
// and docs/DESIGN_SYSTEM.md#layout--components — an editable grid for a table setting (SSS,
// Pag-IBIG, withholding tax, de minimis limits, minimum wages): one input per cell, a row to add
// and a remove button on each row. The grid scrolls sideways inside its own region, so the page
// and the sheet never do. A field error under `value.<rows>.<index>.<field>` marks its cell
// (`aria-invalid`, described by its message), and every message for the table is listed under it,
// each naming its row and column, with a button that moves focus to the cell.

export type GridCellKind = 'peso' | 'rate' | 'integer' | 'text' | 'select';

export interface GridColumn {
  /** The field in a row, dotted for nested ones: `employee.regularCentavos`. */
  field: string;
  label: string;
  /** A shorter header shown above several columns that belong together. */
  group?: string;
  kind: GridCellKind;
  options?: readonly { value: string; label: string }[];
  /** The cell's minimum width, as a Tailwind class. */
  width?: string;
  placeholder?: string;
}

type Row = Record<string, unknown>;

export function GridEditor<TRow extends Row>({
  caption,
  hint,
  columns,
  rows,
  onRowsChange,
  errors,
  path,
  newRow,
  minRows = 1,
  addLabel = 'Add row',
}: {
  caption: string;
  hint?: string;
  columns: readonly GridColumn[];
  rows: readonly TRow[];
  onRowsChange: (rows: TRow[]) => void;
  errors: FieldErrors;
  /** The rows' path in the field errors: `value.rows`. */
  path: string;
  newRow: () => TRow;
  minRows?: number;
  addLabel?: string;
}) {
  const gridId = useId();
  const cellId = (row: number, field: string) => `${gridId}-${row}-${field.replace('.', '-')}`;
  const errorId = (key: string) => `${gridId}-error-${key.replace(/[^\w-]/g, '-')}`;

  // Every message for this table, in row order, each with the cell it belongs to (if any).
  const messages = Object.entries(errors)
    .filter(
      (entry): entry is [string, string] =>
        Boolean(entry[1]) && (entry[0] === path || entry[0].startsWith(`${path}.`)),
    )
    .map(([key, message]) => {
      const rest = key === path ? [] : key.slice(path.length + 1).split('.');
      const row = rest[0] !== undefined && /^\d+$/.test(rest[0]) ? Number(rest[0]) : null;
      const field = rest.slice(1).join('.');
      const column = columns.find((candidate) => candidate.field === field) ?? null;
      return { key, message, row, column };
    })
    .sort((a, b) => (a.row ?? -1) - (b.row ?? -1));

  function changeCell(index: number, field: string, value: string) {
    onRowsChange(rows.map((row, i) => (i === index ? setIn(row, field, value) : row)));
  }

  function focusCell(row: number, field: string | undefined) {
    requestAnimationFrame(() => {
      const target = document.getElementById(cellId(row, field ?? columns[0]?.field ?? ''));
      target?.focus();
    });
  }

  function addRow() {
    onRowsChange([...rows, newRow()]);
    focusCell(rows.length, columns[0]?.field);
  }

  function removeRow(index: number) {
    onRowsChange(rows.filter((_, i) => i !== index));
    // Focus stays in the grid: on the row that took its place, or the new last row.
    if (rows.length > 1) focusCell(Math.min(index, rows.length - 2), columns[0]?.field);
  }

  const grouped = columns.some((column) => column.group);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5 px-4">
        <h3 className="text-footnote font-semibold text-text-secondary">{caption}</h3>
        {hint ? <p className="text-footnote text-text-secondary">{hint}</p> : null}
      </div>
      <div
        role="region"
        aria-label={`${caption}, editable`}
        className="overflow-x-auto overscroll-x-contain rounded-card bg-surface shadow-card"
      >
        <table className="w-full border-collapse text-subheadline text-text-primary">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              <th
                scope="col"
                className="h-11 w-12 border-b border-separator pl-4 text-left text-footnote font-semibold text-text-secondary"
              >
                <span className="sr-only">Row</span>
              </th>
              {columns.map((column) => (
                <th
                  key={column.field}
                  scope="col"
                  className={cn(
                    'h-11 border-b border-separator px-1.5 py-2 text-left align-bottom text-footnote font-semibold text-text-secondary',
                    column.width ?? 'min-w-28',
                  )}
                >
                  {grouped && column.group ? (
                    <span className="block font-medium whitespace-nowrap">{column.group}</span>
                  ) : null}
                  <span className="whitespace-nowrap">{column.label}</span>
                </th>
              ))}
              <th scope="col" className="h-11 w-14 border-b border-separator pr-2">
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const rowError = errors[`${path}.${index}`];
              return (
                <tr key={index} className="border-b border-separator last:border-b-0">
                  <th
                    scope="row"
                    className={cn(
                      'numeric pl-4 text-left text-footnote font-medium text-text-secondary',
                      rowError && 'text-destructive-text',
                    )}
                  >
                    {index + 1}
                    {rowError ? (
                      <CircleAlert aria-label="Has an error" className="ml-1 inline size-3.5" />
                    ) : null}
                  </th>
                  {columns.map((column) => {
                    const key = `${path}.${index}.${column.field}`;
                    const error = errors[key];
                    const id = cellId(index, column.field);
                    const value = String(getIn(row, column.field) ?? '');
                    const label = `${column.group ? `${column.group}, ` : ''}${column.label}, row ${index + 1}`;
                    const common = {
                      id,
                      'aria-label': label,
                      'aria-invalid': error ? true : undefined,
                      'aria-describedby': error ? errorId(key) : undefined,
                    } as const;
                    return (
                      <td key={column.field} className="px-1.5 py-1.5">
                        {column.kind === 'select' ? (
                          <Select
                            {...common}
                            value={value}
                            onChange={(event) =>
                              changeCell(index, column.field, event.target.value)
                            }
                          >
                            {value === '' ? <option value="">Choose…</option> : null}
                            {column.options?.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </Select>
                        ) : (
                          <Input
                            {...common}
                            value={value}
                            onChange={(event) =>
                              changeCell(index, column.field, event.target.value)
                            }
                            inputMode={
                              column.kind === 'peso' || column.kind === 'rate'
                                ? 'decimal'
                                : column.kind === 'integer'
                                  ? 'numeric'
                                  : undefined
                            }
                            autoComplete="off"
                            spellCheck={false}
                            placeholder={column.placeholder}
                            className={cn(column.kind !== 'text' && 'numeric text-right')}
                          />
                        )}
                      </td>
                    );
                  })}
                  <td className="pr-2">
                    <Button
                      variant="plain"
                      size="icon"
                      aria-label={`Remove row ${index + 1}`}
                      disabled={rows.length <= minRows}
                      onClick={() => removeRow(index)}
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-2 px-1">
        <Button variant="tinted" onClick={addRow}>
          <Plus aria-hidden="true" className="size-4.5" />
          {addLabel}
        </Button>
        <span className="numeric text-footnote text-text-secondary">
          {rows.length} {rows.length === 1 ? 'row' : 'rows'}
        </span>
      </div>
      {/* Always present, so new messages are announced as they appear. */}
      <div aria-live="polite">
        {messages.length > 0 ? (
          <ul className="flex flex-col gap-1 rounded-card bg-surface px-4 py-3 shadow-card">
            {messages.map(({ key, message, row, column }) => (
              <li
                key={key}
                id={errorId(key)}
                className="flex items-start gap-1.5 text-footnote font-medium text-destructive-text"
              >
                <CircleAlert aria-hidden="true" className="mt-px size-4 shrink-0" />
                <span className="min-w-0">
                  {row !== null ? (
                    <button
                      type="button"
                      onClick={() => focusCell(row, column?.field)}
                      className="cursor-pointer underline underline-offset-2"
                    >
                      Row {row + 1}
                      {column ? `, ${column.group ? `${column.group}, ` : ''}${column.label}` : ''}
                    </button>
                  ) : null}
                  {row !== null ? ': ' : null}
                  {message}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
