'use client';

import { cloneElement, type ReactElement, type ReactNode } from 'react';
import { cn } from '../lib/utils';

/*
 * The chart wrapper (DESIGN_SYSTEM.md › Data-rich): Recharts charts with an accessible name.
 * Style: accent for the main series, neutral grays for context, direct labels instead of legends,
 * tabular numerals. Colors are token references, so charts follow light and dark.
 */

/** Chart colors as token references, for Recharts `fill` and `stroke` props. */
export const CHART_COLORS = {
  /** The main series. */
  main: 'var(--accent)',
  /** Context series and bars (targets, other periods): a gray at 3:1 or more on surface. */
  context: 'var(--chart-context)',
  /** Gridlines (decorative; never the only way to read a value). */
  grid: 'var(--separator)',
  /** Axis ticks and secondary labels. */
  label: 'var(--text-secondary)',
  /** Direct labels on values. */
  value: 'var(--text-primary)',
} as const;

/** Axis props for a calm axis: no lines, small secondary ticks with tabular numerals. */
export const CHART_AXIS_PROPS = {
  axisLine: false,
  tickLine: false,
  tick: {
    fill: CHART_COLORS.label,
    fontSize: 'var(--text-caption)',
    style: { fontVariantNumeric: 'tabular-nums' },
  },
} as const;

export type ChartDataTable = {
  /** A short caption for the table, e.g. "Hours per day". Defaults to "Chart data". */
  caption?: string;
  columns: readonly string[];
  rows: readonly (readonly ReactNode[])[];
};

type RechartsChartProps = {
  accessibilityLayer?: boolean;
  responsive?: boolean;
  width?: number | `${number}%`;
  height?: number | `${number}%`;
};

/**
 * Wraps one Recharts chart (BarChart, LineChart…) as a single image with an accessible name
 * (`role="img"` + `aria-label`). `label` is required: describe what the chart shows and its key
 * values, e.g. "Hours worked per day, Sep 11 to 25; offset 2.5 h on Mon Sep 14". Pass `dataTable`
 * to add the numbers as a table for screen readers as well.
 *
 * The chart fills the wrapper's width at `height`. Recharts' own keyboard layer is turned off, since
 * the chart is announced as one image.
 */
export function Chart({
  label,
  height = 10,
  dataTable,
  className,
  children,
}: {
  label: string;
  /** Height in rem, so it scales with browser zoom (default 10rem). */
  height?: number;
  dataTable?: ChartDataTable;
  className?: string;
  children: ReactElement<RechartsChartProps>;
}) {
  return (
    <figure data-slot="chart" className={cn('m-0 min-w-0', className)}>
      <div
        role="img"
        aria-label={label}
        className="w-full numeric"
        style={{ height: `${height}rem` }}
      >
        {cloneElement(children, {
          accessibilityLayer: false,
          responsive: true,
          width: '100%',
          height: '100%',
        })}
      </div>
      {dataTable ? (
        // A table ignores the sr-only width, so the wrapper hides it.
        <div className="sr-only">
          <table>
            <caption>{dataTable.caption ?? 'Chart data'}</caption>
            <thead>
              <tr>
                {dataTable.columns.map((column) => (
                  <th key={column} scope="col">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dataTable.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) =>
                    cellIndex === 0 ? (
                      <th key={cellIndex} scope="row">
                        {cell}
                      </th>
                    ) : (
                      <td key={cellIndex}>{cell}</td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </figure>
  );
}

/** The parts of Recharts' tooltip content props that ChartTooltip reads. */
export type ChartTooltipProps = {
  active?: boolean;
  label?: ReactNode;
  payload?: ReadonlyArray<{ name?: ReactNode; value?: unknown; dataKey?: unknown }>;
  /** Formats each value (e.g. hours, or an amount from integer centavos). */
  formatValue?: (value: unknown) => string;
};

/**
 * Tooltip content on the tokens:
 * `<Tooltip content={(props) => <ChartTooltip {...props} formatValue={…} />} />`.
 */
export function ChartTooltip({
  active,
  payload,
  label,
  formatValue = (value) => String(value),
}: ChartTooltipProps) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-separator bg-surface px-3 py-2 text-footnote shadow-float numeric">
      {label !== undefined ? <p className="font-semibold text-text-primary">{label}</p> : null}
      <ul className="flex flex-col gap-0.5">
        {payload.map((item) => (
          <li key={String(item.dataKey ?? item.name)} className="flex items-center gap-2">
            <span className="text-text-secondary">{item.name}</span>
            <span className="ml-auto font-semibold text-text-primary">
              {item.value !== undefined ? formatValue(item.value) : '—'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
