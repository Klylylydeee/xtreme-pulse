import type { ComponentProps, MouseEvent } from 'react';
import { LoaderCircle } from 'lucide-react';
import { Slot } from 'radix-ui';
import { cn } from '../lib/utils';

const VARIANTS = {
  /** The one primary action on a screen. */
  primary: 'bg-accent text-accent-text shadow-accent hover:bg-accent-hover',
  /** A neutral secondary action, such as Cancel, on a surface with a hairline border. */
  secondary: 'border border-separator bg-surface text-text-primary hover:bg-accent-subtle',
  /** A tinted secondary action. */
  tinted: 'bg-accent-subtle text-accent hover:bg-accent-subtle/70',
  /** A borderless action, like a toolbar button. */
  plain: 'bg-transparent text-text-secondary hover:bg-accent-subtle hover:text-accent',
  /**
   * A destructive action ("Delete draft"). The fill is `destructive-text`, not the dot red, so the
   * text on it meets AA (DESIGN_SYSTEM.md › Color: text on a semantic fill).
   */
  destructive: 'bg-destructive-text text-on-semantic-text hover:bg-destructive-text/90',
} as const;

const SIZES = {
  /** 44px tall, the minimum touch target. */
  default: 'h-11 gap-2 px-4 text-subheadline font-semibold',
  /** A 44×44px icon-only button. It needs an aria-label. */
  icon: 'size-11 [&_svg]:size-5',
} as const;

export type ButtonVariant = keyof typeof VARIANTS;
export type ButtonSize = keyof typeof SIZES;

/** Class names for a button, for links and other elements styled as one. */
export function buttonVariants({
  variant = 'primary',
  size = 'default',
  className,
}: { variant?: ButtonVariant; size?: ButtonSize; className?: string } = {}): string {
  return cn(
    'inline-flex shrink-0 cursor-pointer items-center justify-center rounded-lg whitespace-nowrap',
    'transition-colors duration-fast disabled:pointer-events-none disabled:opacity-50',
    'aria-disabled:pointer-events-none aria-disabled:opacity-50',
    '[&_svg]:shrink-0',
    VARIANTS[variant],
    SIZES[size],
    className,
  );
}

/** While loading, a click does nothing; this also stops a form submitting again (implicit
 * submission clicks the submit button). */
function ignoreClick(event: MouseEvent<HTMLButtonElement>) {
  event.preventDefault();
}

/**
 * A button on the design tokens. `asChild` styles a child element, such as a link.
 * `loading` shows a spinner and marks the button busy and disabled while keeping it focusable, so
 * keyboard focus stays put; clicks do nothing. The label stays, so the action is still named.
 */
export function Button({
  variant,
  size,
  asChild = false,
  loading = false,
  className,
  type = 'button',
  disabled,
  onClick,
  children,
  ...props
}: ComponentProps<'button'> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  asChild?: boolean;
  loading?: boolean;
}) {
  if (asChild) {
    return (
      <Slot.Root
        data-slot="button"
        className={buttonVariants({ variant, size, className })}
        aria-disabled={disabled || undefined}
        onClick={onClick}
        {...props}
      >
        {children}
      </Slot.Root>
    );
  }
  return (
    <button
      data-slot="button"
      type={type}
      disabled={disabled}
      className={buttonVariants({ variant, size, className })}
      {...props}
      // While loading the button stays focusable (so focus isn't lost to the page) but inert.
      aria-disabled={loading || props['aria-disabled'] || undefined}
      aria-busy={loading || undefined}
      // No wrapper unless loading, so server components can render the button.
      onClick={loading ? ignoreClick : onClick}
    >
      {loading ? <LoaderCircle aria-hidden="true" className="size-4.5 animate-spin" /> : null}
      {children}
    </button>
  );
}
