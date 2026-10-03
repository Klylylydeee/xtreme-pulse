'use client';

import { useActionState } from 'react';
import { fieldError, PASSWORD_RULE_HELP } from '@pulse/core';
import { Button } from '@pulse/ui/components/button';
import { FormField, FormSection, Input } from '@pulse/ui/components/form';
import { FormAlert } from '@/components/form-alert';
import { changePasswordAction } from './actions';

/**
 * Current, new and confirm password on one inset section, with the rule as footer help. The
 * fields clear after a failed attempt, so no password stays on screen.
 */
export function ChangePasswordForm({ email, callbackUrl }: { email: string; callbackUrl: string }) {
  const [result, action, pending] = useActionState(changePasswordAction, null);

  return (
    <form action={action} noValidate className="flex flex-col gap-4">
      {/* Tells password managers which account the new password belongs to. */}
      <input type="text" name="username" autoComplete="username" value={email} readOnly hidden />
      <input type="hidden" name="callbackUrl" value={callbackUrl} />
      <FormAlert message={result && !result.ok ? result.formError : null} />
      <FormSection footer={PASSWORD_RULE_HELP}>
        <FormField label="Current password" error={fieldError(result, 'currentPassword')} required>
          <Input type="password" name="currentPassword" autoComplete="current-password" required />
        </FormField>
        <FormField label="New password" error={fieldError(result, 'newPassword')} required>
          <Input type="password" name="newPassword" autoComplete="new-password" required />
        </FormField>
        <FormField label="Confirm new password" error={fieldError(result, 'confirm')} required>
          <Input type="password" name="confirm" autoComplete="new-password" required />
        </FormField>
      </FormSection>
      <Button type="submit" loading={pending} className="h-12 w-full text-body">
        Set password
      </Button>
    </form>
  );
}
