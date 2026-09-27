import type { ComponentProps } from 'react';
import { cn } from '../lib/utils';

/**
 * A tinted icon tile: an accent-subtle rounded square holding an accent icon
 * (DESIGN_SYSTEM.md › Bolder identity). Size comes from `className`; the icon is the child.
 */
export function IconTile({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      data-slot="icon-tile"
      aria-hidden="true"
      className={cn(
        'flex shrink-0 items-center justify-center rounded-lg bg-accent-subtle text-accent',
        className,
      )}
      {...props}
    />
  );
}
