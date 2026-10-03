import { connection } from 'next/server';
import {
  devEncryptionSampleForDisplay,
  EncryptionKeyInvalidError,
  EncryptionNotConfiguredError,
} from '@pulse/core/server';
import { DatabaseNotConfiguredError, redactConnectionString } from '@pulse/db';
import { ErrorState } from '@pulse/ui/components/error-state';
import { FormSection } from '@pulse/ui/components/form';
import { MaskedField } from '@pulse/ui/components/masked-field';
import { revealSensitiveAction } from '@/lib/actions/sensitive';

function problem(error: unknown): { title: string; description: string } {
  if (error instanceof EncryptionNotConfiguredError || error instanceof EncryptionKeyInvalidError) {
    return { title: 'Field encryption not set up', description: error.message };
  }
  if (error instanceof DatabaseNotConfiguredError) {
    return { title: 'Database not configured', description: error.message };
  }
  const message = error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown error';
  return {
    title: 'The sample couldn’t load',
    description: `Check /dev/health. ${redactConnectionString(message)}`,
  };
}

/**
 * The masked field on the development sample: a made-up bank account number stored encrypted. The
 * page gets only its last 4 characters; Reveal fetches the full value through the same reveal Server
 * Action as every sensitive field, which needs a signed-in System Administrator, HR or Accounting
 * user and writes an audit entry first (SECURITY.md#sensitive-data).
 */
export async function MaskedFieldDemo() {
  // Read the database on every request, never at build time.
  await connection();
  let sample: Awaited<ReturnType<typeof devEncryptionSampleForDisplay>>;
  try {
    sample = await devEncryptionSampleForDisplay();
  } catch (error) {
    return <ErrorState {...problem(error)} />;
  }
  return (
    <FormSection
      title="Bank details"
      footer="A made-up value, stored encrypted. Sign in as the System Administrator, HR or Accounting to reveal it. Each reveal is audit-logged."
    >
      <MaskedField
        label="Bank account number"
        lastFour={sample.lastFour}
        reveal={revealSensitiveAction.bind(null, null, {
          ownerType: sample.ownerType,
          ownerId: sample.ownerId,
          field: sample.field,
        })}
      />
    </FormSection>
  );
}
