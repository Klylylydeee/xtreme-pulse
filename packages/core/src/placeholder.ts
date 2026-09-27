// Spec: docs/modules/core.md#company-details-pending-from-the-client — company details start as
// clearly marked placeholders in square brackets (for example `[Company TIN]`) until the client
// provides them. HR and the System Administrator see a reminder while any is still a placeholder.
const PLACEHOLDER = /^\[.+\]$/;

/** True for a value still holding its placeholder, such as `[Company TIN]`. */
export function isPlaceholder(value: string): boolean {
  return PLACEHOLDER.test(value.trim());
}
