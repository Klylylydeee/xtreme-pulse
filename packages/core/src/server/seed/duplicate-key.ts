/**
 * True for MongoDB's duplicate key error (E11000). With `field`, only when the unique index that
 * refused the write includes that field.
 */
export function isDuplicateKeyError(error: unknown, field?: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, keyPattern } = error as { code?: unknown; keyPattern?: unknown };
  if (code !== 11000) return false;
  if (field === undefined) return true;
  return typeof keyPattern === 'object' && keyPattern !== null && Object.hasOwn(keyPattern, field);
}
