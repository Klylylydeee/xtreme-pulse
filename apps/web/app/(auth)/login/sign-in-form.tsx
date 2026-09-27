'use client';

import { useActionState, useState } from 'react';
import { fieldError } from '@pulse/core';
import { Button } from '@pulse/ui/components/button';
import { FormField, FormSection, Input } from '@pulse/ui/components/form';
import { FormAlert } from '@/components/form-alert';
import { signInAction } from './actions';

/**
 * The sign-in form. Errors show next to the email or above the form. After a failed attempt the
 * email stays filled in (it is held here, never sent back by the server) and the password clears.
 * There is no Forgot password link until password reset by email ships (a future release).
 */
export function SignInForm({ callbackUrl }: { callbackUrl: string }) {
  const [result, action, pending] = useActionState(signInAction, null);
  const [email, setEmail] = useState('');

  return (
    <form action={action} noValidate className="flex flex-col gap-4">
      <input type="hidden" name="callbackUrl" value={callbackUrl} />
      <FormAlert message={result && !result.ok ? result.formError : null} />
      <FormSection>
        <FormField label="Email" error={fieldError(result, 'email')} required>
          <Input
            type="email"
            name="email"
            autoComplete="username"
            inputMode="email"
            autoCapitalize="none"
            spellCheck={false}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </FormField>
        <FormField label="Password" error={fieldError(result, 'password')} required>
          <Input type="password" name="password" autoComplete="current-password" required />
        </FormField>
      </FormSection>
      <Button type="submit" loading={pending} className="h-12 w-full text-body">
        Sign in
      </Button>
    </form>
  );
}
