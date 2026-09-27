'use client';

import { useId, type ComponentType, type MouseEventHandler, type ReactNode } from 'react';
import { cn } from '../lib/utils';
import { IconTile } from './icon-tile';

export type ShellNavItem = {
  href: string;
  /** Short name shown in the sidebar. */
  label: string;
  /** Full name, used as the page title in the toolbar and the command bar. */
  title?: string;
  /** Extra words the command bar matches, such as the module's domain. */
  keywords?: string[];
  icon: ReactNode;
  current?: boolean;
};

export type ShellNavSection = {
  label: string;
  items: ShellNavItem[];
};

export type ShellLinkProps = {
  href: string;
  className?: string;
  children?: ReactNode;
  'aria-current'?: 'page';
  onClick?: MouseEventHandler<HTMLAnchorElement>;
};

/** The element that renders navigation links, such as Next.js `Link`. */
export type ShellLinkComponent = ComponentType<ShellLinkProps>;

function PlainLink(props: ShellLinkProps) {
  return <a {...props} />;
}

/**
 * The macOS-style source list: brand, then labelled sections of modules with the current one
 * highlighted (DESIGN_SYSTEM.md › Layout & components). The glass panel around it comes from the
 * app shell, so the same list serves the desktop sidebar and the phone drawer.
 */
export function Sidebar({
  brand,
  headerAction,
  sections,
  linkComponent: Link = PlainLink,
  onNavigate,
  className,
}: {
  brand: ReactNode;
  headerAction?: ReactNode;
  sections: ShellNavSection[];
  linkComponent?: ShellLinkComponent;
  onNavigate?: () => void;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      <div className="flex h-16 shrink-0 items-center gap-2.5 pr-1.5 pl-4">
        {brand}
        {headerAction}
      </div>
      <nav
        aria-label="Main"
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-2.5 pt-1 pb-4"
      >
        {sections.map((section, index) => {
          const headingId = `${id}-section-${index}`;
          return (
            <div key={section.label} className="flex flex-col gap-0.5">
              <h2
                id={headingId}
                className="px-2 pb-1.5 text-caption font-semibold text-text-secondary"
              >
                {section.label}
              </h2>
              <ul aria-labelledby={headingId} className="flex flex-col gap-0.5">
                {section.items.map((item) => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={item.current ? 'page' : undefined}
                      onClick={onNavigate}
                      className={cn(
                        'flex h-11 items-center gap-2.5 rounded-lg px-2 text-subheadline transition-colors duration-fast',
                        item.current
                          ? 'bg-accent-subtle font-semibold text-accent'
                          : 'text-text-primary hover:bg-accent-subtle/60',
                      )}
                    >
                      <IconTile
                        className={cn(
                          'size-7 rounded-md [&_svg]:size-4',
                          item.current && 'bg-accent text-accent-text',
                        )}
                      >
                        {item.icon}
                      </IconTile>
                      <span className="min-w-0 truncate">{item.label}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </nav>
    </div>
  );
}
