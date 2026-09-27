import { connection } from 'next/server';
import {
  devEncryptionSampleLastFour,
  EncryptionKeyInvalidError,
  EncryptionNotConfiguredError,
} from '@pulse/core/server';
import { DatabaseNotConfiguredError, redactConnectionString } from '@pulse/db';
import { ErrorState } from '@pulse/ui/components/error-state';
import { FormSection } from '@pulse/ui/components/form';
import { MaskedField } from '@pulse/ui/components/masked-field';
import { revealSampleValue } from './actions';

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
 * page gets only its last 4 characters; Reveal fetches the full value through a Server Action.
 */
export async function MaskedFieldDemo() {
  // Read the database on every request, never at build time.
  await connection();
  let lastFour: string;
  try {
    lastFour = await devEncryptionSampleLastFour();
  } catch (error) {
    return <ErrorState {...problem(error)} />;
  }
  return (
    <FormSection
      title="Bank details"
      footer="A made-up value, stored encrypted. Revealing it will be audit-logged once the audit log exists."
    >
      <MaskedField
        label="Bank account number"
        lastFour={lastFour}
        reveal={revealSampleValue.bind(null, null, {})}
      />
    </FormSection>
  );
}
