import { Avatar, type AvatarSize } from '@pulse/ui/components/avatar';

/**
 * The shared Avatar (decision 151) for a directory result, which carries the initials the service
 * built (`initialsOf`) rather than the name parts. Hidden from assistive technology, like Avatar,
 * because the name always shows beside it. From step 2.2 the profile photo (`photoUrl`) fills it,
 * falling back to the initials.
 */
export function PersonAvatar({
  initials,
  photoUrl,
  size = 'md',
  className,
}: {
  initials: string;
  photoUrl?: string | null;
  size?: AvatarSize;
  className?: string;
}) {
  const [first = '', ...rest] = Array.from(initials);
  return (
    <Avatar
      firstName={first}
      lastName={rest.join('')}
      photoUrl={photoUrl}
      size={size}
      className={className}
    />
  );
}
