'use client';

import type { ComponentProps } from 'react';
import { Command as CommandPrimitive } from 'cmdk';
import { Search } from 'lucide-react';
import { cn } from '../lib/utils';

/* shadcn/ui command menu on cmdk, styled with the design tokens. Used by the command bar. */

export function Command({ className, ...props }: ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn('flex h-full w-full flex-col overflow-hidden text-text-primary', className)}
      {...props}
    />
  );
}

export function CommandInput({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div
      data-slot="command-input-wrapper"
      // The field's focus indicator: the hairline under it turns into a 2px accent line.
      className="flex items-center gap-3 border-b border-separator px-4 transition-colors duration-fast focus-within:border-accent focus-within:shadow-[inset_0_-1px_0_var(--accent)]"
    >
      <Search aria-hidden="true" className="size-5 shrink-0 text-text-secondary" />
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          'h-14 w-full min-w-0 bg-transparent text-body text-text-primary outline-none',
          'placeholder:text-text-secondary',
          className,
        )}
        {...props}
      />
    </div>
  );
}

export function CommandList({ className, ...props }: ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn('max-h-[min(24rem,60dvh)] overflow-x-hidden overflow-y-auto p-2', className)}
      {...props}
    />
  );
}

export function CommandEmpty({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className={cn('px-3 py-8 text-center text-subheadline text-text-secondary', className)}
      {...props}
    />
  );
}

export function CommandGroup({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        '[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1',
        '[&_[cmdk-group-heading]]:text-footnote [&_[cmdk-group-heading]]:font-semibold',
        '[&_[cmdk-group-heading]]:text-text-secondary',
        className,
      )}
      {...props}
    />
  );
}

export function CommandItem({ className, ...props }: ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        'flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-3 text-subheadline outline-none select-none',
        'data-[selected=true]:bg-accent-subtle data-[selected=true]:text-accent',
        'data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export function CommandSeparator({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn('mx-3 my-1 h-px bg-separator', className)}
      {...props}
    />
  );
}
