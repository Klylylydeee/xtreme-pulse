import type { ComponentProps } from 'react';
import { cn } from '../lib/utils';

/** A loading placeholder block. Size and shape come from `className`. */
export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn('animate-pulse rounded-control bg-bg-grouped', className)}
      {...props}
    />
  );
}
