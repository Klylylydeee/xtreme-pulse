'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, UserRound, UserRoundX, Users } from 'lucide-react';
import type { DepartmentHeadOption } from '@pulse/core/server';
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
import { searchDepartmentHeadsAction } from '@/lib/actions/org-structure';

// Spec: docs/modules/core.md#managing-departments-and-positions — the head is optional: any
// employee whose account resolves to active, from any department. The list is searched on the
// server (name or employee number, at most 20), so the picker never holds the whole directory.

/** The picked head, as the form shows it. */
export interface PickedHead {
  id: string;
  name: string;
}

const SEARCH_DELAY_MS = 250;

type SearchState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'done'; options: DepartmentHeadOption[] };

/**
 * A searchable picker for the department head, posted as `headEmployeeId` (empty for none). Opens
 * a popover with a search field; "No head" clears it. Shows a designed empty state while there are
 * no eligible employees (usual before employees are added).
 */
export function DepartmentHeadPicker({
  value,
  onChange,
}: {
  value: PickedHead | null;
  onChange: (value: PickedHead | null) => void;
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
          const result = await searchDepartmentHeadsAction(null, { search });
          if (request !== latest.current) return;
          setState(
            result.ok
              ? { status: 'done', options: result.data }
              : {
                  status: 'error',
                  message: result.formError ?? 'The employee list couldn’t load. Try again.',
                },
          );
        } catch {
          if (request === latest.current) {
            setState({ status: 'error', message: 'The employee list couldn’t load. Try again.' });
          }
        }
      },
      search ? SEARCH_DELAY_MS : 0,
    );
    return () => window.clearTimeout(timer);
  }, [open, search, attempt]);

  /** Shows the loading rows at once; the effect then runs the (debounced) search. */
  function startSearch(next: string) {
    setState({ status: 'loading' });
    setSearch(next);
  }

  function pick(next: PickedHead | null) {
    onChange(next);
    setOpen(false);
  }

  const searching = search.trim() !== '';
  const options = state.status === 'done' ? state.options : [];
  // Nobody to pick at all, as opposed to nobody matching the search.
  const noEmployees = state.status === 'done' && !searching && options.length === 0;

  return (
    <>
      <input type="hidden" name="headEmployeeId" value={value?.id ?? ''} />
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
              {value ? value.name : 'No head'}
            </span>
            <ChevronDown aria-hidden="true" className="size-4.5 shrink-0 text-text-secondary" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          aria-label="Choose the department head"
          className="w-[min(24rem,calc(100vw-2rem))] p-0"
        >
          <Command shouldFilter={false} label="Department head">
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
                    description="A head is picked from employees with an active account. You can save without one and set it later."
                  />
                  {value ? <NoHeadItem selected={false} onSelect={() => pick(null)} /> : null}
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
                        <NoHeadItem selected={value === null} onSelect={() => pick(null)} />
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

function NoHeadItem({ selected, onSelect }: { selected: boolean; onSelect: () => void }) {
  return (
    <CommandItem value="__none__" onSelect={onSelect}>
      <UserRoundX aria-hidden="true" className="size-4.5 shrink-0 text-text-secondary" />
      <span className="flex-1">No head</span>
      {selected ? <Check aria-hidden="true" className="size-4.5 shrink-0" /> : null}
    </CommandItem>
  );
}
