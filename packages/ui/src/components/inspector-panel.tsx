'use client';

import {
  useEffect,
  useId,
  useRef,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from 'react';
import { X } from 'lucide-react';
import { DESKTOP_QUERY, useMediaQuery } from '../hooks/use-media-query';
import { cn } from '../lib/utils';
import { Button } from './button';
import { focusedElement, useReturnFocus } from '../hooks/use-return-focus';
import { Sheet, SheetBody, SheetContent, SheetHeader } from './sheet';

/**
 * Lays out a page's content with an inspector panel on its right (desktop). Put the list or table
 * first and the InspectorPanel second.
 */
export function InspectorLayout({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="inspector-layout"
      className={cn('flex min-w-0 items-start gap-5', className)}
      {...props}
    />
  );
}

/**
 * The inspector panel (DESIGN_SYSTEM.md › Pro-app layout): the selected item's details, on the right
 * of the page instead of a new page. From the `lg` breakpoint it is a glass panel beside the content
 * that leaves the page usable; below it, it becomes a full-height sheet.
 *
 * Opening moves focus into the panel; Escape or the close button closes it and returns focus to
 * what had it (or to `returnFocus` when nothing had, as on Safari after a mouse click).
 */
export function InspectorPanel({
  open,
  onOpenChange,
  title,
  eyebrow,
  description,
  actions,
  returnFocus,
  closeLabel = 'Close details',
  className,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** A short label above the title, e.g. "Selected day". */
  eyebrow?: ReactNode;
  description?: ReactNode;
  /** Icon buttons beside the title, e.g. Edit. */
  actions?: ReactNode;
  /** Where focus returns on close when nothing had focus at open. */
  returnFocus?: RefObject<HTMLElement | null>;
  closeLabel?: string;
  className?: string;
  children: ReactNode;
}) {
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const titleId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const returnTo = useReturnFocus();

  // Desktop: remember where focus was when the panel opened, and move focus into the panel.
  // (Phones remember it in the sheet's onOpenAutoFocus, before Radix moves focus into it.)
  useEffect(() => {
    if (!open || !isDesktop) return;
    returnTo.remember(returnFocus?.current);
    panelRef.current?.focus();
  }, [open, isDesktop, returnFocus, returnTo]);

  // Desktop: on close, return focus if it was lost with the panel (not if the user moved it).
  useEffect(() => {
    if (open || !isDesktop) return;
    if (focusedElement()) returnTo.clear();
    else returnTo.restore();
  }, [open, isDesktop, returnTo]);

  if (isDesktop === null) return null;

  if (!isDesktop) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="right"
          {...(description ? {} : { 'aria-describedby': undefined })}
          onOpenAutoFocus={() => returnTo.remember(returnFocus?.current)}
          onCloseAutoFocus={returnTo.onCloseAutoFocus}
        >
          <SheetHeader
            title={
              <>
                {eyebrow ? (
                  <span className="block text-caption font-semibold text-text-secondary">
                    {eyebrow}
                  </span>
                ) : null}
                {title}
              </>
            }
            description={description}
            closeLabel={closeLabel}
          />
          <SheetBody className={className}>
            {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
            {children}
          </SheetBody>
        </SheetContent>
      </Sheet>
    );
  }

  if (!open) return null;

  return (
    <aside
      ref={panelRef}
      tabIndex={-1}
      aria-labelledby={titleId}
      data-slot="inspector-panel"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault();
          onOpenChange(false);
        }
      }}
      className={cn(
        'sticky top-20 flex max-h-[calc(100dvh-6rem)] w-90 shrink-0 flex-col overflow-hidden rounded-panel glass shadow-float outline-none',
        'animate-in duration-base fade-in-0 slide-in-from-right-4',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
      )}
    >
      <header className="flex shrink-0 items-start gap-2 pt-4 pr-3 pb-3 pl-5">
        <div className="flex min-w-0 flex-1 flex-col pt-1">
          {eyebrow ? (
            <span className="text-caption font-semibold text-text-secondary">{eyebrow}</span>
          ) : null}
          <h2 id={titleId} className="text-title-2 break-words">
            {title}
          </h2>
          {description ? <p className="text-footnote text-text-secondary">{description}</p> : null}
        </div>
        {actions}
        <Button
          variant="plain"
          size="icon"
          aria-label={closeLabel}
          aria-keyshortcuts="Escape"
          onClick={() => onOpenChange(false)}
          className="rounded-full"
        >
          <X aria-hidden="true" />
        </Button>
      </header>
      <div
        className={cn(
          'flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-5 pb-5',
          className,
        )}
      >
        {children}
      </div>
    </aside>
  );
}
