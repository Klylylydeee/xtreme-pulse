'use client';

import type { ReactNode } from 'react';
import { ToggleGroup } from 'radix-ui';
import { cn } from '../lib/utils';

export type SegmentedOption<TValue extends string> = {
  value: TValue;
  label: ReactNode;
  /** The accessible name when `label` isn't plain text (e.g. an icon or a count badge). */
  ariaLabel?: string;
  disabled?: boolean;
};

const TRACKS = {
  /** On a surface, such as a card or sheet. */
  surface: 'bg-bg-grouped',
  /** On the page or grouped background, where bg-grouped wouldn't show. */
  page: 'bg-separator',
} as const;

const TONES = {
  /** Switching views: the selected segment's text stays text-primary. */
  neutral: 'data-[state=on]:text-text-primary',
  /** Pickers such as None / Read / Write / Owner: the selected segment's text is the accent. */
  accent: 'data-[state=on]:text-accent',
} as const;

/**
 * A segmented control (DESIGN_SYSTEM.md › Layout & components): switches between views, or picks one
 * of a few values such as None / Read / Write / Owner. Exactly one segment is always selected.
 * Tab moves into the control, the arrow keys move between segments, Space or Enter selects.
 * Every segment is at least 44px tall.
 */
export function SegmentedControl<TValue extends string>({
  label,
  options,
  value,
  onValueChange,
  track = 'surface',
  tone = 'neutral',
  fullWidth = false,
  disabled = false,
  className,
}: {
  /** The accessible name of the group, e.g. "Timesheet view" or "Engage access". */
  label: string;
  options: readonly SegmentedOption<TValue>[];
  value: TValue;
  onValueChange: (value: TValue) => void;
  track?: keyof typeof TRACKS;
  tone?: keyof typeof TONES;
  /** Segments share the full width (phones and narrow sheets). */
  fullWidth?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <ToggleGroup.Root
      type="single"
      aria-label={label}
      value={value}
      // Radix lets a single toggle group be cleared; a segmented control always keeps one segment.
      onValueChange={(next) => {
        if (next) onValueChange(next as TValue);
      }}
      disabled={disabled}
      loop
      data-slot="segmented-control"
      className={cn(
        'inline-flex max-w-full gap-0.5 rounded-lg p-0.5',
        TRACKS[track],
        fullWidth ? 'flex w-full' : 'w-fit',
        disabled && 'opacity-50',
        className,
      )}
    >
      {options.map((option) => (
        <ToggleGroup.Item
          key={option.value}
          value={option.value}
          disabled={option.disabled}
          aria-label={option.ariaLabel}
          className={cn(
            'inline-flex h-11 min-w-12 cursor-pointer items-center justify-center gap-2 rounded-md px-3 whitespace-nowrap',
            'text-subheadline font-medium text-text-secondary transition-[background-color,color,box-shadow] duration-fast',
            'hover:text-text-primary',
            'data-[state=on]:bg-surface data-[state=on]:font-semibold data-[state=on]:shadow-card',
            'disabled:cursor-default disabled:opacity-50 disabled:hover:text-text-secondary',
            'focus-visible:outline-offset-0',
            TONES[tone],
            fullWidth && 'min-w-0 flex-1',
          )}
        >
          {option.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
