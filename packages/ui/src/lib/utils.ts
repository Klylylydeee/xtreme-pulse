import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * tailwind-merge taught the custom design tokens (styles/tokens.css), so a type style such as
 * `text-body` isn't mistaken for a text color and dropped next to `text-text-primary`.
 */
const twMerge = extendTailwindMerge<'glass'>({
  extend: {
    theme: {
      text: [
        'display',
        'large-title',
        'title-1',
        'title-2',
        'title-3',
        'headline',
        'body',
        'callout',
        'subheadline',
        'footnote',
        'caption',
      ],
      radius: ['control', 'card', 'panel'],
      shadow: ['card', 'float', 'accent'],
    },
    classGroups: {
      duration: [{ duration: ['fast', 'base', 'slow'] }],
      glass: ['glass', 'glass-sidebar', 'glass-bar'],
    },
  },
});

/** Joins class names and resolves Tailwind conflicts (the shadcn/ui `cn` helper). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
