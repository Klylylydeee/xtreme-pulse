'use client';

import { Button } from '@pulse/ui/components/button';
import { ErrorState } from '@pulse/ui/components/error-state';

/**
 * The error state for every signed-in page. It never shows the error message itself, which could
 * hold sensitive details (SECURITY.md#secrets); the digest lets an administrator find the log entry.
 */
export default function PulseError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <ErrorState
      title="This page couldn’t load"
      description={
        <>
          Try again. If it keeps happening, tell your System Administrator
          {error.digest ? (
            <>
              {' '}
              and give them this code: <span className="numeric">{error.digest}</span>
            </>
          ) : null}
          .
        </>
      }
      action={<Button onClick={() => retry()}>Try again</Button>}
    />
  );
}
