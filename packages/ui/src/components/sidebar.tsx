'use client';

import {
  useEffect,
  useId,
  useMemo,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type MouseEvent,
  type MouseEventHandler,
  type ReactNode,
} from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '../lib/utils';
import { IconTile } from './icon-tile';
import { formatUnreadBadge } from './top-toolbar';

/** A collapsible sub-group of a sidebar section (DESIGN_SYSTEM.md › Layout & components). */
export type ShellNavItemGroup = {
  /** Stable key, used to remember whether the group is open. */
  id: string;
  label: string;
};

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
  /**
   * A count shown after the label in the accent colour, "99+" above 99 (DESIGN_SYSTEM.md ›
   * Layout & components). Hidden when 0 or left out.
   */
  badge?: number;
  /**
   * What the count means, added to the link's accessible name after it: with "need access" the
   * link reads "User access, 3 need access". Without it, "User access, 3".
   */
  badgeLabel?: string;
  /**
   * The collapsible sub-group the item sits in. A group's items must be next to each other in the
   * section; items without one are always shown. A section with fewer than two groups is listed
   * plainly, with no group headers.
   */
  group?: ShellNavItemGroup;
};

/** A nav item's badge count: a whole number, 0 when missing or invalid. */
function badgeCount(badge: number | undefined): number {
  return badge !== undefined && Number.isFinite(badge) ? Math.max(0, Math.trunc(badge)) : 0;
}

/** The badge's words for screen readers, read after the label: ", 3 need access". */
export function navBadgeLabel(count: number, label?: string): string {
  return label ? `, ${count} ${label}` : `, ${count}`;
}

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

/*
 * Which sub-groups are open, remembered in this browser (DESIGN_SYSTEM.md › Layout &
 * components): a map of group id to open, in local storage. Storage can be missing or refuse
 * (a private window, blocked site data): then nothing is remembered and every group starts
 * closed except the current page's. One store serves the desktop sidebar and the phone drawer,
 * and a change made in another tab is picked up too.
 */
const GROUP_STATE_KEY = 'pulse.sidebar.groups';
const groupStateListeners = new Set<() => void>();

function readGroupStateRaw(): string | null {
  try {
    return window.localStorage.getItem(GROUP_STATE_KEY);
  } catch {
    return null;
  }
}

function parseGroupState(raw: string | null): Record<string, boolean> {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, boolean] => typeof entry[1] === 'boolean',
      ),
    );
  } catch {
    return {};
  }
}

function writeGroupState(id: string, open: boolean) {
  const next = { ...parseGroupState(readGroupStateRaw()), [id]: open };
  try {
    window.localStorage.setItem(GROUP_STATE_KEY, JSON.stringify(next));
  } catch {
    // Not remembered; the group still opens or closes for now.
  }
  for (const listener of groupStateListeners) listener();
}

function subscribeGroupState(listener: () => void) {
  groupStateListeners.add(listener);
  window.addEventListener('storage', listener);
  return () => {
    groupStateListeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

/**
 * Which groups are open, and a toggle. The group holding the current page opens on arrival and is
 * remembered open; the user can still close it while there.
 */
function useGroupState(currentGroup: string | null) {
  // Read after hydration: the server, and the first client render, know only the current group.
  const raw = useSyncExternalStore(subscribeGroupState, readGroupStateRaw, () => null);
  const stored = useMemo(() => parseGroupState(raw), [raw]);
  // The current page's group, if the user closed it while on that page. Cleared when the page's
  // group changes (adjusting state during render), so arriving in a group opens it again.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [lastCurrent, setLastCurrent] = useState(currentGroup);
  if (lastCurrent !== currentGroup) {
    setLastCurrent(currentGroup);
    setDismissed(null);
  }

  useEffect(() => {
    if (currentGroup && parseGroupState(readGroupStateRaw())[currentGroup] !== true) {
      writeGroupState(currentGroup, true);
    }
  }, [currentGroup]);

  const isOpen = (id: string) => (id === currentGroup ? dismissed !== id : stored[id] === true);

  const toggle = (id: string) => {
    const open = !isOpen(id);
    if (id === currentGroup) setDismissed(open ? null : id);
    writeGroupState(id, open);
  };

  return { isOpen, toggle };
}

/** A section's items as runs: one ungrouped item, or the items of one sub-group. */
type ItemRun = { group: ShellNavItemGroup | null; items: ShellNavItem[] };

function itemRuns(items: ShellNavItem[]): ItemRun[] {
  const groupIds = new Set(items.flatMap((item) => (item.group ? [item.group.id] : [])));
  // Fewer than two groups: nothing worth folding away, so the items are listed plainly.
  if (groupIds.size < 2) return items.map((item) => ({ group: null, items: [item] }));
  const runs: ItemRun[] = [];
  for (const item of items) {
    const last = runs.at(-1);
    if (item.group && last?.group?.id === item.group.id) last.items.push(item);
    else runs.push({ group: item.group ?? null, items: [item] });
  }
  return runs;
}

function CountBadge({ count, label }: { count: number; label?: string }) {
  return (
    <>
      <span
        aria-hidden="true"
        data-slot="sidebar-badge"
        className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-accent px-1.5 text-caption font-semibold text-accent-text numeric"
      >
        {formatUnreadBadge(count)}
      </span>
      <span className="sr-only">{navBadgeLabel(count, label)}</span>
    </>
  );
}

function SidebarLink({
  item,
  Link,
  linkHint,
  onNavigate,
}: {
  item: ShellNavItem;
  Link: ShellLinkComponent;
  linkHint?: ReactNode;
  onNavigate?: (item: ShellNavItem, event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const count = badgeCount(item.badge);
  return (
    <Link
      href={item.href}
      aria-current={item.current ? 'page' : undefined}
      onClick={onNavigate ? (event) => onNavigate(item, event) : undefined}
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
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {count > 0 ? <CountBadge count={count} label={item.badgeLabel} /> : null}
      {linkHint}
    </Link>
  );
}

/**
 * A collapsible sub-group: a disclosure button over its items. While closed, the button carries
 * the sum of its items' badges, and its label is in the accent colour when it holds the current
 * page.
 */
function SidebarGroup({
  baseId,
  group,
  items,
  open,
  onToggle,
  children,
}: {
  baseId: string;
  group: ShellNavItemGroup;
  items: ShellNavItem[];
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const buttonId = `${baseId}-group-${group.id}`;
  const listId = `${buttonId}-items`;
  const badged = items.filter((item) => badgeCount(item.badge) > 0);
  const count = badged.reduce((sum, item) => sum + badgeCount(item.badge), 0);
  // The items' own words when they all say the same thing ("need access"), otherwise the number.
  const labels = new Set(badged.map((item) => item.badgeLabel));
  const countLabel = labels.size === 1 ? [...labels][0] : undefined;
  const holdsCurrent = items.some((item) => item.current);
  return (
    <>
      <h3>
        <button
          type="button"
          id={buttonId}
          aria-expanded={open}
          aria-controls={listId}
          onClick={onToggle}
          className={cn(
            'flex h-11 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 text-left text-footnote font-semibold transition-colors duration-fast hover:bg-accent-subtle/60',
            !open && holdsCurrent ? 'text-accent' : 'text-text-secondary',
          )}
        >
          <span className="min-w-0 flex-1 truncate">{group.label}</span>
          {!open && count > 0 ? <CountBadge count={count} label={countLabel} /> : null}
          <ChevronRight
            aria-hidden="true"
            className={cn(
              'size-4 shrink-0 transition-transform duration-fast ease-out',
              open && 'rotate-90',
            )}
          />
        </button>
      </h3>
      <ul
        id={listId}
        aria-labelledby={buttonId}
        hidden={!open}
        className={cn('flex-col gap-0.5', open ? 'flex' : 'hidden')}
      >
        {children}
      </ul>
    </>
  );
}

/**
 * The macOS-style source list: brand, then labelled sections of modules with the current one
 * highlighted (DESIGN_SYSTEM.md › Layout & components). A section's items can sit in collapsible
 * sub-groups (`ShellNavItem.group`). The glass panel around it comes from the app shell, so the
 * same list serves the desktop sidebar and the phone drawer.
 */
export function Sidebar({
  brand,
  headerAction,
  sections,
  linkComponent: Link = PlainLink,
  linkHint,
  onNavigate,
  className,
}: {
  brand: ReactNode;
  headerAction?: ReactNode;
  sections: ShellNavSection[];
  linkComponent?: ShellLinkComponent;
  /**
   * Rendered at the end of every link, inside it: a fixed-size hint such as a pending indicator
   * that reads the link's own state (Next.js `useLinkStatus`). It must not change the row's size.
   */
  linkHint?: ReactNode;
  /** Called when a link is clicked, with its item. */
  onNavigate?: (item: ShellNavItem, event: MouseEvent<HTMLAnchorElement>) => void;
  className?: string;
}) {
  const id = useId();
  const currentGroup =
    sections.flatMap((section) => section.items).find((item) => item.current)?.group?.id ?? null;
  const groups = useGroupState(currentGroup);
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
                {itemRuns(section.items).map((run) => {
                  const links = run.items.map((item) => (
                    <li key={item.href}>
                      <SidebarLink
                        item={item}
                        Link={Link}
                        linkHint={linkHint}
                        onNavigate={onNavigate}
                      />
                    </li>
                  ));
                  const group = run.group;
                  if (!group) return links;
                  return (
                    <li key={`group-${group.id}`}>
                      <SidebarGroup
                        baseId={headingId}
                        group={group}
                        items={run.items}
                        open={groups.isOpen(group.id)}
                        onToggle={() => groups.toggle(group.id)}
                      >
                        {links}
                      </SidebarGroup>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>
    </div>
  );
}
