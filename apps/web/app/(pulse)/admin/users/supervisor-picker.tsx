'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { CircleAlert, Plus, UserRound, Users, X } from 'lucide-react';
import { MAX_SUPERVISORS, NO_SUPERVISOR_HINT } from '@pulse/core';
import type { DepartmentHeadOption } from '@pulse/core/server';
import { Button } from '@pulse/ui/components/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@pulse/ui/components/command';
import { EmptyState } from '@pulse/ui/components/empty-state';
import { ErrorState } from '@pulse/ui/components/error-state';
import { Popover, PopoverContent, PopoverTrigger } from '@pulse/ui/components/popover';
import { Skeleton } from '@pulse/ui/components/skeleton';
import { Badge } from '@/components/org-structure';
import { searchSupervisorsAction } from '@/lib/actions/users';

// Spec: docs/modules/core.md#reporting-lines — `reportingTo` is a list of supervisors: none (with
// the hint for a non-Board employee), or up to MAX_SUPERVISORS, each an active employee and never
// the person themselves. A supervisor who separated after the line was set stays, marked
// "Inactive". The list is searched on the server (name or employee number, at most 20); the
// service checks the limits and cycles again on save.

/** A supervisor on the form. */
export interface PickedSupervisor {
  /** The employee ID. */
  id: string;
  name: string;
  employeeNumber: string;
  active: boolean;
}

const SEARCH_DELAY_MS = 250;
const LOAD_FAILED = 'The employee list couldn’t load. Try again.';

type SearchState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'done'; options: DepartmentHeadOption[] };

/**
 * The supervisors, posted as one `reportingTo` field each, in order. Rows inside a FormSection:
 * one per supervisor with Remove, then "Add supervisor", which opens a searchable list.
 */
export function SupervisorPicker({
  value,
  onChange,
  excludeEmployeeId,
  showNoSupervisorHint,
  error,
}: {
  value: PickedSupervisor[];
  onChange: (value: PickedSupervisor[]) => void;
  /** The employee being edited, who can't report to themselves. */
  excludeEmployeeId: string | null;
  /** True for a non-Board employee: an empty list sends leave and offset to HR. */
  showNoSupervisorHint: boolean;
  error?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [state, setState] = useState<SearchState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const listId = useId();
  const hintId = useId();
  const errorId = useId();
  const latest = useRef(0);
  const addRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const request = ++latest.current;
    const timer = window.setTimeout(
      async () => {
        try {
          const result = await searchSupervisorsAction(null, { search, excludeEmployeeId });
          if (request !== latest.current) return;
          setState(
            result.ok
              ? { status: 'done', options: result.data }
              : { status: 'error', message: result.formError ?? LOAD_FAILED },
          );
        } catch {
          if (request === latest.current) setState({ status: 'error', message: LOAD_FAILED });
        }
      },
      search ? SEARCH_DELAY_MS : 0,
    );
    return () => window.clearTimeout(timer);
  }, [open, search, attempt, excludeEmployeeId]);

  function startSearch(next: string) {
    setState({ status: 'loading' });
    setSearch(next);
  }

  function add(option: DepartmentHeadOption) {
    if (value.length >= MAX_SUPERVISORS || value.some((picked) => picked.id === option.id)) return;
    onChange([
      ...value,
      { id: option.id, name: option.name, employeeNumber: option.employeeNumber, active: true },
    ]);
    setOpen(false);
  }

  function remove(id: string) {
    onChange(value.filter((picked) => picked.id !== id));
    // The removed row's button is gone; keep focus in the field.
    requestAnimationFrame(() => addRef.current?.focus());
  }

  const full = value.length >= MAX_SUPERVISORS;
  const pickedIds = new Set(value.map((picked) => picked.id));
  const options = state.status === 'done' ? state.options : [];
  const available = options.filter((option) => !pickedIds.has(option.id));
  const searching = search.trim() !== '';
  const noEmployees = state.status === 'done' && !searching && options.length === 0;
  const hint = full
    ? `At most ${MAX_SUPERVISORS} supervisors.`
    : value.length === 0 && showNoSupervisorHint
      ? NO_SUPERVISOR_HINT
      : 'Any one supervisor can approve their requests.';

  return (
    <>
      {value.map((picked) => (
        <input key={picked.id} type="hidden" name="reportingTo" value={picked.id} />
      ))}
      {value.length === 0 ? (
        <div className="flex min-h-11 items-center gap-3 px-4 py-3 text-body text-text-secondary md:text-subheadline">
          <UserRound aria-hidden="true" className="size-4.5 shrink-0" />
          No supervisor
        </div>
      ) : (
        <ul aria-label="Supervisors" className="flex flex-col divide-y divide-separator">
          {value.map((picked) => (
            <li key={picked.id} className="flex min-h-14 items-center gap-3 py-1.5 pr-1.5 pl-4">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-body md:text-subheadline">{picked.name}</span>
                  {picked.active ? null : <Badge>Inactive</Badge>}
                </span>
                <span className="numeric text-footnote text-text-secondary">
                  {picked.employeeNumber}
                </span>
              </span>
              <Button
                variant="plain"
                size="icon"
                aria-label={`Remove ${picked.name}`}
                onClick={() => remove(picked.id)}
              >
                <X aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-col gap-1.5 px-4 py-3">
        <Popover
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (next) startSearch('');
          }}
        >
          <PopoverTrigger asChild>
            <Button
              ref={addRef}
              variant="tinted"
              disabled={full}
              aria-haspopup="dialog"
              aria-describedby={[hintId, error ? errorId : null].filter(Boolean).join(' ')}
              aria-invalid={error ? true : undefined}
              className="self-start"
            >
              <Plus aria-hidden="true" className="size-4.5" />
              Add supervisor
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            aria-label="Choose a supervisor"
            className="w-[min(24rem,calc(100vw-2rem))] p-0"
          >
            <Command shouldFilter={false} label="Supervisor">
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
                  <EmptyState
                    variant="inline"
                    headingLevel={3}
                    icon={<Users strokeWidth={1.75} />}
                    title="No employees to choose yet"
                    description="A supervisor is picked from employees with an active account. You can save without one and add it later."
                  />
                ) : state.status === 'loading' ? (
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
                    <CommandEmpty>
                      {searching
                        ? `No active employee matches “${search.trim()}”.`
                        : 'Everyone available is already a supervisor here.'}
                    </CommandEmpty>
                    {available.length > 0 ? (
                      <CommandGroup heading="Employees">
                        {available.map((option) => (
                          <CommandItem
                            key={option.id}
                            value={option.id}
                            onSelect={() => add(option)}
                          >
                            <span className="flex min-w-0 flex-1 flex-col py-1">
                              <span className="truncate">{option.name}</span>
                              <span className="truncate text-footnote text-text-secondary">
                                <span className="numeric">{option.employeeNumber}</span>
                                {option.departmentName ? ` · ${option.departmentName}` : null}
                              </span>
                            </span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    ) : null}
                  </>
                )}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        <p id={hintId} className="text-footnote text-text-secondary">
          {hint}
        </p>
        <div aria-live="polite">
          {error ? (
            <p
              id={errorId}
              className="flex items-start gap-1.5 text-footnote font-medium text-destructive-text"
            >
              <CircleAlert aria-hidden="true" className="mt-px size-4 shrink-0" />
              <span>{error}</span>
            </p>
          ) : null}
        </div>
      </div>
    </>
  );
}
