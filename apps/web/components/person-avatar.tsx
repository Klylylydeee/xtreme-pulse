import { Avatar, type AvatarSize } from '@pulse/ui/components/avatar';

/**
 * The shared Avatar (decision 151) for a directory result, which carries the initials the service
 * built (`initialsOf`) rather than the name parts. Hidden from assistive technology, like Avatar,
 * because the name always shows beside it. Photos fill it from Phase 2.
 */
export function PersonAvatar({
  initials,
  size = 'md',
  className,
}: {
  initials: string;
  size?: AvatarSize;
  className?: string;
}) {
  const [first = '', ...rest] = Array.from(initials);
  return <Avatar firstName={first} lastName={rest.join('')} size={size} className={className} />;
}
