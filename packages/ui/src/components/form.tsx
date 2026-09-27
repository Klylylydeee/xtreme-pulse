'use client';

import { createContext, useContext, useId, type ComponentProps, type ReactNode } from 'react';
import { ChevronDown, CircleAlert } from 'lucide-react';
import { Switch as SwitchPrimitive } from 'radix-ui';
import { cn } from '../lib/utils';

/*
 * Inset grouped forms (DESIGN_SYSTEM.md › Layout & components): related fields on a rounded card,
 * with a short section header and optional footer help, like iOS Settings. Errors show inline,
 * next to the field (Feedback & motion). Step 0.6's Server Action pattern returns field errors for
 * the `error` prop.
 */

type FieldContextValue = {
  controlId: string;
  describedBy: string | undefined;
  invalid: boolean;
  required: boolean;
};

const FieldContext = createContext<FieldContextValue | null>(null);

/** Wires a control to its FormField: id, aria-describedby, aria-invalid and required. */
function useFieldProps<T extends { id?: string; 'aria-describedby'?: string }>(props: T) {
  const field = useContext(FieldContext);
  if (!field) return props;
  const describedBy = [field.describedBy, props['aria-describedby']].filter(Boolean).join(' ');
  return {
    ...props,
    id: props.id ?? field.controlId,
    'aria-describedby': describedBy || undefined,
    'aria-invalid': field.invalid || undefined,
    'aria-required': field.required || undefined,
  };
}

/** A group of related fields on an inset rounded card, with a header and optional footer help. */
export function FormSection({
  title,
  footer,
  className,
  children,
}: {
  title?: ReactNode;
  footer?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <section
      data-slot="form-section"
      aria-labelledby={title ? titleId : undefined}
      className={cn('flex flex-col gap-2', className)}
    >
      {title ? (
        <h3 id={titleId} className="px-4 text-footnote font-semibold text-text-secondary">
          {title}
        </h3>
      ) : null}
      <div className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
        {children}
      </div>
      {footer ? <p className="px-4 text-footnote text-text-secondary">{footer}</p> : null}
    </section>
  );
}

/**
 * One field row in a FormSection: the label, the control (the child), optional hint, and the inline
 * error. `inline` puts the label beside the control, for switches and short values.
 */
export function FormField({
  label,
  hint,
  error,
  required = false,
  layout = 'stacked',
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  /** The validation message, shown next to the field. */
  error?: string;
  required?: boolean;
  layout?: 'stacked' | 'inline';
  className?: string;
  children: ReactNode;
}) {
  const controlId = useId();
  const hintId = `${controlId}-hint`;
  const errorId = `${controlId}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');

  const labelElement = (
    <label htmlFor={controlId} className="text-subheadline font-medium text-text-primary">
      {label}
      {required ? (
        // The control announces "required" (aria-required); the asterisk is visual only.
        <span aria-hidden="true" className="text-text-secondary">
          {' *'}
        </span>
      ) : null}
    </label>
  );

  return (
    <FieldContext.Provider
      value={{ controlId, describedBy: describedBy || undefined, invalid: !!error, required }}
    >
      <div
        data-slot="form-field"
        data-invalid={error ? true : undefined}
        className={cn('flex flex-col gap-1.5 px-4 py-3', className)}
      >
        {layout === 'inline' ? (
          <div className="flex min-h-11 items-center justify-between gap-4">
            {labelElement}
            {children}
          </div>
        ) : (
          <>
            {labelElement}
            {children}
          </>
        )}
        {hint ? (
          <p id={hintId} className="text-footnote text-text-secondary">
            {hint}
          </p>
        ) : null}
        {/* Always present, so a new error is announced as it appears. */}
        <div aria-live="polite">
          {error ? (
            <p
              id={errorId}
              className="flex items-start gap-1.5 text-footnote font-medium text-destructive-text"
            >
              <CircleAlert aria-hidden="true" className="mt-px size-4 shrink-0" />
              <span>{error}</span>
            </p>
          ) : null}
        </div>
      </div>
    </FieldContext.Provider>
  );
}

const CONTROL = cn(
  'w-full min-w-0 rounded-lg border border-separator bg-surface px-3 text-body text-text-primary md:text-subheadline',
  'transition-colors duration-fast placeholder:text-text-tertiary',
  'hover:border-text-tertiary focus-visible:border-accent',
  'disabled:cursor-not-allowed disabled:bg-bg-grouped disabled:text-text-secondary',
  'aria-invalid:border-destructive-text',
);

/** A text input, 44px tall. Inside a FormField it is labeled and wired to its hint and error. */
export function Input({ className, type = 'text', ...props }: ComponentProps<'input'>) {
  return (
    <input
      data-slot="input"
      type={type}
      className={cn(CONTROL, 'h-11', className)}
      {...useFieldProps(props)}
    />
  );
}

/** A multi-line text input. */
export function Textarea({ className, rows = 3, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      rows={rows}
      className={cn(CONTROL, 'min-h-22 resize-y py-2.5', className)}
      {...useFieldProps(props)}
    />
  );
}

/** A native select, styled as a field; the platform's own picker opens on phones. */
export function Select({ className, children, ...props }: ComponentProps<'select'>) {
  return (
    <div className={cn('relative', className)}>
      <select
        data-slot="select"
        className={cn(CONTROL, 'h-11 cursor-pointer appearance-none pr-10')}
        {...useFieldProps(props)}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-3 size-4.5 -translate-y-1/2 text-text-secondary"
      />
    </div>
  );
}

/**
 * An on/off switch. Use it in an `inline` FormField. The hit area is 44px tall around the track.
 */
export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'relative inline-flex h-8 w-13 shrink-0 cursor-pointer items-center rounded-full p-0.5',
        'bg-text-tertiary transition-colors duration-fast data-[state=checked]:bg-accent',
        'disabled:cursor-not-allowed disabled:opacity-50',
        "after:absolute after:-inset-1.5 after:content-['']",
        className,
      )}
      {...useFieldProps(props)}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          'block size-7 rounded-full bg-surface shadow-card transition-transform duration-fast ease-out',
          'data-[state=checked]:translate-x-5',
        )}
      />
    </SwitchPrimitive.Root>
  );
}
