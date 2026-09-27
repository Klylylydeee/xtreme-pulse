'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from '../lib/utils';
import { useShell } from './shell-context';

/**
 * The page header (DESIGN_SYSTEM.md › Layout & components): a large title that shrinks into the
 * top toolbar on scroll, with the primary action at the top right.
 */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string;
  description?: ReactNode;
  /** The screen's primary action, shown at the top right. */
  actions?: ReactNode;
  className?: string;
}) {
  const shell = useShell();
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const heading = titleRef.current;
    if (!shell || !heading) return;
    const { setTitleInToolbar, toolbarRef } = shell;
    // The title counts as scrolled away once it is fully under the sticky toolbar.
    const toolbarHeight = toolbarRef.current?.offsetHeight ?? 0;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry) setTitleInToolbar(!entry.isIntersecting);
      },
      { rootMargin: `-${toolbarHeight}px 0px 0px 0px` },
    );
    observer.observe(heading);
    return () => {
      observer.disconnect();
      setTitleInToolbar(false);
    };
  }, [shell]);

  return (
    <div
      data-slot="page-header"
      className={cn('flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between', className)}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <h1 ref={titleRef} className="text-large-title break-words md:text-display">
          {title}
        </h1>
        {description ? <p className="text-subheadline text-text-secondary">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
