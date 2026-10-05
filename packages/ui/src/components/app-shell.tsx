'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { Menu, PanelLeftClose, PanelLeftOpen, X } from 'lucide-react';
import { DESKTOP_QUERY } from '../hooks/use-media-query';
import { useReturnFocus } from '../hooks/use-return-focus';
import { cn } from '../lib/utils';
import { Button } from './button';
import { CommandBar, CommandBarTrigger } from './command-bar';
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from './sheet';
import { ShellContext, type ShellContextValue } from './shell-context';
import {
  Sidebar,
  type ShellLinkComponent,
  type ShellNavItem,
  type ShellNavSection,
} from './sidebar';
import { TopToolbar, type ShellBreadcrumb } from './top-toolbar';

/**
 * The signed-in app shell: the glass sidebar (a drawer below the `lg` breakpoint), the top
 * toolbar with the command bar, and the page. ⌘K / Ctrl+K opens the command bar anywhere.
 *
 * The caller decides which sections and modules are listed. Hiding a link here is never access
 * control: every page and action checks access on the server (SECURITY.md › Module access).
 */
export function AppShell({
  appName,
  logo,
  sections,
  breadcrumb,
  linkComponent,
  linkHint,
  routeKey,
  onNavigate,
  notifications,
  notificationsUnread,
  notificationsOpen,
  onNotificationsOpenChange,
  help,
  account,
  children,
}: {
  appName: string;
  /** The company logo, or a placeholder until company settings provide one. */
  logo: ReactNode;
  sections: ShellNavSection[];
  breadcrumb: ShellBreadcrumb;
  linkComponent?: ShellLinkComponent;
  /** A fixed-size hint at the end of every sidebar link, such as a pending indicator. */
  linkHint?: ReactNode;
  /**
   * The current route (such as the pathname). When given, the phone drawer stays open after a link
   * is clicked, so its pending hint shows, and closes once the route changes. Without it, the
   * drawer closes on the click.
   */
  routeKey?: string;
  /** Navigates to a path chosen in the command bar. */
  onNavigate: (href: string) => void;
  /** The notifications popover's content (it sets its own padding). */
  notifications: ReactNode;
  /** The unread count for the bell's badge. */
  notificationsUnread?: number;
  /** Controls the notifications popover; leave undefined to let it manage itself. */
  notificationsOpen?: boolean;
  onNotificationsOpenChange?: (open: boolean) => void;
  help: ReactNode;
  /** The signed-in account: who is signed in and a Sign out button. Omit to hide the button. */
  account?: ReactNode;
  children: ReactNode;
}) {
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [titleInToolbar, setTitleInToolbar] = useState(false);
  const toolbarRef = useRef<HTMLElement>(null);
  const hideButtonRef = useRef<HTMLButtonElement>(null);
  const showButtonRef = useRef<HTMLButtonElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const moveFocusAfterToggle = useRef(false);
  // What had focus when the command bar or drawer opened, to return focus there on close.
  // The shell opens both by state (and by ⌘K / Ctrl+K), not by a Radix trigger.
  const commandReturnFocus = useReturnFocus();
  const drawerReturnFocus = useReturnFocus();
  const commandOpenRef = useRef(commandOpen);
  const drawerOpenRef = useRef(drawerOpen);

  useEffect(() => {
    commandOpenRef.current = commandOpen;
    drawerOpenRef.current = drawerOpen;
  }, [commandOpen, drawerOpen]);

  // `trigger` is the button pressed, if any: Safari doesn't focus buttons on click, so what has
  // focus may be the page body, and focus then returns to the trigger instead.
  const openCommand = useCallback(
    (trigger?: HTMLElement) => {
      // Opened from inside the drawer, which closes: return to what opened the drawer instead.
      if (drawerOpenRef.current) commandReturnFocus.set(drawerReturnFocus.get());
      else commandReturnFocus.remember(trigger);
      setDrawerOpen(false);
      setCommandOpen(true);
    },
    [commandReturnFocus, drawerReturnFocus],
  );

  const openDrawer = useCallback(
    (trigger: HTMLElement) => {
      drawerReturnFocus.remember(trigger);
      setDrawerOpen(true);
    },
    [drawerReturnFocus],
  );

  // Close the drawer once the route changes (adjusting state during render, not in an effect).
  const [drawerRoute, setDrawerRoute] = useState(routeKey);
  if (drawerRoute !== routeKey) {
    setDrawerRoute(routeKey);
    setDrawerOpen(false);
  }

  // A drawer link click: with `routeKey`, wait for the route to change so the link's pending hint
  // shows in the drawer; the current page's link, which changes nothing, closes it at once. A click
  // that opens a new tab or window leaves the drawer open.
  const onDrawerLinkClick = useCallback(
    (item: ShellNavItem, event: MouseEvent<HTMLAnchorElement>) => {
      const newTab = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
      if (routeKey === undefined) setDrawerOpen(false);
      else if (item.current && !newTab) setDrawerOpen(false);
    },
    [routeKey],
  );

  const commandItems = useMemo<ShellNavItem[]>(
    () => sections.flatMap((section) => section.items),
    [sections],
  );

  // ⌘K on Mac, Ctrl+K on Windows and Linux.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (commandOpenRef.current) setCommandOpen(false);
        else openCommand();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [openCommand]);

  // The drawer is for narrow screens only; close it if the window grows past the breakpoint.
  useEffect(() => {
    const query = window.matchMedia(DESKTOP_QUERY);
    function onChange(event: MediaQueryListEvent) {
      if (event.matches) setDrawerOpen(false);
    }
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  // Keep keyboard focus on the matching button when the sidebar is hidden or shown.
  useEffect(() => {
    if (!moveFocusAfterToggle.current) return;
    moveFocusAfterToggle.current = false;
    (sidebarHidden ? showButtonRef : hideButtonRef).current?.focus();
  }, [sidebarHidden]);

  const toggleSidebar = useCallback((hidden: boolean) => {
    moveFocusAfterToggle.current = true;
    setSidebarHidden(hidden);
  }, []);

  // Returns focus to what opened the command bar. If that is now hidden (the search field after the
  // window narrows below `md`), focus the visible command bar trigger or the Menu button instead.
  const onCommandCloseAutoFocus = useCallback(
    (event: Event) => {
      const hadTarget = commandReturnFocus.get() !== null;
      if (commandReturnFocus.restore()) {
        event.preventDefault();
        return;
      }
      if (!hadTarget) return;
      const fallbacks = [
        ...(toolbarRef.current?.querySelectorAll<HTMLElement>('button[aria-keyshortcuts]') ?? []),
        menuButtonRef.current,
      ];
      for (const element of fallbacks) {
        if (!element) continue;
        element.focus();
        if (document.activeElement === element) {
          event.preventDefault();
          return;
        }
      }
    },
    [commandReturnFocus],
  );

  const shellContext = useMemo<ShellContextValue>(() => ({ toolbarRef, setTitleInToolbar }), []);

  const brand = (
    <>
      {logo}
      <span className="min-w-0 flex-1 truncate text-headline font-bold">{appName}</span>
    </>
  );

  return (
    <ShellContext.Provider value={shellContext}>
      <a
        href="#main"
        className="sr-only z-50 rounded-lg bg-surface px-4 py-2.5 text-subheadline font-semibold text-accent shadow-float focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>

      <aside
        aria-label="Sidebar"
        data-state={sidebarHidden ? 'hidden' : 'shown'}
        // A hidden sidebar slides off screen and is inert, so it takes no focus and is not announced.
        inert={sidebarHidden}
        className={cn(
          'fixed inset-y-2 left-2 z-40 hidden w-60 flex-col rounded-panel glass-sidebar shadow-float lg:flex',
          'transition-[translate] duration-base ease-out',
          'data-[state=hidden]:-translate-x-[calc(100%+1rem)]',
        )}
      >
        <Sidebar
          brand={brand}
          sections={sections}
          linkComponent={linkComponent}
          linkHint={linkHint}
          headerAction={
            <Button
              ref={hideButtonRef}
              variant="plain"
              size="icon"
              aria-label="Hide sidebar"
              onClick={() => toggleSidebar(true)}
            >
              <PanelLeftClose aria-hidden="true" />
            </Button>
          }
        />
      </aside>

      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent
          side="left"
          onCloseAutoFocus={drawerReturnFocus.onCloseAutoFocus}
          className="glass-sidebar"
        >
          <SheetTitle className="sr-only">Menu</SheetTitle>
          <SheetDescription className="sr-only">The sections of {appName}.</SheetDescription>
          <Sidebar
            brand={brand}
            sections={sections}
            linkComponent={linkComponent}
            linkHint={linkHint}
            onNavigate={onDrawerLinkClick}
            headerAction={
              <SheetClose asChild>
                <Button variant="plain" size="icon" aria-label="Close menu">
                  <X aria-hidden="true" />
                </Button>
              </SheetClose>
            }
          />
        </SheetContent>
      </Sheet>

      <div
        className={cn(
          'flex min-h-dvh min-w-0 flex-col transition-[padding] duration-base ease-out',
          !sidebarHidden && 'lg:pl-64',
        )}
      >
        <TopToolbar
          ref={toolbarRef}
          appName={appName}
          breadcrumb={breadcrumb}
          titleInToolbar={titleInToolbar}
          leading={
            <>
              <Button
                ref={menuButtonRef}
                variant="plain"
                size="icon"
                aria-label="Open menu"
                aria-haspopup="dialog"
                onClick={(event) => openDrawer(event.currentTarget)}
                className="lg:hidden"
              >
                <Menu aria-hidden="true" />
              </Button>
              {sidebarHidden ? (
                <Button
                  ref={showButtonRef}
                  variant="plain"
                  size="icon"
                  aria-label="Show sidebar"
                  onClick={() => toggleSidebar(false)}
                  className="hidden lg:inline-flex"
                >
                  <PanelLeftOpen aria-hidden="true" />
                </Button>
              ) : null}
            </>
          }
          commandBar={<CommandBarTrigger onOpen={openCommand} />}
          notifications={notifications}
          notificationsUnread={notificationsUnread}
          notificationsOpen={notificationsOpen}
          onNotificationsOpenChange={onNotificationsOpenChange}
          help={help}
          account={account}
        />
        <main
          id="main"
          tabIndex={-1}
          className="mx-auto flex w-full max-w-7xl min-w-0 flex-1 flex-col gap-6 px-4 pt-6 pb-12 outline-none md:px-8"
        >
          {children}
        </main>
      </div>

      <CommandBar
        open={commandOpen}
        onOpenChange={setCommandOpen}
        onCloseAutoFocus={onCommandCloseAutoFocus}
        items={commandItems}
        onSelect={onNavigate}
      />
    </ShellContext.Provider>
  );
}
