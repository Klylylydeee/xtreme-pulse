'use client';

import type { ComponentProps, ReactNode } from 'react';
import { X } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { cn } from '../lib/utils';
import { Button } from './button';

/*
 * Sheet: a slide-over glass panel for create and edit flows (DESIGN_SYSTEM.md › Layout & components,
 * Depth and glass), on the shadcn/ui sheet pattern over Radix Dialog. Radix traps focus, closes on
 * Escape and returns focus to the trigger.
 */

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;
/** The sheet's accessible name, for sheets without a SheetHeader (it may be `sr-only`). */
export const SheetTitle = DialogPrimitive.Title;
export const SheetDescription = DialogPrimitive.Description;

const SIDES = {
  /**
   * From the right: an inset floating panel on wider screens, the full screen on phones
   * (the phone form of sheets and inspectors).
   */
  right: cn(
    'inset-0 w-full sm:inset-y-4 sm:right-4 sm:left-auto sm:w-[min(32.5rem,calc(100vw-2rem))]',
    'sm:rounded-panel sm:shadow-float',
    'data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right',
  ),
  /** From the left: the phone navigation drawer. */
  left: cn(
    'inset-y-2 left-2 w-72 max-w-[calc(100vw-4rem)] rounded-panel shadow-float',
    'data-[state=open]:slide-in-from-left data-[state=closed]:slide-out-to-left',
  ),
} as const;

export type SheetSide = keyof typeof SIDES;

export function SheetOverlay({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="sheet-overlay"
      className={cn(
        'fixed inset-0 z-50 bg-scrim duration-base',
        'data-[state=open]:animate-in data-[state=open]:fade-in-0',
        'data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
        className,
      )}
      {...props}
    />
  );
}

/**
 * The sheet panel, in a portal over a scrim. Holds a SheetHeader, a SheetBody and an optional
 * SheetFooter. The header's close button is added for you (`showClose`).
 */
export function SheetContent({
  side = 'right',
  className,
  children,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & { side?: SheetSide }) {
  return (
    <DialogPrimitive.Portal>
      <SheetOverlay />
      <DialogPrimitive.Content
        data-slot="sheet-content"
        data-side={side}
        className={cn(
          'fixed z-50 flex flex-col overflow-hidden glass outline-none duration-slow ease-out',
          'data-[state=open]:animate-in data-[state=closed]:animate-out',
          SIDES[side],
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

/** The close button: 44×44px, labeled, closes the sheet (Escape does too). */
export function SheetCloseButton({
  label = 'Close',
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <DialogPrimitive.Close asChild>
      <Button
        variant="plain"
        size="icon"
        aria-label={label}
        className={cn('rounded-full bg-bg-grouped text-text-secondary', className)}
      >
        <X aria-hidden="true" />
      </Button>
    </DialogPrimitive.Close>
  );
}

/**
 * The sheet's header: title, optional description and leading element (e.g. an avatar), and the
 * close button. Stays put while the body scrolls.
 */
export function SheetHeader({
  title,
  description,
  leading,
  showClose = true,
  closeLabel,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  leading?: ReactNode;
  showClose?: boolean;
  closeLabel?: string;
  className?: string;
}) {
  return (
    <header
      data-slot="sheet-header"
      className={cn(
        'flex shrink-0 items-center gap-3.5 border-b border-separator/70 py-4 pr-3.5 pl-4 sm:pl-6',
        className,
      )}
    >
      {leading}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <DialogPrimitive.Title className="text-title-2 break-words">{title}</DialogPrimitive.Title>
        {description ? (
          <DialogPrimitive.Description className="text-footnote text-text-secondary">
            {description}
          </DialogPrimitive.Description>
        ) : null}
      </div>
      {showClose ? <SheetCloseButton label={closeLabel} /> : null}
    </header>
  );
}

/** The scrolling body of a sheet. */
export function SheetBody({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="sheet-body"
      className={cn(
        'flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto overscroll-contain px-4 py-5 sm:px-5',
        className,
      )}
      {...props}
    />
  );
}

/** The sheet's footer, for Cancel and the primary action. Stays put while the body scrolls. */
export function SheetFooter({ className, ...props }: ComponentProps<'footer'>) {
  return (
    <footer
      data-slot="sheet-footer"
      className={cn(
        'flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-separator/70 px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6',
        className,
      )}
      {...props}
    />
  );
}
