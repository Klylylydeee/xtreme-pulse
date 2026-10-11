// The org chart layout (step 1.11, docs/modules/core.md#org-chart, BUILD_PLAN decision 147). Pure:
// it takes the people already filtered on the server and places each one once, on the level of the
// longest chain of supervisors above them, with one line to each shown supervisor. The order within
// a level comes from a few barycenter sweeps with a tiebreak by id, so the same input always gives
// the same chart. Positions snap to a grid of whole cards. A cycle in bad input still finishes: the
// longest-chain walk keeps a visited set and ignores a line that leads back into its own chain.

/** The part of an org chart node the layout needs (the shape of Core's OrgChartNode). */
export interface OrgChartLayoutInput {
  id: string;
  /** Shown supervisors' ids. An id that isn't among the nodes is ignored. */
  supervisorIds: readonly string[];
}

/** The grid, in pixels. */
export interface OrgChartGrid {
  cardWidth: number;
  cardHeight: number;
  /** Between two cards on one level. */
  columnGap: number;
  /** Between two levels. */
  rowGap: number;
}

export interface OrgChartLayoutOptions {
  /** Barycenter sweeps (down, up, down, …), clamped to 2–4. Default 3. */
  sweeps?: number;
}

export interface OrgChartPosition {
  id: string;
  /** 0 at the top: the longest chain of shown supervisors above this person. */
  layer: number;
  /** 0-based place within the layer, left to right. */
  order: number;
  /** Top-left corner of the card, in pixels. */
  x: number;
  y: number;
}

/** One supervisor line: from the supervisor's card to the employee's. */
export interface OrgChartEdge {
  from: string;
  to: string;
}

export interface OrgChartLayout {
  /** In DOM order: by layer, then order. */
  nodes: OrgChartPosition[];
  /** One per shown supervisor line, in the order of `nodes` (by employee), then by supervisor id. */
  edges: OrgChartEdge[];
  width: number;
  height: number;
  layerCount: number;
}

const DEFAULT_SWEEPS = 3;
const MIN_SWEEPS = 2;
const MAX_SWEEPS = 4;

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function assertGrid(grid: OrgChartGrid): void {
  for (const [key, value] of Object.entries(grid)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`Org chart grid ${key} must be a non-negative number.`);
    }
  }
}

/**
 * The longest chain of supervisors above each node. An iterative depth-first walk with a visited
 * set: a supervisor still on the current chain is a cycle, and that line doesn't count. The depth
 * cap (the node count) stops the walk even if that ever failed.
 */
function longestChainLayers(
  ids: readonly string[],
  supervisorsOf: ReadonlyMap<string, readonly string[]>,
): Map<string, number> {
  const layer = new Map<string, number>();
  const onChain = new Set<string>();
  const depthCap = ids.length;

  for (const start of ids) {
    if (layer.has(start)) continue;
    const stack: { id: string; next: number; best: number }[] = [{ id: start, next: 0, best: 0 }];
    onChain.add(start);
    let frame = stack.at(-1);
    while (frame) {
      const supervisors = supervisorsOf.get(frame.id) ?? [];
      const supervisorId = stack.length <= depthCap ? supervisors[frame.next] : undefined;
      if (supervisorId !== undefined) {
        frame.next += 1;
        const known = layer.get(supervisorId);
        if (known !== undefined) {
          frame.best = Math.max(frame.best, known + 1);
        } else if (!onChain.has(supervisorId)) {
          onChain.add(supervisorId);
          stack.push({ id: supervisorId, next: 0, best: 0 });
        }
        frame = stack.at(-1);
        continue;
      }
      stack.pop();
      onChain.delete(frame.id);
      const value = Math.min(frame.best, depthCap - 1);
      layer.set(frame.id, value);
      frame = stack.at(-1);
      if (frame) frame.best = Math.max(frame.best, value + 1);
    }
  }
  return layer;
}

/** Reorders one layer by the mean place of its neighbors; a node without any keeps its place. */
function sortByBarycenter(
  row: string[],
  neighborsOf: ReadonlyMap<string, readonly string[]>,
  placeOf: Map<string, number>,
): void {
  const center = new Map<string, number>();
  row.forEach((id, index) => {
    const places = (neighborsOf.get(id) ?? [])
      .map((neighbor) => placeOf.get(neighbor))
      .filter((place): place is number => place !== undefined);
    center.set(
      id,
      places.length > 0 ? places.reduce((sum, place) => sum + place, 0) / places.length : index,
    );
  });
  row.sort((a, b) => (center.get(a) ?? 0) - (center.get(b) ?? 0) || compareIds(a, b));
  row.forEach((id, index) => placeOf.set(id, index));
}

/**
 * Places each node once, below every shown supervisor, on a grid of `grid` cells. Duplicate node
 * ids keep the first; duplicate, self and unknown supervisor ids are ignored.
 */
export function layoutOrgChart(
  input: readonly OrgChartLayoutInput[],
  grid: OrgChartGrid,
  options: OrgChartLayoutOptions = {},
): OrgChartLayout {
  assertGrid(grid);
  const sweeps = Math.min(
    MAX_SWEEPS,
    Math.max(MIN_SWEEPS, Math.trunc(options.sweeps ?? DEFAULT_SWEEPS)),
  );

  const known = new Set<string>();
  for (const node of input) known.add(node.id);
  const ids = [...known].sort(compareIds);

  const supervisorsOf = new Map<string, string[]>();
  const reportsOf = new Map<string, string[]>();
  for (const id of ids) reportsOf.set(id, []);
  const seen = new Set<string>();
  for (const node of input) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    const supervisors = [...new Set(node.supervisorIds)]
      .filter((supervisorId) => supervisorId !== node.id && known.has(supervisorId))
      .sort(compareIds);
    supervisorsOf.set(node.id, supervisors);
    for (const supervisorId of supervisors) reportsOf.get(supervisorId)?.push(node.id);
  }

  const layerOf = longestChainLayers(ids, supervisorsOf);
  let layerCount = 0;
  for (const layer of layerOf.values()) layerCount = Math.max(layerCount, layer + 1);
  const rows: string[][] = Array.from({ length: layerCount }, () => []);
  for (const id of ids) rows[layerOf.get(id) ?? 0]?.push(id);

  // A place is the index within the node's own layer; barycenters compare across layers by it.
  const placeOf = new Map<string, number>();
  for (const row of rows) row.forEach((id, index) => placeOf.set(id, index));
  for (let sweep = 0; sweep < sweeps; sweep += 1) {
    if (sweep % 2 === 0) {
      for (const row of rows.slice(1)) sortByBarycenter(row, supervisorsOf, placeOf);
    } else {
      for (const row of rows.slice(0, -1).reverse()) sortByBarycenter(row, reportsOf, placeOf);
    }
  }

  const columns = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const columnStep = grid.cardWidth + grid.columnGap;
  const rowStep = grid.cardHeight + grid.rowGap;
  const nodes: OrgChartPosition[] = [];
  rows.forEach((row, layer) => {
    // Center each layer under the widest one, in whole columns so cards stay on the grid.
    const offset = Math.floor((columns - row.length) / 2);
    row.forEach((id, order) => {
      nodes.push({ id, layer, order, x: (offset + order) * columnStep, y: layer * rowStep });
    });
  });

  const edges: OrgChartEdge[] = nodes.flatMap(({ id }) =>
    (supervisorsOf.get(id) ?? []).map((from) => ({ from, to: id })),
  );

  return {
    nodes,
    edges,
    width: columns === 0 ? 0 : columns * grid.cardWidth + (columns - 1) * grid.columnGap,
    height: layerCount === 0 ? 0 : layerCount * grid.cardHeight + (layerCount - 1) * grid.rowGap,
    layerCount,
  };
}
