'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, UserRound, UserRoundX, Users } from 'lucide-react';
import type { ActionResult } from '@pulse/core';
import { cn } from '@pulse/ui';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@pulse/ui/components/command';
import { Button } from '@pulse/ui/components/button';
import { EmptyState } from '@pulse/ui/components/empty-state';
import { useFieldProps } from '@pulse/ui/components/form';
import { ErrorState } from '@pulse/ui/components/error-state';
import { Popover, PopoverContent, PopoverTrigger } from '@pulse/ui/components/popover';
import { Skeleton } from '@pulse/ui/components/skeleton';
import { Badge } from '@/components/org-structure';

// A single optional employee, picked from employees whose account resolves to active
// (SECURITY.md#account-status): the department head (docs/modules/core.md#managing-departments-and-positions)
// and, from step 1.8, a client's owning Account Manager (docs/modules/engage.md#clients-sites-and-contacts).
// The list is searched on the server by the `search` Server Action (name or employee number, at
// most 20), so the picker never holds the whole directory. The service checks the pick again on save.

/** The picked employee, as the form shows it. */
export interface PickedEmployee {
  id: string;
  name: string;
}

/** One row of the search results, as the search action returns it. */
export interface EmployeePickerOption {
  id: string;
  name: string;
  employeeNumber: string;
  departmentName: string | null;
}

/** The search Server Action: `defineAction` with a `{ search }` schema, returning the options. */
export type EmployeeSearchAction = (
  previous: null,
  input: { search: string },
) => Promise<ActionResult<EmployeePickerOption[]>>;

const SEARCH_DELAY_MS = 250;
const LOAD_FAILED = 'The employee list couldn’t load. Try again.';

type SearchState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'done'; options: EmployeePickerOption[] };

/**
 * "Inactive" next to a picked employee who is no longer active (a head or Account Manager who
 * separated after being set stays set, marked so). Color is never the only signal.
 */
export function InactiveEmployeeBadge() {
  return (
    <span title="No longer an active employee" className="inline-flex shrink-0">
      <Badge>Inactive</Badge>
    </span>
  );
}

/**
 * A searchable picker for one optional employee, posted as the hidden field `name` (empty for
 * none). Use it inside a FormField, which labels it and wires its error. Opens a popover with a
 * search field; the "none" row clears it. Shows a designed empty state while there are no
 * eligible employees (usual before employees are added).
 */
export function EmployeePicker({
  name,
  value,
  onChange,
  search: searchAction,
  noneLabel,
  chooseLabel,
  listLabel,
  emptyDescription,
  valueInactive = false,
}: {
  /** The hidden input's name, e.g. `headEmployeeId` or `accountManagerEmployeeId`. */
  name: string;
  value: PickedEmployee | null;
  onChange: (value: PickedEmployee | null) => void;
  /** Searches eligible employees on the server. */
  search: EmployeeSearchAction;
  /** The trigger text with nobody picked, and the row that clears it: "No head". */
  noneLabel: string;
  /** The popover's accessible name: "Choose the department head". */
  chooseLabel: string;
  /** The search list's accessible name: "Department head". */
  listLabel: string;
  /** The empty state's text while nobody can be picked at all. */
  emptyDescription: string;
  /** Shows the Inactive badge in the trigger: the saved employee, no longer active, still picked. */
  valueInactive?: boolean;
}) {
  // Labeled by its FormField, and wired to the field's error.
  const fieldProps = useFieldProps({});
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [state, setState] = useState<SearchState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const listId = useId();
  const latest = useRef(0);

  useEffect(() => {
    if (!open) return;
    // Whatever started this search already showed the loading rows (see startSearch).
    const request = ++latest.current;
    const timer = window.setTimeout(
      async () => {
        try {
          const result = await searchAction(null, { search });
          if (request !== latest.current) return;
          setState(
            result.ok
              ? { status: 'done', options: result.data }
              : { status: 'error', message: result.formError ?? LOAD_FAILED },
          );
        } catch {
          if (request === latest.current) {
            setState({ status: 'error', message: LOAD_FAILED });
          }
        }
      },
      search ? SEARCH_DELAY_MS : 0,
    );
    return () => window.clearTimeout(timer);
  }, [open, search, attempt, searchAction]);

  /** Shows the loading rows at once; the effect then runs the (debounced) search. */
  function startSearch(next: string) {
    setState({ status: 'loading' });
    setSearch(next);
  }

  function pick(next: PickedEmployee | null) {
    onChange(next);
    setOpen(false);
  }

  const searching = search.trim() !== '';
  const options = state.status === 'done' ? state.options : [];
  // Nobody to pick at all, as opposed to nobody matching the search.
  const noEmployees = state.status === 'done' && !searching && options.length === 0;

  return (
    <>
      <input type="hidden" name={name} value={value?.id ?? ''} />
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) startSearch('');
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            {...fieldProps}
            aria-haspopup="dialog"
            className={cn(
              'flex h-11 w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg border border-separator bg-surface px-3 text-left',
              'text-body text-text-primary transition-colors duration-fast md:text-subheadline',
              'hover:border-text-tertiary focus-visible:border-accent aria-invalid:border-destructive-text',
            )}
          >
            <UserRound aria-hidden="true" className="size-4.5 shrink-0 text-text-secondary" />
            <span className={cn('min-w-0 flex-1 truncate', !value && 'text-text-secondary')}>
              {value ? value.name : noneLabel}
            </span>
            {value && valueInactive ? <InactiveEmployeeBadge /> : null}
            <ChevronDown aria-hidden="true" className="size-4.5 shrink-0 text-text-secondary" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          aria-label={chooseLabel}
          className="w-[min(24rem,calc(100vw-2rem))] p-0"
        >
          <Command shouldFilter={false} label={listLabel}>
            <CommandInput
              value={search}
              onValueChange={startSearch}
              placeholder="Search by name or employee number"
              aria-controls={listId}
            />
            <CommandList id={listId} aria-busy={state.status === 'loading' || undefined}>
              {state.status === 'error' ? (
                <ErrorState
                  variant="inline"
                  headingLevel={3}
                  title="Couldn’t load employees"
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
              ) : noEmployees ? (
                <>
                  <EmptyState
                    variant="inline"
                    headingLevel={3}
                    icon={<Users strokeWidth={1.75} />}
                    title="No employees to choose yet"
                    description={emptyDescription}
                  />
                  {value ? (
                    <NoneItem label={noneLabel} selected={false} onSelect={() => pick(null)} />
                  ) : null}
                </>
              ) : (
                <>
                  {state.status === 'loading' ? (
                    <div role="status" className="flex flex-col gap-1 p-1">
                      <span className="sr-only">Loading employees…</span>
                      {Array.from({ length: 4 }, (_, index) => (
                        <div key={index} className="flex min-h-11 items-center gap-3 px-3">
                          <Skeleton className="h-4 w-1/2" />
                          <Skeleton className="ml-auto h-3 w-16" />
                        </div>
                      ))}
                    </div>
                  ) : (
                    <>
                      <CommandEmpty>No active employee matches “{search.trim()}”.</CommandEmpty>
                      {!searching ? (
                        <NoneItem
                          label={noneLabel}
                          selected={value === null}
                          onSelect={() => pick(null)}
                        />
                      ) : null}
                      {options.length > 0 ? (
                        <CommandGroup heading="Employees">
                          {options.map((option) => (
                            <CommandItem
                              key={option.id}
                              value={option.id}
                              onSelect={() => pick({ id: option.id, name: option.name })}
                            >
                              <span className="flex min-w-0 flex-1 flex-col py-1">
                                <span className="truncate">{option.name}</span>
                                <span className="truncate text-footnote text-text-secondary">
                                  <span className="numeric">{option.employeeNumber}</span>
                                  {option.departmentName ? ` · ${option.departmentName}` : null}
                                </span>
                              </span>
                              {value?.id === option.id ? (
                                <Check aria-hidden="true" className="size-4.5 shrink-0" />
                              ) : null}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      ) : null}
                    </>
                  )}
                </>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </>
  );
}

function NoneItem({
  label,
  selected,
  onSelect,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <CommandItem value="__none__" onSelect={onSelect}>
      <UserRoundX aria-hidden="true" className="size-4.5 shrink-0 text-text-secondary" />
      <span className="flex-1">{label}</span>
      {selected ? <Check aria-hidden="true" className="size-4.5 shrink-0" /> : null}
    </CommandItem>
  );
}
