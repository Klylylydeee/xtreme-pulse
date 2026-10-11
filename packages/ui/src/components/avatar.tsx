import type { ReactNode } from 'react';
import { cn } from '../lib/utils';

const SIZES = {
  sm: 'size-8 text-caption',
  md: 'size-11 text-subheadline',
  lg: 'size-12 text-callout',
} as const;

export type AvatarSize = keyof typeof SIZES;

/** The initials: the first letter of the first name and of the last name, upper-cased. */
export function avatarInitials(firstName?: string | null, lastName?: string | null): string {
  return [firstName, lastName]
    .map((part) => part?.trim().charAt(0) ?? '')
    .join('')
    .toUpperCase();
}

/**
 * A person's avatar (DESIGN_SYSTEM.md › Shared components): the initials in an `accent-subtle`
 * circle with `accent` text. Hidden from assistive technology, because the name always shows
 * beside it. `fallback` shows when there are no initials (such as the system account's icon).
 *
 * `photoUrl` is the profile photo's slot. It is unused until Pulse Talent adds photos (Phase 2).
 */
export function Avatar({
  firstName,
  lastName,
  fallback,
  size = 'md',
  className,
}: {
  firstName?: string | null;
  lastName?: string | null;
  /** Reserved for profile photos (Phase 2); ignored for now. */
  photoUrl?: string | null;
  /** Shown when the name gives no initials. */
  fallback?: ReactNode;
  size?: AvatarSize;
  className?: string;
}) {
  const initials = avatarInitials(firstName, lastName);
  return (
    <span
      data-slot="avatar"
      data-size={size}
      aria-hidden="true"
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full bg-accent-subtle font-semibold text-accent select-none',
        SIZES[size],
        className,
      )}
    >
      {initials || fallback}
    </span>
  );
}
