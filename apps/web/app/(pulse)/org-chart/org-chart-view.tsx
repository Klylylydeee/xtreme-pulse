'use client';

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Maximize, Network, Search, ZoomIn, ZoomOut } from 'lucide-react';
import type { DirectoryDepartmentOption, OrgChartNode } from '@pulse/core';
import { cn } from '@pulse/ui';
import { Button } from '@pulse/ui/components/button';
import { EmptyState } from '@pulse/ui/components/empty-state';
import { Input, Select } from '@pulse/ui/components/form';
import { InspectorLayout } from '@pulse/ui/components/inspector-panel';
import { PageHeader } from '@pulse/ui/components/page-header';
import { useMediaQuery } from '@pulse/ui/hooks/use-media-query';
import { plural } from '@/components/org-structure';
import { PersonAvatar } from '@/components/person-avatar';
import {
  PersonInspector,
  type PersonInspectorViewer,
  usePersonInspector,
} from '@/components/person-inspector';
import { layoutOrgChart, type OrgChartGrid } from '@/lib/org-chart-layout';

// Spec: docs/modules/core.md#org-chart and docs/DESIGN_SYSTEM.md (Org chart) — the org chart
// (build step 1.11). One form at every width: a scrollable, zoomable region (`role="region"`,
// focusable, so the keyboard scrolls it) with Zoom out, Zoom in and Fit (44px targets); the page
// itself never scrolls sideways. Each person is placed once, by the longest chain of supervisors
// above them (lib/org-chart-layout.ts), with one line to each shown supervisor, drawn in one SVG
// layer hidden from assistive technology. Cards are buttons in DOM order by level, then position,
// each named with whom they report to; one opens that person's card in the inspector
// (`?person=<employeeId>`). The department filter (`?department=`) reloads from the server; the
// name search (`?q=`) highlights matches on the client with a ring and the label "Match", dims the
// rest and scrolls to the first match, without changing the layout. With reduced motion, zooming
// and scrolling don't animate.

const GRID: OrgChartGrid = { cardWidth: 232, cardHeight: 100, columnGap: 24, rowGap: 56 };
/** Room around the chart inside the region, in pixels (unscaled). */
const PADDING = 24;
const SEARCH_DELAY_MS = 250;
const ZOOM_STEPS = [0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1, 1.25, 1.5] as const;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 1.5;
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/** Lowercased words, without accents, for a forgiving name match. */
function wordsOf(text: string): string[] {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().split(/\s+/).filter(Boolean);
}

function matchesName(name: string, words: readonly string[]): boolean {
  if (words.length === 0) return false;
  const haystack = wordsOf(name).join(' ');
  return words.every((word) => haystack.includes(word));
}

/** "A", "A and B", "A, B and C". */
function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

/** The path for one line: an elbow down from the supervisor, or a curve when it points up. */
function edgePath(
  from: { x: number; y: number },
  to: { x: number; y: number },
  grid: OrgChartGrid,
): string {
  const sx = from.x + grid.cardWidth / 2;
  const sy = from.y + grid.cardHeight;
  const tx = to.x + grid.cardWidth / 2;
  const ty = to.y;
  if (ty > sy) {
    const midY = sy + (ty - sy) / 2;
    return `M ${sx} ${sy} V ${midY} H ${tx} V ${ty}`;
  }
  // A line in a cycle (bad data) can point up: a loop that stays inside the drawing.
  const bend = grid.rowGap;
  return `M ${sx} ${sy} C ${sx} ${sy + bend}, ${tx} ${Math.max(0, ty - bend)}, ${tx} ${ty}`;
}

export function OrgChartView({
  nodes,
  departments,
  departmentId,
  boardDepartmentCode,
  viewer,
}: {
  nodes: OrgChartNode[];
  departments: DirectoryDepartmentOption[];
  departmentId: string | null;
  boardDepartmentCode: string;
  viewer: PersonInspectorViewer;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const inspector = usePersonInspector();
  const reducedMotion = useMediaQuery(REDUCED_MOTION) === true;
  const [filtering, startFiltering] = useTransition();
  const searchId = useId();
  const departmentFilterId = useId();
  const regionRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef(new Map<string, HTMLButtonElement>());

  // The search: typed now, applied (highlight, scroll, URL) 250 ms after the last key.
  const [query, setQuery] = useState(() => searchParams.get('q') ?? '');
  const [applied, setApplied] = useState(query);
  const searchTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(searchTimer.current), []);

  const layout = useMemo(() => layoutOrgChart(nodes, GRID), [nodes]);
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const positionOf = useMemo(
    () => new Map(layout.nodes.map((position) => [position.id, position])),
    [layout],
  );

  const words = useMemo(() => wordsOf(applied), [applied]);
  const searching = words.length > 0;
  const matches = useMemo(() => {
    const found = new Set<string>();
    if (words.length === 0) return found;
    for (const node of nodes) if (matchesName(node.name, words)) found.add(node.id);
    return found;
  }, [nodes, words]);
  // In DOM order (by level, then position).
  const firstMatch = layout.nodes.find((position) => matches.has(position.id))?.id ?? null;

  // --- Zoom ------------------------------------------------------------------------------------

  const [zoom, setZoom] = useState(1);
  // False until the first fit: no animation and no scroll to a match before the zoom is set.
  const [ready, setReady] = useState(false);
  const fitted = useRef(false);

  const fitZoom = useCallback(
    (widthOnly: boolean) => {
      const region = regionRef.current;
      if (!region || layout.width === 0) return 1;
      const byWidth = (region.clientWidth - PADDING * 2) / layout.width;
      const byHeight = (region.clientHeight - PADDING * 2) / layout.height;
      const fit = widthOnly ? byWidth : Math.min(byWidth, byHeight);
      return clampZoom(Math.min(1, fit));
    },
    [layout],
  );

  // On first paint: as wide as the region allows (not above 100%), so a phone sees the top.
  useLayoutEffect(() => {
    if (fitted.current) return;
    fitted.current = true;
    setZoom(fitZoom(true));
    setReady(true);
  }, [fitZoom]);

  function zoomBy(direction: 1 | -1) {
    setZoom((current) => {
      if (direction > 0) return ZOOM_STEPS.find((step) => step > current + 0.001) ?? MAX_ZOOM;
      return [...ZOOM_STEPS].reverse().find((step) => step < current - 0.001) ?? MIN_ZOOM;
    });
  }

  function fit() {
    setZoom(fitZoom(false));
    regionRef.current?.scrollTo({ left: 0, top: 0, behavior: reducedMotion ? 'auto' : 'smooth' });
  }

  // --- Scrolling to the first match ------------------------------------------------------------

  const scrollToCard = useCallback(
    (id: string) => {
      const region = regionRef.current;
      const position = positionOf.get(id);
      if (!region || !position) return;
      const left =
        PADDING + position.x * zoom + (GRID.cardWidth * zoom) / 2 - region.clientWidth / 2;
      const top =
        PADDING + position.y * zoom + (GRID.cardHeight * zoom) / 2 - region.clientHeight / 2;
      region.scrollTo({
        left: Math.max(0, left),
        top: Math.max(0, top),
        behavior: reducedMotion ? 'auto' : 'smooth',
      });
    },
    [positionOf, zoom, reducedMotion],
  );

  // A new search scrolls to its first match (not a zoom change: the user is looking around).
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!ready) return;
    const key = searching ? `${applied}:${firstMatch ?? ''}` : null;
    if (key === scrolledFor.current) return;
    scrolledFor.current = key;
    if (firstMatch) scrollToCard(firstMatch);
  }, [ready, applied, searching, firstMatch, scrollToCard]);

  // --- URL state -------------------------------------------------------------------------------

  /** Writes `?q=` without a navigation: the search never reloads the chart. */
  function writeQuery(next: string) {
    const params = new URLSearchParams(window.location.search);
    if (next) params.set('q', next);
    else params.delete('q');
    const search = params.toString();
    window.history.replaceState(null, '', `${pathname}${search ? `?${search}` : ''}`);
  }

  function searchFor(next: string) {
    setQuery(next);
    window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => apply(next), SEARCH_DELAY_MS);
  }

  function apply(next: string) {
    const trimmed = next.trim().slice(0, 100);
    setApplied(trimmed);
    writeQuery(trimmed);
  }

  function clearSearch() {
    window.clearTimeout(searchTimer.current);
    setQuery('');
    apply('');
  }

  /** The department filter reloads the chart from the server, keeping `?q=` and `?person=`. */
  function setDepartment(next: string | null) {
    const params = new URLSearchParams(window.location.search);
    if (next) params.set('department', next);
    else params.delete('department');
    const search = params.toString();
    startFiltering(() => {
      router.replace(`${pathname}${search ? `?${search}` : ''}`, { scroll: false });
    });
  }

  const knownDepartment =
    departmentId === null || departments.some((department) => department.id === departmentId);
  const departmentName = departments.find((department) => department.id === departmentId)?.name;
  const selected = inspector.open ? inspector.personId : null;
  const previewNode = inspector.personId ? (byId.get(inspector.personId) ?? null) : null;

  const scaledWidth = layout.width * zoom + PADDING * 2;
  const scaledHeight = layout.height * zoom + PADDING * 2;

  return (
    <>
      <PageHeader
        title="Org chart"
        description="Who reports to whom, built from everyone’s reporting lines."
      />
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
          <div className="flex w-full flex-col gap-1.5 sm:w-72">
            <label htmlFor={searchId} className="text-footnote font-semibold text-text-secondary">
              Find a person
            </label>
            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-3 size-4.5 -translate-y-1/2 text-text-secondary"
              />
              <Input
                id={searchId}
                type="search"
                value={query}
                onChange={(event) => searchFor(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    window.clearTimeout(searchTimer.current);
                    apply(query);
                    // The same search again goes back to its first match.
                    if (firstMatch) scrollToCard(firstMatch);
                  }
                }}
                placeholder="Name"
                autoComplete="off"
                spellCheck={false}
                maxLength={100}
                className="pl-10"
              />
            </div>
          </div>
          <div className="flex w-full flex-col gap-1.5 sm:w-64">
            <label
              htmlFor={departmentFilterId}
              className="text-footnote font-semibold text-text-secondary"
            >
              Department
            </label>
            <Select
              id={departmentFilterId}
              value={departmentId ?? ''}
              onChange={(event) => setDepartment(event.target.value || null)}
              disabled={filtering}
              aria-busy={filtering || undefined}
            >
              <option value="">All departments</option>
              {!knownDepartment && departmentId ? (
                <option value={departmentId}>Unknown department</option>
              ) : null}
              {departments.map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name}
                </option>
              ))}
            </Select>
          </div>
          {nodes.length > 0 ? (
            <div role="group" aria-label="Zoom" className="flex items-center gap-1 sm:ml-auto">
              <Button
                variant="secondary"
                size="icon"
                aria-label="Zoom out"
                disabled={zoom <= MIN_ZOOM}
                onClick={() => zoomBy(-1)}
              >
                <ZoomOut aria-hidden="true" />
              </Button>
              <span
                aria-live="polite"
                className="numeric min-w-12 text-center text-footnote text-text-secondary"
              >
                {Math.round(zoom * 100)}%
              </span>
              <Button
                variant="secondary"
                size="icon"
                aria-label="Zoom in"
                disabled={zoom >= MAX_ZOOM}
                onClick={() => zoomBy(1)}
              >
                <ZoomIn aria-hidden="true" />
              </Button>
              <Button variant="secondary" size="icon" aria-label="Fit" onClick={fit}>
                <Maximize aria-hidden="true" />
              </Button>
            </div>
          ) : null}
        </div>
        <p role="status" className="numeric text-footnote text-text-secondary">
          {plural(nodes.length, 'person', 'people')}
          {departmentName ? ` in ${departmentName}` : null}
          {searching ? (
            matches.size > 0 ? (
              <>
                {' · '}
                {plural(matches.size, 'match', 'matches')} for “{applied}”
              </>
            ) : (
              <>
                {' · '}No one matches “{applied}”.{' '}
                <button
                  type="button"
                  onClick={clearSearch}
                  className="inline-flex min-h-11 cursor-pointer items-center font-medium text-accent underline"
                >
                  Clear search
                </button>
              </>
            )
          ) : null}
        </p>
      </div>

      <InspectorLayout>
        <div
          className={cn('flex min-w-0 flex-1 flex-col gap-4', filtering && 'opacity-60')}
          aria-busy={filtering || undefined}
        >
          {nodes.length === 0 ? (
            departmentId ? (
              <EmptyState
                icon={<Network strokeWidth={1.75} />}
                title="No one in this department"
                description="Active people in the department show up here with their reporting lines."
                action={
                  <Button variant="tinted" onClick={() => setDepartment(null)}>
                    Show all departments
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={<Network strokeWidth={1.75} />}
                title="No one on the chart yet"
                description="The chart builds itself from reporting lines once HR adds people with an active account."
              />
            )
          ) : (
            <div
              ref={regionRef}
              role="region"
              aria-label={departmentName ? `Org chart, ${departmentName}` : 'Org chart'}
              tabIndex={0}
              className={cn(
                'relative h-[min(72dvh,52rem)] min-h-80 w-full max-w-full overflow-auto overscroll-contain rounded-card bg-bg-grouped',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
              )}
            >
              <div className="relative" style={{ width: scaledWidth, height: scaledHeight }}>
                <div
                  className={cn(
                    'absolute origin-top-left',
                    ready && !reducedMotion && 'transition-transform duration-base ease-out',
                  )}
                  style={{
                    left: PADDING,
                    top: PADDING,
                    width: layout.width,
                    height: layout.height,
                    transform: `scale(${zoom})`,
                  }}
                >
                  <svg
                    aria-hidden="true"
                    focusable="false"
                    width={layout.width}
                    height={layout.height}
                    viewBox={`0 0 ${layout.width} ${layout.height}`}
                    overflow="visible"
                    className="pointer-events-none absolute inset-0 fill-none stroke-separator"
                  >
                    {layout.edges.map((edge) => {
                      const from = positionOf.get(edge.from);
                      const to = positionOf.get(edge.to);
                      if (!from || !to) return null;
                      const related = !searching || matches.has(edge.from) || matches.has(edge.to);
                      return (
                        <path
                          key={`${edge.from}-${edge.to}`}
                          d={edgePath(from, to, GRID)}
                          strokeWidth={1}
                          vectorEffect="non-scaling-stroke"
                          className={cn(!related && 'opacity-40')}
                        />
                      );
                    })}
                  </svg>
                  {layout.nodes.map((position) => {
                    const node = byId.get(position.id);
                    if (!node) return null;
                    return (
                      <OrgChartCard
                        key={node.id}
                        node={node}
                        x={position.x}
                        y={position.y}
                        supervisorNames={[
                          ...node.supervisorIds.flatMap((id) => byId.get(id)?.name ?? []),
                          ...node.externalSupervisors.map((supervisor) => supervisor.name),
                        ]}
                        match={matches.has(node.id)}
                        dimmed={searching && !matches.has(node.id)}
                        selected={selected === node.id}
                        cardRef={(element) => {
                          if (element) cardRefs.current.set(node.id, element);
                          else cardRefs.current.delete(node.id);
                        }}
                        onOpen={(element) => inspector.openPerson(node.id, element)}
                      />
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>

        <PersonInspector
          open={inspector.open}
          onOpenChange={inspector.changeOpen}
          personId={inspector.personId}
          session={inspector.session}
          returnFocus={inspector.returnFocus}
          onOpenPerson={(id) => {
            inspector.openPerson(id, cardRefs.current.get(id) ?? null);
            if (positionOf.has(id)) scrollToCard(id);
          }}
          preview={previewNode}
          boardDepartmentCode={boardDepartmentCode}
          viewer={viewer}
        />
      </InspectorLayout>
    </>
  );
}

function OrgChartCard({
  node,
  x,
  y,
  supervisorNames,
  match,
  dimmed,
  selected,
  cardRef,
  onOpen,
}: {
  node: OrgChartNode;
  x: number;
  y: number;
  /** Every supervisor's name: the shown lines first, then those outside the department. */
  supervisorNames: string[];
  match: boolean;
  dimmed: boolean;
  selected: boolean;
  cardRef: (element: HTMLButtonElement | null) => void;
  onOpen: (element: HTMLButtonElement) => void;
}) {
  // "Reports to <names>" only when no line is drawn but the person has supervisors elsewhere.
  const caption =
    node.supervisorIds.length === 0 && node.externalSupervisors.length > 0
      ? `Reports to ${listNames(node.externalSupervisors.map((supervisor) => supervisor.name))}`
      : null;
  const label = [
    node.name,
    node.positionName,
    supervisorNames.length > 0 ? `reports to ${listNames(supervisorNames)}` : null,
    match ? 'match' : null,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <button
      ref={cardRef}
      type="button"
      aria-label={label}
      aria-current={selected || undefined}
      onClick={(event) => onOpen(event.currentTarget)}
      style={{ left: x, top: y, width: GRID.cardWidth, height: GRID.cardHeight }}
      className={cn(
        'absolute flex cursor-pointer flex-col justify-center gap-1 overflow-hidden rounded-card bg-surface px-3 py-2 text-left shadow-card',
        'transition-[opacity,background-color] duration-fast motion-reduce:transition-none',
        'hover:bg-accent-subtle/50 aria-[current=true]:bg-accent-subtle',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        match && 'ring-2 ring-accent',
        dimmed && 'opacity-50',
      )}
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <PersonAvatar initials={node.initials} size="sm" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-subheadline font-semibold">{node.name}</span>
            {match ? (
              <span className="shrink-0 rounded-md bg-accent-subtle px-1.5 py-px text-caption font-semibold text-accent">
                Match
              </span>
            ) : null}
          </span>
          <span className="truncate text-footnote text-text-secondary">
            {node.positionName ?? '—'}
          </span>
          <span className="truncate text-footnote text-text-secondary">
            {node.departmentName ?? '—'}
          </span>
        </span>
      </span>
      {caption ? (
        <span title={caption} className="truncate text-caption text-text-secondary">
          {caption}
        </span>
      ) : null}
    </button>
  );
}
