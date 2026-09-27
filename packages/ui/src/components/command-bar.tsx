'use client';

import { Search } from 'lucide-react';
import { cn } from '../lib/utils';
import { Button } from './button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from './command';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './dialog';
import { IconTile } from './icon-tile';
import { ShortcutHint, ariaKeyShortcuts } from './shortcut-hint';
import type { ShellNavItem } from './sidebar';

const PLACEHOLDER = 'Search or jump to…';

/** The command bar shortcut: ⌘K on Mac, Ctrl+K elsewhere. */
export const COMMAND_BAR_SHORTCUT = ['mod', 'k'] as const;

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

/**
 * The command bar (DESIGN_SYSTEM.md › Pro-app layout). For now it jumps to the sections of the app;
 * searching people, records and actions is added as each module is built.
 */
export function CommandBar({
  open,
  onOpenChange,
  items,
  onSelect,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where focus goes on close; see Radix Dialog `onCloseAutoFocus`. */
  onCloseAutoFocus?: (event: Event) => void;
  items: ShellNavItem[];
  onSelect: (href: string) => void;
}) {
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
          Type to filter, use the arrow keys to choose, and press Enter to open.
        </DialogDescription>
        <Command loop>
          <CommandInput placeholder={PLACEHOLDER} aria-label={PLACEHOLDER} />
          <CommandList>
            <CommandEmpty>No matches. Try the name of a module.</CommandEmpty>
            <CommandGroup heading="Go to">
              {items.map((item) => (
                <CommandItem
                  key={item.href}
                  value={`${item.title ?? item.label} ${item.href}`}
                  keywords={[item.label, ...(item.keywords ?? [])]}
                  onSelect={() => {
                    onOpenChange(false);
                    onSelect(item.href);
                  }}
                >
                  <IconTile className="size-7 rounded-md [&_svg]:size-4">{item.icon}</IconTile>
                  <span className="min-w-0 flex-1 truncate">{item.title ?? item.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
