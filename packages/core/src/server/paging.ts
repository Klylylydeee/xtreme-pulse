import { Types } from 'mongoose';
import { ActionError } from '../actions';
import { OBJECT_ID_PATTERN } from '../audit';

// Keyset paging on `(createdAt, _id)`, newest first, for lists that only grow (the audit log,
// notifications). The cursor is opaque to the browser: the last row's time and id, encoded.

export interface KeysetPosition {
  createdAt: Date;
  id: Types.ObjectId;
}

/** The cursor for the page after the row at `position`. */
export function encodeCursor(position: { createdAt: Date; _id: Types.ObjectId }): string {
  return Buffer.from(
    JSON.stringify([position.createdAt.toISOString(), position._id.toHexString()]),
    'utf8',
  ).toString('base64url');
}

const STALE_CURSOR = 'This page link is out of date. Go back to the first page.';

/** Reads a cursor. Throws {@link ActionError} for one this app didn't make. */
export function decodeCursor(cursor: string): KeysetPosition {
  try {
    if (cursor.length > 200) throw new Error('too long');
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2) throw new Error('shape');
    const [time, id] = parsed as unknown[];
    if (typeof time !== 'string' || typeof id !== 'string' || !OBJECT_ID_PATTERN.test(id)) {
      throw new Error('shape');
    }
    const createdAt = new Date(time);
    if (Number.isNaN(createdAt.getTime())) throw new Error('date');
    return { createdAt, id: new Types.ObjectId(id) };
  } catch {
    throw new ActionError(STALE_CURSOR);
  }
}

/** The filter for rows after `position`, in `{ createdAt: -1, _id: -1 }` order. */
export function afterPosition(position: KeysetPosition): Record<string, unknown> {
  return {
    $or: [
      { createdAt: { $lt: position.createdAt } },
      { createdAt: position.createdAt, _id: { $lt: position.id } },
    ],
  };
}

/** Clamps a requested page size to `[1, max]`, with `fallback` when none is given. */
export function pageSize(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(Math.trunc(limit), 1), max);
}

/** An ObjectId from a 24-character hex string or an ObjectId; null for anything else. */
export function toObjectId(value: unknown): Types.ObjectId | null {
  if (value instanceof Types.ObjectId) return value;
  if (typeof value === 'string' && OBJECT_ID_PATTERN.test(value)) return new Types.ObjectId(value);
  return null;
}
