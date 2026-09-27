// Masking for sensitive values (SECURITY.md#sensitive-data): the UI shows only the last 4
// characters until the value is revealed. Pure code, safe in the browser. The masked field
// component (`@pulse/ui/components/masked-field`) draws the mask around what this returns.

/** How many trailing characters a masked value shows. */
export const MASKED_VISIBLE_CHARACTERS = 4;

/**
 * The last 4 letters or digits of a sensitive value, for its masked display ("•••• 7890").
 * Separators (spaces, dashes) are skipped. A value with 4 or fewer letters and digits returns an
 * empty string, so the mask never shows the whole value.
 */
export function lastFourOf(value: string | number): string {
  const characters = Array.from(String(value).replace(/[^\p{L}\p{N}]/gu, ''));
  if (characters.length <= MASKED_VISIBLE_CHARACTERS) return '';
  return characters.slice(-MASKED_VISIBLE_CHARACTERS).join('');
}
