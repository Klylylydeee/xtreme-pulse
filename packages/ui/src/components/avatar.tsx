'use client';

import { useState, type ReactNode } from 'react';
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
 * A person's avatar (DESIGN_SYSTEM.md › Shared components). From build step 2.2 the profile photo
 * (`photoUrl`) fills the circle, lazily loaded with an empty `alt` and cropped to cover. Without a
 * photo, or when it fails to load, the initials show in an `accent-subtle` circle with `accent`
 * text; `fallback` shows when there are no initials either (such as the system account's icon).
 * Hidden from assistive technology, because the name always shows beside it.
 */
export function Avatar({
  firstName,
  lastName,
  photoUrl,
  fallback,
  size = 'md',
  className,
}: {
  firstName?: string | null;
  lastName?: string | null;
  /** The profile photo's URL (the file route), or null for the initials. */
  photoUrl?: string | null;
  /** Shown when the name gives no initials and there is no photo. */
  fallback?: ReactNode;
  size?: AvatarSize;
  className?: string;
}) {
  const initials = avatarInitials(firstName, lastName);
  // Remember which URL failed, so a new photo URL is tried again.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showPhoto = Boolean(photoUrl) && failedUrl !== photoUrl;
  return (
    <span
      data-slot="avatar"
      data-size={size}
      aria-hidden="true"
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent-subtle font-semibold text-accent select-none',
        SIZES[size],
        className,
      )}
    >
      {showPhoto && photoUrl ? (
        // A plain <img>: the photo opens through the authenticated file route, not next/image.
        <img
          src={photoUrl}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailedUrl(photoUrl)}
          className="size-full object-cover"
        />
      ) : (
        initials || fallback
      )}
    </span>
  );
}
