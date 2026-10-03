import type { ReactNode } from 'react';
import { EyeOff } from 'lucide-react';
import { formatDateTime } from '@pulse/core';

// Spec: docs/modules/core.md#audit-log — an entry's before and after snapshots as a field-by-field
// comparison. The snapshots come redacted from the server: a password, hash or sensitive value is
// never in them, only a marker (`{ $hidden: 'sensitive' | 'redacted' }`, plus `changed: true` in
// `after` for a sensitive field whose stored value changed), and anything cut for size is a
// `{ $truncated: … }` marker. Both are shown as words here, never as data.

type Snapshot = Record<string, unknown> | null;

/** Not in this snapshot (the field didn't exist before, or was removed). */
const MISSING = Symbol('missing');
type Value = unknown | typeof MISSING;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMarker(value: unknown): value is { $hidden?: unknown; $truncated?: unknown } {
  return isPlainObject(value) && ('$hidden' in value || '$truncated' in value);
}

/** Flattens a snapshot into dotted paths (`accounts.0.bank`), keeping markers as values. */
function flatten(value: unknown, path: string, out: Map<string, unknown>): void {
  if (isMarker(value) || (!isPlainObject(value) && !Array.isArray(value))) {
    out.set(path, value);
    return;
  }
  const entries = Array.isArray(value)
    ? value.map((item, index) => [String(index), item] as const)
    : Object.entries(value);
  if (entries.length === 0) {
    out.set(path, value);
    return;
  }
  for (const [key, item] of entries) flatten(item, path ? `${path}.${key}` : key, out);
}

function fieldsOf(snapshot: Snapshot): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (snapshot !== null) flatten(snapshot, '', out);
  return out;
}

function same(a: Value, b: Value): boolean {
  if (a === MISSING || b === MISSING) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function Muted({ children }: { children: ReactNode }) {
  return <span className="text-text-secondary italic">{children}</span>;
}

/** One value, as people read it. Markers become words; nothing hidden is ever shown. */
export function SnapshotValue({ value }: { value: Value }) {
  if (value === MISSING) return <Muted>Not set</Muted>;
  if (isMarker(value)) {
    if ('$hidden' in value) {
      const sensitive = value.$hidden === 'sensitive';
      // `changed: true`: the stored value differs from before (the server compared it; the value
      // itself is never in the snapshot).
      const changed = sensitive && 'changed' in value && value.changed === true;
      return (
        <span className="inline-flex items-center gap-1.5 text-text-secondary">
          <EyeOff aria-hidden="true" className="size-4 shrink-0" />
          {changed ? 'Hidden (sensitive), changed' : sensitive ? 'Hidden (sensitive)' : 'Hidden'}
        </span>
      );
    }
    return <Muted>Too large to show</Muted>;
  }
  if (value === null || value === '') return <Muted>Empty</Muted>;
  if (typeof value === 'boolean') return <>{value ? 'Yes' : 'No'}</>;
  if (typeof value === 'number') return <span className="numeric">{value}</span>;
  if (typeof value === 'string') {
    if (ISO_INSTANT.test(value)) {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) {
        return (
          <time dateTime={value} className="numeric">
            {formatDateTime(date)}
          </time>
        );
      }
    }
    return <span className="break-words whitespace-pre-wrap">{value}</span>;
  }
  if (Array.isArray(value) || isPlainObject(value)) return <Muted>None</Muted>;
  return <Muted>Can’t show this value</Muted>;
}

function FieldName({ path }: { path: string }) {
  return (
    <dt className="text-footnote font-semibold break-all text-text-primary">
      {path || 'Whole record'}
    </dt>
  );
}

/**
 * The comparison: changed fields first, highlighted, each with its before and after value; the
 * unchanged ones collapsed below, muted. A create shows only the new values, a delete only the old.
 */
export function SnapshotChanges({ before, after }: { before: Snapshot; after: Snapshot }) {
  if (before === null && after === null) return null;

  const old = fieldsOf(before);
  const next = fieldsOf(after);
  const paths = [...new Set([...next.keys(), ...old.keys()])];
  const value = (fields: Map<string, unknown>, path: string): Value =>
    fields.has(path) ? fields.get(path) : MISSING;

  if (before === null || after === null) {
    const fields = after === null ? old : next;
    const title = after === null ? 'Values before it was deleted' : 'Values when created';
    return (
      <section aria-labelledby="snapshot-values" className="flex flex-col gap-2">
        <h3 id="snapshot-values" className="text-headline">
          {title}
        </h3>
        {paths.length === 0 ? (
          <p className="text-subheadline text-text-secondary">No fields recorded.</p>
        ) : (
          <dl className="flex flex-col divide-y divide-separator rounded-card bg-surface">
            {paths.map((path) => (
              <div key={path} className="flex flex-col gap-0.5 px-3 py-2">
                <FieldName path={path} />
                <dd className="text-subheadline">
                  <SnapshotValue value={value(fields, path)} />
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>
    );
  }

  const changed = paths.filter((path) => !same(value(old, path), value(next, path)));
  const unchanged = paths.filter((path) => same(value(old, path), value(next, path)));

  return (
    <section aria-labelledby="snapshot-changes" className="flex flex-col gap-3">
      <h3 id="snapshot-changes" className="text-headline">
        Changed fields <span className="numeric text-text-secondary">({changed.length})</span>
      </h3>
      {changed.length === 0 ? (
        <p className="text-subheadline text-text-secondary">No visible field changed.</p>
      ) : (
        <dl className="flex flex-col gap-2">
          {changed.map((path) => (
            <div
              key={path}
              className="flex flex-col gap-1.5 rounded-lg bg-accent-subtle px-3 py-2.5"
            >
              <FieldName path={path} />
              <dd className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 text-subheadline">
                <span className="text-caption font-semibold text-text-secondary">Before</span>
                <span className="text-text-secondary">
                  <SnapshotValue value={value(old, path)} />
                </span>
                <span className="text-caption font-semibold text-text-secondary">After</span>
                <span className="font-medium text-text-primary">
                  <SnapshotValue value={value(next, path)} />
                </span>
              </dd>
            </div>
          ))}
        </dl>
      )}
      {unchanged.length > 0 ? (
        <details className="group rounded-card bg-surface">
          <summary className="flex min-h-11 cursor-pointer items-center px-3 text-subheadline font-medium text-text-secondary">
            Unchanged fields <span className="ml-1 numeric">({unchanged.length})</span>
          </summary>
          <dl className="flex flex-col divide-y divide-separator border-t border-separator">
            {unchanged.map((path) => (
              <div key={path} className="flex flex-col gap-0.5 px-3 py-2">
                <dt className="text-footnote font-medium break-all text-text-secondary">{path}</dt>
                <dd className="text-subheadline text-text-secondary">
                  <SnapshotValue value={value(next, path)} />
                </dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
    </section>
  );
}
