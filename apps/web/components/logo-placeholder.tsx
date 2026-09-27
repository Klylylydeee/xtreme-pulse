import { cn } from '@pulse/ui';

/**
 * Stands in for the company logo until company settings hold one
 * (docs/modules/core.md#company-details-pending-from-the-client).
 */
export function LogoPlaceholder({ className }: { className?: string }) {
  return (
    <span
      role="img"
      aria-label="Company logo placeholder"
      className={cn(
        'flex size-8 shrink-0 items-center justify-center rounded-lg border border-dashed border-text-secondary text-caption tracking-tight text-text-secondary',
        className,
      )}
    >
      Logo
    </span>
  );
}
