import { describe, expect, it } from 'vitest';
import { layoutOrgChart, type OrgChartGrid, type OrgChartLayoutInput } from './org-chart-layout';

// Spec: docs/TESTING.md#directory-org-chart-and-command-bar-tests (the layout) and
// docs/modules/core.md#org-chart — each person is placed once, below every shown supervisor, by the
// longest chain above them; the order is stable; a cycle in bad input still finishes. Pure: no
// database.

const GRID: OrgChartGrid = { cardWidth: 200, cardHeight: 80, columnGap: 24, rowGap: 48 };

function node(id: string, ...supervisorIds: string[]): OrgChartLayoutInput {
  return { id, supervisorIds };
}

function layersOf(input: OrgChartLayoutInput[]): Record<string, number> {
  return Object.fromEntries(layoutOrgChart(input, GRID).nodes.map((n) => [n.id, n.layer]));
}

describe('layoutOrgChart', () => {
  it('places a person with two supervisors once, below both, with two lines', () => {
    const layout = layoutOrgChart(
      [node('ana', 'ben', 'carla'), node('ben'), node('carla', 'dina'), node('dina')],
      GRID,
    );
    const ana = layout.nodes.filter((n) => n.id === 'ana');
    expect(ana).toHaveLength(1);
    const layer = Object.fromEntries(layout.nodes.map((n) => [n.id, n.layer]));
    expect(layer.ana).toBeGreaterThan(layer.ben ?? Infinity);
    expect(layer.ana).toBeGreaterThan(layer.carla ?? Infinity);
    // Longest chain: dina › carla › ana, so ana sits on level 2 even though ben is on level 0.
    expect(layer).toEqual({ ana: 2, ben: 0, carla: 1, dina: 0 });
    expect(layout.edges.filter((e) => e.to === 'ana')).toEqual([
      { from: 'ben', to: 'ana' },
      { from: 'carla', to: 'ana' },
    ]);
    expect(layout.edges).toHaveLength(3);
  });

  it('gives the right layers for a few hierarchies', () => {
    // A chain.
    expect(layersOf([node('c', 'b'), node('b', 'a'), node('a')])).toEqual({ a: 0, b: 1, c: 2 });
    // A tree with two branches of different depths.
    expect(
      layersOf([
        node('ceo'),
        node('cto', 'ceo'),
        node('cfo', 'ceo'),
        node('dev', 'cto'),
        node('qa', 'dev'),
      ]),
    ).toEqual({ ceo: 0, cto: 1, cfo: 1, dev: 2, qa: 3 });
    // Two separate roots and a person with nobody shown above them.
    expect(layersOf([node('x'), node('y'), node('z', 'y')])).toEqual({ x: 0, y: 0, z: 1 });
    // A diamond: d reports to b and c, who both report to a.
    expect(layersOf([node('a'), node('b', 'a'), node('c', 'a'), node('d', 'b', 'c')])).toEqual({
      a: 0,
      b: 1,
      c: 1,
      d: 2,
    });
  });

  it('ignores supervisor ids that are not among the nodes, and duplicates', () => {
    const layout = layoutOrgChart(
      [node('a'), node('b', 'a', 'gone', 'a'), node('c', 'gone'), node('c', 'a')],
      GRID,
    );
    expect(layout.nodes.map((n) => [n.id, n.layer])).toEqual([
      ['a', 0],
      ['c', 0],
      ['b', 1],
    ]);
    expect(layout.edges).toEqual([{ from: 'a', to: 'b' }]);
  });

  it('finishes on a cycle and places every node once', () => {
    const input = [
      node('a', 'c'),
      node('b', 'a'),
      node('c', 'b'),
      node('d', 'd'),
      node('e', 'a', 'e'),
    ];
    const layout = layoutOrgChart(input, GRID);
    expect(layout.nodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    for (const n of layout.nodes) {
      expect(n.layer).toBeGreaterThanOrEqual(0);
      expect(n.layer).toBeLessThan(input.length);
    }
    // Self lines are dropped; the cycle's three lines are kept.
    expect(layout.edges).toHaveLength(4);
  });

  it('finishes on a long chain without overflowing the stack', () => {
    const input = Array.from({ length: 5000 }, (_, i) =>
      node(
        `p${String(i).padStart(4, '0')}`,
        ...(i > 0 ? [`p${String(i - 1).padStart(4, '0')}`] : []),
      ),
    );
    const layout = layoutOrgChart(input, GRID);
    expect(layout.layerCount).toBe(5000);
    expect(layout.nodes.at(-1)).toMatchObject({ id: 'p4999', layer: 4999 });
  });

  it('is deterministic whatever the input order', () => {
    const input = [
      node('ceo'),
      node('ops', 'ceo'),
      node('eng', 'ceo'),
      node('tech1', 'eng', 'ops'),
      node('tech2', 'ops'),
      node('dev1', 'eng'),
      node('dev2', 'eng'),
      node('hr'),
    ];
    const first = layoutOrgChart(input, GRID);
    const reversed = layoutOrgChart([...input].reverse(), GRID);
    expect(reversed).toEqual(first);
    expect(layoutOrgChart(input, GRID)).toEqual(first);
  });

  it('orders nodes by layer, then position, and snaps them to the grid', () => {
    const layout = layoutOrgChart(
      [node('root'), node('left', 'root'), node('right', 'root'), node('kid', 'right')],
      GRID,
    );
    layout.nodes.slice(1).forEach((curr, i) => {
      const prev = layout.nodes[i] ?? curr;
      expect(
        prev.layer < curr.layer || (prev.layer === curr.layer && prev.order < curr.order),
      ).toBe(true);
    });
    for (const n of layout.nodes) {
      expect(n.x % (GRID.cardWidth + GRID.columnGap)).toBe(0);
      expect(n.y).toBe(n.layer * (GRID.cardHeight + GRID.rowGap));
    }
    expect(layout.width).toBe(2 * GRID.cardWidth + GRID.columnGap);
    expect(layout.height).toBe(3 * GRID.cardHeight + 2 * GRID.rowGap);
  });

  it('keeps reports under their own supervisor after the sweeps', () => {
    // Without sweeps, the id order would put a1 and b1 the wrong way round under b and a.
    const layout = layoutOrgChart([node('a'), node('b'), node('b1', 'a'), node('a1', 'b')], GRID);
    const order = Object.fromEntries(layout.nodes.map((n) => [n.id, n.order]));
    expect(order).toEqual({ a: 0, b: 1, b1: 0, a1: 1 });
  });

  it('handles an empty input', () => {
    expect(layoutOrgChart([], GRID)).toEqual({
      nodes: [],
      edges: [],
      width: 0,
      height: 0,
      layerCount: 0,
    });
  });

  it('refuses a grid size that is not a non-negative number', () => {
    expect(() => layoutOrgChart([], { ...GRID, cardWidth: Number.NaN })).toThrow(RangeError);
    expect(() => layoutOrgChart([], { ...GRID, rowGap: -1 })).toThrow(RangeError);
  });
});
