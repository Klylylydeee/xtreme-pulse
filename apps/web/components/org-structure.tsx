'use client';

import { useId, useRef, useState, useTransition, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { ActionResult, FieldErrors } from '@pulse/core';
import { cn } from '@pulse/ui';
import { Switch } from '@pulse/ui/components/form';

// Spec: docs/modules/core.md#managing-departments-and-positions — the pieces the departments and
// positions pages share: the "Show retired" switch, the small badges, the read-only rows in a
// sheet, and submitting a sheet's form to its Server Action.

/** Submits a form or a change to a Server Action, keeping its field and form errors. */
export function useActionSubmit<TData>(
  action: (
    previous: null,
    input: FormData | Record<string, unknown>,
  ) => Promise<ActionResult<TData>>,
  onSuccess: (data: TData) => void,
) {
  const [failure, setFailure] = useState<Extract<ActionResult<TData>, { ok: false }> | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);

  async function run(input: FormData | Record<string, unknown>): Promise<boolean> {
    if (busy.current) return false;
    busy.current = true;
    setPending(true);
    try {
      const result = await action(null, input);
      if (result.ok) {
        setFailure(null);
        onSuccess(result.data);
        return true;
      }
      setFailure(result);
      return false;
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  /** For a form's `onSubmit`: sends its fields, then moves focus to the first field in error. */
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const ok = await run(new FormData(form));
    if (!ok) {
      requestAnimationFrame(() => {
        form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
      });
    }
  }

  const fieldErrors: FieldErrors = failure?.fieldErrors ?? {};
  return {
    run,
    onSubmit,
    pending,
    formError: failure?.formError ?? null,
    fieldErrors,
    reset: () => setFailure(null),
  };
}

/**
 * The "Show retired" switch. Retired records come from the server, so turning it on or off loads
 * the page again with or without `?retired=1`, keeping the other parameters.
 */
export function ShowRetiredSwitch({
  checked,
  className,
}: {
  checked: boolean;
  className?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const id = useId();

  function change(next: boolean) {
    const params = new URLSearchParams(window.location.search);
    if (next) params.set('retired', '1');
    else params.delete('retired');
    const query = params.toString();
    startTransition(() => {
      router.replace(`${window.location.pathname}${query ? `?${query}` : ''}`, { scroll: false });
    });
  }

  return (
    <div className={cn('flex min-h-11 items-center gap-3', className)} aria-busy={pending}>
      <label htmlFor={id} className="text-subheadline font-medium text-text-primary">
        Show retired
      </label>
      <Switch id={id} checked={checked} onCheckedChange={change} disabled={pending} />
    </div>
  );
}

const BADGE_TONES = {
  /** A neutral label, such as "Retired" or "Standard". */
  neutral: 'bg-bg-grouped text-text-secondary',
  /** An accent label, such as "Overtime". */
  accent: 'bg-accent-subtle text-accent',
} as const;

/** A small text badge. Color is never the only signal: the text names the state. */
export function Badge({
  tone = 'neutral',
  className,
  children,
}: {
  tone?: keyof typeof BADGE_TONES;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-2 py-0.5 text-footnote font-medium whitespace-nowrap',
        BADGE_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * A read-only value in a sheet's form section, such as a department's code when editing. Shown as
 * plain text under its label, not in a filled box, so it doesn't read as a disabled input.
 */
export function ReadOnlyField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 px-4 py-3">
      <span className="text-subheadline font-medium text-text-primary">{label}</span>
      <span className="text-body text-text-primary md:text-subheadline">{children}</span>
      {hint ? <p className="text-footnote text-text-secondary">{hint}</p> : null}
    </div>
  );
}

/** A count for a table cell or phone row, e.g. "3 positions". */
export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}
