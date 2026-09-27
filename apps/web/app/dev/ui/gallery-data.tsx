'use client';

import { useRef, useState } from 'react';
import { CalendarX2, Pencil } from 'lucide-react';
import { Bar, BarChart, LabelList, Line, LineChart, Tooltip, XAxis } from 'recharts';
import { Button } from '@pulse/ui/components/button';
import { CHART_AXIS_PROPS, CHART_COLORS, Chart, ChartTooltip } from '@pulse/ui/components/chart';
import {
  DataTable,
  createDataTableColumns,
  type DataTableColumn,
} from '@pulse/ui/components/data-table';
import { EmptyState } from '@pulse/ui/components/empty-state';
import { IconTile } from '@pulse/ui/components/icon-tile';
import { InspectorLayout, InspectorPanel } from '@pulse/ui/components/inspector-panel';
import { SegmentedControl } from '@pulse/ui/components/segmented-control';

/** Sample timesheet entries (hours are plain numbers, not money). */
type Entry = {
  id: string;
  day: string;
  date: string;
  timeIn: string;
  timeOut: string;
  activity: string;
  client: string;
  hours: number;
  offset: number;
};

const ENTRIES: Entry[] = [
  {
    id: 'e1',
    day: 'Fri',
    date: 'Sep 11',
    timeIn: '8:02 AM',
    timeOut: '5:10 PM',
    activity: 'Precision AC install, server room',
    client: 'Sample Client A',
    hours: 8.1,
    offset: 0,
  },
  {
    id: 'e2',
    day: 'Mon',
    date: 'Sep 14',
    timeIn: '7:55 AM',
    timeOut: '7:30 PM',
    activity: 'Chiller commissioning',
    client: 'Sample Client B',
    hours: 10.6,
    offset: 2.5,
  },
  {
    id: 'e3',
    day: 'Wed',
    date: 'Sep 16',
    timeIn: '8:10 AM',
    timeOut: '5:05 PM',
    activity: 'BOQ for data center refresh',
    client: 'Sample Client C',
    hours: 7.9,
    offset: 0,
  },
  {
    id: 'e4',
    day: 'Thu',
    date: 'Sep 17',
    timeIn: '8:00 AM',
    timeOut: '6:00 PM',
    activity: 'CRAC unit inspection',
    client: 'Sample Client C',
    hours: 9.0,
    offset: 1,
  },
  {
    id: 'e5',
    day: 'Fri',
    date: 'Sep 18',
    timeIn: '8:00 AM',
    timeOut: '5:00 PM',
    activity: 'UPS room airflow check',
    client: 'Sample Client A',
    hours: 8.0,
    offset: 0,
  },
  {
    id: 'e6',
    day: 'Mon',
    date: 'Sep 21',
    timeIn: '7:48 AM',
    timeOut: '5:00 PM',
    activity: 'Preventive maintenance, Building 2',
    client: 'Sample Client B',
    hours: 8.2,
    offset: 0,
  },
];

const EMPTY: Entry[] = [];

const NO_BREAK_SPACE = String.fromCharCode(0xa0);

const hours = (value: number) => `${value.toFixed(1)} h`;

const column = createDataTableColumns<Entry>();

const COLUMNS: DataTableColumn<Entry>[] = column.columns([
  column.accessor('date', {
    header: 'Date',
    cell: (info) => (
      <span className="font-semibold whitespace-nowrap">
        {info.row.original.day} {info.getValue()}
      </span>
    ),
    meta: { width: '8rem' },
  }),
  column.accessor('timeIn', {
    header: 'Time in',
    enableSorting: false,
    meta: { numeric: true, width: '7rem' },
  }),
  column.accessor('timeOut', {
    header: 'Time out',
    enableSorting: false,
    meta: { numeric: true, width: '7rem' },
  }),
  column.accessor('activity', {
    header: 'Activity and client',
    cell: (info) => (
      <span className="flex min-w-48 flex-col">
        <span>{info.getValue()}</span>
        <span className="text-footnote text-text-secondary">{info.row.original.client}</span>
      </span>
    ),
  }),
  column.accessor('hours', {
    header: 'Worked',
    cell: (info) => hours(info.getValue()),
    meta: { align: 'end', width: '6rem' },
  }),
  column.accessor('offset', {
    header: 'Offset',
    cell: (info) =>
      info.getValue() > 0 ? (
        <span className="font-bold">{hours(info.getValue())}</span>
      ) : (
        <span className="text-text-tertiary">—</span>
      ),
    meta: { align: 'end', width: '6rem' },
  }),
]);

export function DataTableDemo() {
  const [mode, setMode] = useState<'data' | 'loading' | 'empty'>('data');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The row that opened the inspector, where focus returns on close.
  const rowRef = useRef<HTMLElement | null>(null);
  const selected = ENTRIES.find((entry) => entry.id === selectedId) ?? null;

  return (
    <div className="flex flex-col gap-4">
      <SegmentedControl
        label="Table state"
        track="page"
        value={mode}
        onValueChange={setMode}
        options={[
          { value: 'data', label: 'Rows' },
          { value: 'loading', label: 'Loading' },
          { value: 'empty', label: 'Empty' },
        ]}
      />
      <InspectorLayout>
        <div className="min-w-0 flex-1">
          <DataTable
            caption="Daily entries, Sep 11 – 25"
            columns={COLUMNS}
            data={mode === 'empty' ? EMPTY : ENTRIES}
            getRowId={(entry) => entry.id}
            loading={mode === 'loading'}
            selectedRowId={selectedId}
            rowActionLabel={(entry) => `Details for ${entry.day} ${entry.date}`}
            onRowSelect={(entry, element) => {
              rowRef.current = element;
              setSelectedId(entry.id);
            }}
            empty={
              <EmptyState
                icon={<CalendarX2 strokeWidth={1.75} />}
                title="No entries this cut-off"
                description="Time in from the Timesheet page to start your first entry."
                action={<Button variant="tinted">Time in</Button>}
                className="shadow-none"
              />
            }
            renderPhoneRow={(entry) => (
              <>
                <IconTile className="size-11 flex-col rounded-xl leading-none">
                  <span className="text-caption font-semibold">{entry.day}</span>
                  <span className="text-headline font-bold numeric">
                    {entry.date.split(' ')[1]}
                  </span>
                </IconTile>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-subheadline font-semibold numeric">
                    {entry.timeIn} – {entry.timeOut}
                  </span>
                  <span className="truncate text-footnote text-text-secondary">
                    {entry.activity}
                  </span>
                </span>
                <span className="shrink-0 text-right text-subheadline font-bold numeric">
                  {hours(entry.hours)}
                </span>
              </>
            )}
          />
        </div>
        <InspectorPanel
          open={selected !== null}
          onOpenChange={(open) => {
            if (!open) setSelectedId(null);
          }}
          eyebrow="Selected day"
          title={selected ? `${selected.day} ${selected.date}` : ''}
          returnFocus={rowRef}
          actions={
            <Button
              variant="tinted"
              size="icon"
              className="rounded-full"
              aria-label={selected ? `Edit entry for ${selected.day} ${selected.date}` : 'Edit'}
            >
              <Pencil aria-hidden="true" />
            </Button>
          }
        >
          {selected ? (
            <dl className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface text-subheadline numeric">
              {[
                ['Time in', selected.timeIn],
                ['Time out', selected.timeOut],
                ['Worked', hours(selected.hours)],
                ['Offset', selected.offset > 0 ? hours(selected.offset) : 'None'],
                ['Client', selected.client],
                ['Activity', selected.activity],
              ].map(([term, value]) => (
                <div
                  key={term}
                  className="flex min-h-11 items-center justify-between gap-3 px-3.5 py-2"
                >
                  <dt className="text-text-secondary">{term}</dt>
                  <dd className="text-right font-semibold">{value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </InspectorPanel>
      </InspectorLayout>
    </div>
  );
}

const DAYS = ENTRIES.map((entry) => ({
  day: `${entry.day} ${entry.date.split(' ')[1]}`,
  worked: entry.hours - entry.offset,
  offset: entry.offset,
}));

const TREND = [
  { cutoff: 'Jul A', hours: 81 },
  { cutoff: 'Jul B', hours: 86 },
  { cutoff: 'Aug A', hours: 79 },
  { cutoff: 'Aug B', hours: 88 },
  { cutoff: 'Sep A', hours: 84 },
  { cutoff: 'Sep B', hours: 52 },
];

export function ChartDemo() {
  return (
    <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
      <section
        aria-labelledby="chart-hours"
        className="flex min-w-0 flex-col gap-2 rounded-card bg-surface p-4 shadow-card"
      >
        <h3 id="chart-hours" className="text-headline">
          Hours per day
        </h3>
        <Chart
          height={11.25}
          label="Hours worked per day, Sep 11 to 21. Offset: 2.5 hours on Mon Sep 14 and 1 hour on Thu Sep 17."
          dataTable={{
            caption: 'Hours per day',
            columns: ['Day', 'Scheduled work', 'Offset'],
            rows: DAYS.map((day) => [day.day, hours(day.worked), hours(day.offset)]),
          }}
        >
          <BarChart data={DAYS} margin={{ top: 20, right: 0, bottom: 0, left: 0 }}>
            <XAxis dataKey="day" {...CHART_AXIS_PROPS} />
            <Tooltip
              cursor={{ fill: 'var(--bg-grouped)' }}
              content={(props) => <ChartTooltip {...props} formatValue={(v) => hours(Number(v))} />}
            />
            <Bar dataKey="worked" name="Scheduled work" stackId="day" fill={CHART_COLORS.context} />
            <Bar
              dataKey="offset"
              name="Offset"
              stackId="day"
              fill={CHART_COLORS.main}
              radius={[4, 4, 0, 0]}
            >
              <LabelList
                dataKey="offset"
                position="top"
                fill={CHART_COLORS.value}
                fontSize="var(--text-caption)"
                fontWeight={600}
                // A no-break space keeps "+2.5 h" on one line above narrow bars.
                formatter={(value) =>
                  Number(value) > 0 ? `+${Number(value)}${NO_BREAK_SPACE}h` : ''
                }
              />
            </Bar>
          </BarChart>
        </Chart>
      </section>
      <section
        aria-labelledby="chart-trend"
        className="flex min-w-0 flex-col gap-2 rounded-card bg-surface p-4 shadow-card"
      >
        <div className="flex items-baseline justify-between gap-2">
          <h3 id="chart-trend" className="text-headline">
            Hours per cut-off
          </h3>
          <span className="text-title-3 numeric">52 h</span>
        </div>
        <Chart
          height={7.5}
          label="Hours per cut-off, July to September: 81, 86, 79, 88, 84, and 52 so far this cut-off."
        >
          <LineChart data={TREND} margin={{ top: 8, right: 20, bottom: 0, left: 20 }}>
            <XAxis dataKey="cutoff" interval={0} {...CHART_AXIS_PROPS} />
            <Line
              dataKey="hours"
              stroke={CHART_COLORS.main}
              strokeWidth={2}
              dot={{ r: 3, fill: CHART_COLORS.main }}
              isAnimationActive={false}
            />
          </LineChart>
        </Chart>
      </section>
    </div>
  );
}
