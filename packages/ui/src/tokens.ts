/**
 * Names of the design tokens defined in `styles/tokens.css`, for pages that list them (e.g. /dev/ui).
 * Values live only in the CSS; this file holds names, uses and utility class names.
 */

export const COLOR_TOKENS = [
  { name: 'bg', use: 'Page background' },
  { name: 'bg-grouped', use: 'Behind grouped cards and sections' },
  { name: 'surface', use: 'Cards, sheets, popovers' },
  { name: 'sidebar', use: 'Sidebar base (glass)' },
  { name: 'separator', use: 'Hairline borders and dividers' },
  { name: 'text-primary', use: 'Body text and titles' },
  { name: 'text-secondary', use: 'Supporting text' },
  { name: 'text-tertiary', use: 'Placeholders and metadata' },
  { name: 'accent', use: 'Primary buttons, links, focus rings, selected states' },
  { name: 'accent-hover', use: 'Hover and pressed accent' },
  { name: 'accent-text', use: 'Text and icons on accent fills' },
  { name: 'accent-subtle', use: 'Selected sidebar item, accent badges' },
  { name: 'success', use: 'Success dots (approved)' },
  { name: 'warning', use: 'Warning dots (pending)' },
  { name: 'destructive', use: 'Destructive dots (errors)' },
  { name: 'success-text', use: 'Success text on bg or surface' },
  { name: 'warning-text', use: 'Warning text on bg or surface' },
  { name: 'destructive-text', use: 'Error and destructive text on bg or surface' },
  { name: 'hero', use: 'Solid cobalt hero areas (Home, Login)' },
  { name: 'hero-text', use: 'Text on hero' },
  { name: 'hero-text-secondary', use: 'Supporting text on hero' },
  { name: 'chart-context', use: 'Context series in charts (3:1 on surface)' },
  { name: 'on-semantic-text', use: 'Text on a semantic *-text fill (e.g. a destructive button)' },
  { name: 'scrim', use: 'Dims the page behind modal layers (command bar, drawer)' },
] as const;

export type ColorToken = (typeof COLOR_TOKENS)[number]['name'];

export const TYPE_STYLES = [
  { name: 'Display', token: 'text-display', className: 'text-display' },
  { name: 'Large Title', token: 'text-large-title', className: 'text-large-title' },
  { name: 'Title 1', token: 'text-title-1', className: 'text-title-1' },
  { name: 'Title 2', token: 'text-title-2', className: 'text-title-2' },
  { name: 'Title 3', token: 'text-title-3', className: 'text-title-3' },
  { name: 'Headline', token: 'text-headline', className: 'text-headline' },
  { name: 'Body', token: 'text-body', className: 'text-body' },
  { name: 'Callout', token: 'text-callout', className: 'text-callout' },
  { name: 'Subheadline', token: 'text-subheadline', className: 'text-subheadline' },
  { name: 'Footnote', token: 'text-footnote', className: 'text-footnote' },
  { name: 'Caption', token: 'text-caption', className: 'text-caption' },
] as const;

export const RADIUS_TOKENS = [
  { token: 'radius-sm', className: 'rounded-sm', use: 'Small' },
  { token: 'radius-md', className: 'rounded-md', use: 'Medium' },
  { token: 'radius-lg', className: 'rounded-lg', use: 'Large' },
  { token: 'radius-xl', className: 'rounded-xl', use: 'Extra large' },
  { token: 'radius-2xl', className: 'rounded-2xl', use: '2× extra large' },
  { token: 'radius-control', className: 'rounded-control', use: 'Controls' },
  { token: 'radius-card', className: 'rounded-card', use: 'Cards and sheets' },
  { token: 'radius-panel', className: 'rounded-panel', use: 'Floating glass panels' },
  { token: 'radius-3xl', className: 'rounded-3xl', use: 'Hero areas' },
] as const;

/** Steps of the 4px spacing grid (Tailwind spacing multipliers). */
export const SPACING_STEPS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16] as const;

export const SHADOW_TOKENS = [
  { token: 'shadow-card', className: 'shadow-card', use: 'Resting cards' },
  { token: 'shadow-float', className: 'shadow-float', use: 'Floating layers (sheets, popovers)' },
  { token: 'shadow-accent', className: 'shadow-accent', use: 'Accent buttons and hero' },
] as const;

export const GLASS_TOKENS = [
  { token: 'glass-sidebar', className: 'glass-sidebar', use: 'Sidebar' },
  { token: 'glass', className: 'glass', use: 'Inspector panels, sheets, command bar' },
  { token: 'glass-bar', className: 'glass-bar', use: 'Top toolbar (hairline under it only)' },
] as const;

export const MOTION_TOKENS = [
  { token: 'duration-fast', className: 'duration-fast' },
  { token: 'duration-base', className: 'duration-base' },
  { token: 'duration-slow', className: 'duration-slow' },
] as const;

/** Easing for every transition. */
export const EASING_TOKENS = [
  { token: 'ease-out', className: 'ease-out', use: 'Default easing (ease-out)' },
] as const;

/** Glass values used by the glass utilities. */
export const GLASS_VALUE_TOKENS = ['glass-blur', 'glass-saturate', 'glass-opacity'] as const;
