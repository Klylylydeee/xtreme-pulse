/**
 * A form sends one field per item of a list: none, one (a plain string) or several (an array, see
 * `formDataToObject`). Turns the named fields of `raw` into arrays, so the schemas can take one.
 * Used as a `z.preprocess` step by the reporting line actions (`reportingTo`, one field per
 * supervisor, as the supervisor picker posts them).
 */
export function withListFields(raw: unknown, names: readonly string[]): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const out: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const name of names) {
    const value = out[name];
    out[name] =
      value === undefined || value === null || value === ''
        ? []
        : Array.isArray(value)
          ? value
          : [value];
  }
  return out;
}

/** The users actions' preprocess: `reportingTo` as a list. */
export function withReportingToList(raw: unknown): unknown {
  return withListFields(raw, ['reportingTo']);
}
