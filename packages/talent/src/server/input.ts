import { ActionError } from '@pulse/core';

/**
 * The first validation issue as an {@link ActionError} on its field, for a service that parses its
 * input again. Zod messages here never repeat the value typed (validation.ts).
 */
export function inputError(issues: { path: PropertyKey[]; message: string }[]): ActionError {
  const issue = issues[0];
  const field = issue?.path.map(String).join('.') || undefined;
  return new ActionError(issue?.message ?? 'Check the form and try again.', { field });
}
