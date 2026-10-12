'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, UserRound, Zap, type LucideIcon } from 'lucide-react';
import { cn } from '../lib/utils';
import { Avatar } from './avatar';
import { Button } from './button';
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from './command';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './dialog';
import { IconTile } from './icon-tile';
import { ShortcutHint, ariaKeyShortcuts } from './shortcut-hint';
import type { ShellNavItem } from './sidebar';
import { Skeleton } from './skeleton';

const PLACEHOLDER = 'Search or jump to…';
const EMPTY_MESSAGE = 'No matches. Try a name, an employee number or a page.';
const ERROR_MESSAGE = 'Search isn’t available right now.';
const LOADING_MESSAGE = 'Searching…';

/** The command bar shortcut: ⌘K on Mac, Ctrl+K elsewhere. */
export const COMMAND_BAR_SHORTCUT = ['mod', 'k'] as const;

/**
 * A search result's icon key (modules/core.md › Command bar). Results come from the server, which
 * can't send components, so each names an icon from the fixed set `COMMAND_ICONS` in `@pulse/core`
 * and the command bar maps it to a Lucide icon here. Keep this union in step with that set.
 */
export type CommandIconKey = 'person' | 'action';

const COMMAND_ICON_COMPONENTS: Record<CommandIconKey, LucideIcon> = {
  person: UserRound,
  action: Zap,
};

/** One search result: a link, shown with its icon, title and optional subtitle. */
export type CommandResultItem = {
  id: string;
  title: string;
  subtitle?: string;
  /** A path inside the app. */
  href: string;
  icon: CommandIconKey;
  /** A person's profile photo: shown in an Avatar instead of the icon tile (build step 2.2). */
  photoUrl?: string;
};

/** One search provider's results, under its own heading (such as "People"). */
export type CommandResultGroup = {
  heading: string;
  items: CommandResultItem[];
};

/**
 * The command bar's search, all optional. Without it the bar only filters the navigation items.
 * Results are shown as given, in the order given: searching, debouncing and dropping stale
 * answers are the caller's job.
 */
export type CommandSearchProps = {
  /** The typed text. Leave undefined to let the bar keep it; either way it clears on close. */
  query?: string;
  onQueryChange?: (query: string) => void;
  /** The search providers' groups, shown after "Go to". Empty groups aren't shown. */
  resultGroups?: CommandResultGroup[];
  /** A search is running: a skeleton row takes the place of the result groups. */
  loading?: boolean;
  /** The search failed: "Search isn't available right now." shows under Go to, which still works. */
  error?: boolean;
};

/** Lower case without accents, so "jose" finds "José". */
function normalize(text: string) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

/** Whether every word typed appears in the item's title, label or keywords. */
export function matchesNavItem(item: ShellNavItem, query: string): boolean {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = normalize([item.title, item.label, ...(item.keywords ?? [])].join(' '));
  return terms.every((term) => haystack.includes(term));
}

/**
 * Opens the command bar: a search field on wider screens, an icon button on phones.
 * The ⌘K / Ctrl+K shortcut itself is handled by the app shell. `onOpen` receives the button that
 * was pressed, so focus can return to it on close.
 */
export function CommandBarTrigger({ onOpen }: { onOpen: (trigger: HTMLElement) => void }) {
  return (
    <>
      <button
        type="button"
        onClick={(event) => onOpen(event.currentTarget)}
        aria-haspopup="dialog"
        aria-keyshortcuts={ariaKeyShortcuts(COMMAND_BAR_SHORTCUT)}
        className={cn(
          'hidden h-11 w-72 cursor-pointer items-center gap-2.5 rounded-xl border border-separator bg-bg-grouped pr-2 pl-3.5 text-left text-subheadline text-text-secondary md:flex lg:w-96',
          'transition-colors duration-fast hover:border-accent/40',
        )}
      >
        <Search aria-hidden="true" className="size-4.5 shrink-0" />
        <span className="flex-1 truncate">{PLACEHOLDER}</span>
        <ShortcutHint keys={COMMAND_BAR_SHORTCUT} className="h-6 bg-surface" />
      </button>
      <Button
        variant="plain"
        size="icon"
        onClick={(event) => onOpen(event.currentTarget)}
        aria-haspopup="dialog"
        aria-keyshortcuts={ariaKeyShortcuts(COMMAND_BAR_SHORTCUT)}
        aria-label="Search or jump to"
        className="md:hidden"
      >
        <Search aria-hidden="true" />
      </Button>
    </>
  );
}

/** A message row inside the list. Screen readers hear it from the bar's live region instead. */
function ListMessage({ children }: { children: string }) {
  return (
    <div aria-hidden="true" className="px-3 py-6 text-center text-subheadline text-text-secondary">
      {children}
    </div>
  );
}

/** The skeleton row shown while a search runs, shaped like a result. */
function ResultSkeleton() {
  return (
    <div
      aria-hidden="true"
      data-slot="command-loading"
      className="flex min-h-11 items-center gap-3 px-3 py-1.5"
    >
      <Skeleton className="size-7 rounded-md" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <Skeleton className="h-3.5 w-2/5" />
        <Skeleton className="h-3 w-3/5" />
      </div>
    </div>
  );
}

/**
 * The command bar (DESIGN_SYSTEM.md › Layout & components, modules/core.md › Command bar).
 * Groups in order: "Go to" (the navigation items, filtered here as the user types, by title, label
 * and keywords), then the search's result groups as given. Arrow keys move, Enter opens, Escape
 * closes. Every entry is a link: choosing one closes the bar and calls `onSelect` with its path.
 */
export function CommandBar({
  open,
  onOpenChange,
  items,
  onSelect,
  onCloseAutoFocus,
  query: controlledQuery,
  onQueryChange,
  resultGroups,
  loading = false,
  error = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where focus goes on close; see Radix Dialog `onCloseAutoFocus`. */
  onCloseAutoFocus?: (event: Event) => void;
  items: ShellNavItem[];
  onSelect: (href: string) => void;
} & CommandSearchProps) {
  const [innerQuery, setInnerQuery] = useState('');
  const query = controlledQuery ?? innerQuery;

  function setQuery(next: string) {
    if (controlledQuery === undefined) setInnerQuery(next);
    onQueryChange?.(next);
  }

  // Every opening starts empty. The kept query clears when the bar closes (adjusting state during
  // render), and a caller that controls the query is told to clear it.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open && innerQuery !== '') setInnerQuery('');
  }
  const onQueryChangeRef = useRef(onQueryChange);
  useEffect(() => {
    onQueryChangeRef.current = onQueryChange;
  });
  const openedRef = useRef(open);
  useEffect(() => {
    if (openedRef.current && !open) onQueryChangeRef.current?.('');
    openedRef.current = open;
  }, [open]);

  const navMatches = useMemo(
    () => items.filter((item) => matchesNavItem(item, query)),
    [items, query],
  );
  const groups = useMemo(
    () => (resultGroups ?? []).filter((group) => group.items.length > 0),
    [resultGroups],
  );
  const showResults = !loading && !error;
  const resultCount = showResults ? groups.reduce((sum, group) => sum + group.items.length, 0) : 0;
  const empty = showResults && navMatches.length === 0 && resultCount === 0;

  let status = '';
  if (error) status = ERROR_MESSAGE;
  else if (loading) status = LOADING_MESSAGE;
  else if (empty) status = EMPTY_MESSAGE;

  function choose(href: string) {
    onOpenChange(false);
    onSelect(href);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onCloseAutoFocus={onCloseAutoFocus}
        className={cn(
          'top-[max(1rem,12dvh)] left-1/2 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-panel glass shadow-float',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
        )}
      >
        <DialogTitle className="sr-only">Command bar</DialogTitle>
        <DialogDescription className="sr-only">
          Type to search, use the arrow keys to choose, and press Enter to open.
        </DialogDescription>
        {/* Navigation is filtered here and results on the server, so cmdk doesn't filter. */}
        <Command loop shouldFilter={false} label="Command bar">
          <CommandInput
            placeholder={PLACEHOLDER}
            aria-label={PLACEHOLDER}
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            {navMatches.length > 0 ? (
              <CommandGroup heading="Go to">
                {navMatches.map((item) => (
                  <CommandItem
                    key={item.href}
                    value={`nav:${item.href}`}
                    onSelect={() => choose(item.href)}
                  >
                    <IconTile className="size-7 rounded-md [&_svg]:size-4">{item.icon}</IconTile>
                    <span className="min-w-0 flex-1 truncate">{item.title ?? item.label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}

            {error ? <ListMessage>{ERROR_MESSAGE}</ListMessage> : null}
            {loading && !error ? <ResultSkeleton /> : null}

            {showResults
              ? groups.map((group) => (
                  <CommandGroup key={group.heading} heading={group.heading}>
                    {group.items.map((result) => {
                      const Icon = COMMAND_ICON_COMPONENTS[result.icon] ?? Zap;
                      return (
                        <CommandItem
                          key={result.id}
                          value={`result:${group.heading}:${result.id}`}
                          onSelect={() => choose(result.href)}
                          className="py-1.5"
                        >
                          {result.photoUrl ? (
                            <Avatar
                              photoUrl={result.photoUrl}
                              fallback={<Icon strokeWidth={1.75} className="size-4" />}
                              size="sm"
                              className="size-7"
                            />
                          ) : (
                            <IconTile className="size-7 rounded-md [&_svg]:size-4">
                              <Icon strokeWidth={1.75} />
                            </IconTile>
                          )}
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate">{result.title}</span>
                            {result.subtitle ? (
                              <span className="truncate text-footnote text-text-secondary">
                                {result.subtitle}
                              </span>
                            ) : null}
                          </span>
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                ))
              : null}

            {empty ? <ListMessage>{EMPTY_MESSAGE}</ListMessage> : null}
          </CommandList>
        </Command>
        <div role="status" aria-live="polite" className="sr-only">
          {status}
        </div>
      </DialogContent>
    </Dialog>
  );
}
