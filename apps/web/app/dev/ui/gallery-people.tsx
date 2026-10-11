'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, CheckCheck, House, Network, Users } from 'lucide-react';
import { Avatar } from '@pulse/ui/components/avatar';
import { Button } from '@pulse/ui/components/button';
import { CommandBar, type CommandResultGroup } from '@pulse/ui/components/command-bar';
import { SegmentedControl } from '@pulse/ui/components/segmented-control';
import type { ShellNavItem } from '@pulse/ui/components/sidebar';

const PEOPLE = [
  { id: 'e1', firstName: 'Maria', lastName: 'Santos', number: 'XW-0001', position: 'HR Officer' },
  { id: 'e2', firstName: 'José', lastName: 'Reyes', number: 'XW-0002', position: 'Technician' },
  { id: 'e3', firstName: 'Ana', lastName: 'Cruz', number: 'XW-0003', position: 'Project Engineer' },
  { id: 'e4', firstName: 'Paolo', lastName: 'Garcia', number: 'XW-0004', position: 'Driver' },
];

export function AvatarDemo() {
  return (
    <div className="flex flex-col gap-4 rounded-card bg-surface p-4 shadow-card">
      <div className="flex flex-wrap items-end gap-4">
        {(['sm', 'md', 'lg'] as const).map((size) => (
          <div key={size} className="flex flex-col items-center gap-2">
            <Avatar firstName="Maria" lastName="Santos" size={size} />
            <span className="text-footnote text-text-secondary">{size}</span>
          </div>
        ))}
      </div>
      <ul className="flex flex-col gap-3">
        {PEOPLE.slice(0, 3).map((person) => (
          <li key={person.id} className="flex items-center gap-3">
            <Avatar firstName={person.firstName} lastName={person.lastName} />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-subheadline font-semibold">
                {person.firstName} {person.lastName}
              </span>
              <span className="truncate text-footnote text-text-secondary">
                {person.number} · {person.position}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const NAV_ITEMS: ShellNavItem[] = [
  { href: '/', label: 'Home', icon: <House strokeWidth={1.75} /> },
  { href: '/approvals', label: 'Approvals', icon: <CheckCheck strokeWidth={1.75} /> },
  { href: '/holidays', label: 'Holidays', icon: <CalendarDays strokeWidth={1.75} /> },
  {
    href: '/directory',
    label: 'Directory',
    keywords: ['people', 'employees'],
    icon: <Users strokeWidth={1.75} />,
  },
  { href: '/org-chart', label: 'Org chart', icon: <Network strokeWidth={1.75} /> },
];

type DemoMode = 'live' | 'loading' | 'error';

/** Lower case without accents, for the sample search. */
function fold(text: string) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

export function CommandBarDemo() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<DemoMode>('live');
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [answer, setAnswer] = useState<{ query: string; groups: CommandResultGroup[] }>({
    query: '',
    groups: [],
  });
  const [picked, setPicked] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // A sample people search: from 2 characters, after 200 ms without typing, with a short delay.
  const trimmed = query.trim();
  useEffect(() => {
    if (mode !== 'live' || trimmed.length < 2) return;
    let stale = false;
    const timer = setTimeout(() => {
      setSearching(true);
      setTimeout(() => {
        if (stale) return;
        const needle = fold(trimmed);
        const items = PEOPLE.filter((person) =>
          fold(`${person.firstName} ${person.lastName} ${person.number}`).includes(needle),
        ).map((person) => ({
          id: person.id,
          title: `${person.firstName} ${person.lastName}`,
          subtitle: `${person.number} · ${person.position}`,
          href: `/directory?person=${person.id}`,
          icon: 'person' as const,
        }));
        setAnswer({ query: trimmed, groups: [{ heading: 'People', items }] });
        setSearching(false);
      }, 400);
    }, 200);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [mode, trimmed]);

  const resultGroups = useMemo(
    () => (mode === 'live' && trimmed.length >= 2 && answer.query === trimmed ? answer.groups : []),
    [mode, trimmed, answer],
  );
  const loading = mode === 'loading' || (mode === 'live' && searching && trimmed.length >= 2);

  return (
    <div className="flex flex-col gap-4 rounded-card bg-surface p-4 shadow-card">
      <SegmentedControl
        label="Search state"
        value={mode}
        onValueChange={setMode}
        options={[
          { value: 'live', label: 'Sample search' },
          { value: 'loading', label: 'Searching' },
          { value: 'error', label: 'Search failed' },
        ]}
      />
      <p className="text-footnote text-text-secondary">
        Try “maria”, “XW-0002” or “org”. Type something with no match to see the empty state.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button ref={triggerRef} variant="secondary" onClick={() => setOpen(true)}>
          Open the command bar
        </Button>
        {picked ? (
          <span className="text-subheadline text-text-secondary" aria-live="polite">
            Would open {picked}
          </span>
        ) : null}
      </div>
      <CommandBar
        open={open}
        onOpenChange={setOpen}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          triggerRef.current?.focus();
        }}
        items={NAV_ITEMS}
        onSelect={setPicked}
        query={query}
        onQueryChange={setQuery}
        resultGroups={resultGroups}
        loading={loading}
        error={mode === 'error'}
      />
    </div>
  );
}
