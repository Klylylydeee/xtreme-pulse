import { z } from 'zod';

// The shared shape of every Server Action (docs/ARCHITECTURE.md#architecture-rules,
// docs/CODE_STYLE.md#pages-server-actions-and-route-handlers):
//
//   1. check access (first, before reading any data)
//   2. validate the input with Zod
//   3. call a service in packages/<module>
//
// and return field errors in one shape, so a form shows each one inline in its FormField
// (`error={result.fieldErrors.name}`).
//
// ```ts
// 'use server';
// export const createDeal = defineAction({
//   access: requireModuleAccess('engage', 'write'),   // step 1.6 adds requireModuleAccess
//   schema: createDealSchema,
//   handler: (input) => dealService.create(input),
// });
// ```
//
// The audit log entry is not written here. A mutating service writes it itself, inside its own
// `withTransaction`, with `recordAudit(…, { session })` from `@pulse/core/server`, so the change
// and its entry commit or abort together (docs/ARCHITECTURE.md#architecture-rules,
// docs/modules/core.md#audit-log). The action passes the signed-in user to the service as the
// actor.

/** Field errors keyed by field name (nested fields use dots: `lines.0.amount`). */
export type FieldErrors = Partial<Record<string, string>>;

/** What every Server Action returns. */
export type ActionResult<TData = undefined> =
  | { ok: true; data: TData }
  | {
      ok: false;
      /** One error for the whole form (shown above the form), or null. */
      formError: string | null;
      /** Errors to show next to their fields. */
      fieldErrors: FieldErrors;
    };

/**
 * An expected, user-facing failure thrown by a service: a duplicate, a closed period, a missing
 * approval. The message must say what to do next (docs/CODE_STYLE.md#errors-and-messages) and
 * must never contain a sensitive value. Give `field` to show it next to that field.
 */
export class ActionError extends Error {
  readonly field: string | null;
  constructor(message: string, options: { field?: string } = {}) {
    super(message);
    this.name = 'ActionError';
    this.field = options.field ?? null;
  }
}

/** Thrown by an access check when the user may not do this. */
export class AccessDeniedError extends Error {
  constructor(message = 'You don’t have access to do this. Ask HR or the System Administrator.') {
    super(message);
    this.name = 'AccessDeniedError';
  }
}

/**
 * The access check slot. It runs first and throws {@link AccessDeniedError} to refuse. The app
 * supplies `requireSignedIn()` (step 1.2, in apps/web/lib/auth.ts, since it reads the session);
 * step 1.6 adds `requireModuleAccess(module, level)`. {@link publicAction} is the one explicit
 * exception.
 */
export type AccessCheck = () => void | Promise<void>;

/**
 * No sign-in needed. Only for signing in itself (SECURITY.md#sign-in-and-passwords): every other
 * action checks the signed-in user. Named so a review can find every use.
 */
export const publicAction: AccessCheck = () => {};

/**
 * Placeholder for Phase 0 development code only. It enforces nothing in development and refuses
 * every call in production, so an action still using it can never run on a real server.
 * Replace it with a real check in step 1.6.
 */
export const noAccessCheckYet: AccessCheck = () => {
  if (process.env.NODE_ENV === 'production') {
    throw new AccessDeniedError('This action has no access check yet, so it is turned off.');
  }
};

export interface ActionDefinition<TSchema extends z.ZodType, TData> {
  /** Runs before anything else. Required, so no action forgets it. */
  access: AccessCheck;
  /** Validates the input. Field messages must be written for people (docs/DESIGN_SYSTEM.md#writing). */
  schema: TSchema;
  /** Calls the service with the validated input. Throw {@link ActionError} for expected failures. */
  handler: (input: z.output<TSchema>) => Promise<TData>;
}

/** The function `defineAction` returns. Its signature fits React's `useActionState`. */
export type ServerAction<TData> = (
  previous: ActionResult<TData> | null,
  input: FormData | Record<string, unknown>,
) => Promise<ActionResult<TData>>;

/**
 * Turns FormData into a plain object for Zod. A name sent more than once becomes an array. Next's
 * own `$ACTION…` fields are dropped. Values stay strings (or Files): coerce in the schema.
 */
export function formDataToObject(formData: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of new Set(formData.keys())) {
    if (key.startsWith('$ACTION')) continue;
    const values = formData.getAll(key);
    out[key] = values.length === 1 ? values[0] : values;
  }
  return out;
}

/** Converts a ZodError into the shared result: the first message for each field. */
export function validationFailure(error: z.ZodError): ActionResult<never> {
  const fieldErrors: FieldErrors = {};
  let formError: string | null = null;
  for (const issue of error.issues) {
    if (issue.path.length === 0) {
      formError ??= issue.message;
      continue;
    }
    const field = issue.path.map(String).join('.');
    fieldErrors[field] ??= issue.message;
  }
  return { ok: false, formError, fieldErrors };
}

/** A failed result with one form-level message. */
export function formFailure(message: string): ActionResult<never> {
  return { ok: false, formError: message, fieldErrors: {} };
}

/**
 * Builds a Server Action: access check, then Zod validation, then the handler. Validation errors,
 * {@link ActionError} and {@link AccessDeniedError} come back as a failed {@link ActionResult};
 * any other error is re-thrown for the error boundary, so an unexpected message (which could hold
 * a sensitive value) never reaches the form.
 *
 * Put the returned function in a `'use server'` file.
 */
export function defineAction<TSchema extends z.ZodType, TData>(
  definition: ActionDefinition<TSchema, TData>,
): ServerAction<TData> {
  const { access, schema, handler } = definition;
  return async (_previous, input) => {
    try {
      await access();
    } catch (error) {
      if (error instanceof AccessDeniedError) return formFailure(error.message);
      throw error;
    }

    const raw = input instanceof FormData ? formDataToObject(input) : input;
    const parsed = await schema.safeParseAsync(raw);
    if (!parsed.success) return validationFailure(parsed.error);

    try {
      return { ok: true, data: await handler(parsed.data) };
    } catch (error) {
      if (error instanceof ActionError) {
        return error.field
          ? { ok: false, formError: null, fieldErrors: { [error.field]: error.message } }
          : formFailure(error.message);
      }
      if (error instanceof AccessDeniedError) return formFailure(error.message);
      throw error;
    }
  };
}

/** The error for one field, for a FormField's `error` prop. */
export function fieldError(
  result: ActionResult<unknown> | null | undefined,
  field: string,
): string | undefined {
  return result && !result.ok ? result.fieldErrors[field] : undefined;
}
