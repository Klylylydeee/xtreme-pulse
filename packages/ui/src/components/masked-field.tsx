'use client';

import { useId, useState } from 'react';
import { CircleAlert, Eye, EyeOff } from 'lucide-react';
import { cn } from '../lib/utils';
import { Button } from './button';

/*
 * Masked field (DESIGN_SYSTEM.md › Shared components, SECURITY.md#sensitive-data): a sensitive
 * value shown as its last 4 characters until the user reveals it. The page renders it with only
 * those characters; the full value is fetched from the server when Reveal is pressed, never before,
 * and forgotten again on Hide, so every reveal goes back to the server (where it is access-checked
 * and audit-logged).
 */

/** What `reveal` returns. The shape of a Server Action's `ActionResult<string>`. */
export type MaskedFieldRevealResult =
  { ok: true; data: string } | { ok: false; formError: string | null };

const MASK = '••••';
const REVEAL_FAILED = 'This value couldn’t be revealed. Try again.';

export function MaskedField({
  label,
  lastFour,
  reveal,
  className,
}: {
  /** The field's name, for example "Bank account number". */
  label: string;
  /** The last 4 characters, from the server. Empty for a value too short to show any. */
  lastFour: string;
  /** Fetches the full value, usually a Server Action bound to the record. */
  reveal: () => Promise<MaskedFieldRevealResult>;
  className?: string;
}) {
  const errorId = useId();
  const [value, setValue] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    if (value !== null) {
      setValue(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await reveal();
      if (result.ok) setValue(result.data);
      else setError(result.formError ?? REVEAL_FAILED);
    } catch {
      setError(REVEAL_FAILED);
    } finally {
      setLoading(false);
    }
  }

  const revealed = value !== null;
  return (
    <div data-slot="masked-field" className={cn('flex flex-col gap-1 px-4 py-2', className)}>
      {/* A term and its value, so assistive technology reads the label with the value. */}
      <dl className="flex min-h-11 flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <dt className="text-subheadline font-medium text-text-primary">{label}</dt>
        <dd className="ml-auto flex min-w-0 items-center gap-1">
          <span
            aria-live="polite"
            className="min-w-0 text-right text-body text-text-secondary numeric wrap-anywhere"
          >
            {revealed ? (
              <span className="text-text-primary">{value}</span>
            ) : (
              <>
                <span aria-hidden="true" className="tracking-wider">
                  {lastFour ? `${MASK} ${lastFour}` : MASK}
                </span>
                <span className="sr-only">
                  {lastFour ? `Hidden, ends in ${lastFour.split('').join(' ')}` : 'Hidden'}
                </span>
              </>
            )}
          </span>
          <Button
            variant="plain"
            size="icon"
            loading={loading}
            onClick={toggle}
            aria-label={`${revealed ? 'Hide' : 'Reveal'} ${label}`}
            aria-describedby={error ? errorId : undefined}
          >
            {loading ? null : revealed ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
          </Button>
        </dd>
      </dl>
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
  );
}
