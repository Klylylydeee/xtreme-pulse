import { z } from 'zod';
import { isBusinessDate } from './dates';
import { MoneyError, parsePesos } from './money';

// Zod building blocks for the shared value types, so every form parses them the same way.

export interface PesoFieldOptions {
  /** Refuse amounts below zero (default true). */
  nonNegative?: boolean;
  /** Message when the field is empty. */
  requiredMessage?: string;
}

/**
 * A form field holding a peso amount as typed (`"1,234.50"`, `"12"` = ₱12.00). Parses to integer
 * centavos exactly, and refuses more than 2 decimal places instead of rounding.
 *
 * Input is always a peso string, as FormData sends it. A JavaScript number is refused, so `12`
 * can never be read as either ₱12 or 12 centavos by mistake. Code that already holds centavos
 * validates them with `isCentavos` instead.
 */
export function pesoField({
  nonNegative = true,
  requiredMessage = 'Enter an amount.',
}: PesoFieldOptions = {}) {
  return z
    .string({ error: requiredMessage })
    .transform((value, ctx) => {
      if (value.trim() === '') {
        ctx.addIssue({ code: 'custom', message: requiredMessage });
        return z.NEVER;
      }
      try {
        return parsePesos(value);
      } catch (error) {
        const message = error instanceof MoneyError ? error.message : 'Enter a valid amount.';
        ctx.addIssue({ code: 'custom', message });
        return z.NEVER;
      }
    })
    .refine((centavos) => !nonNegative || centavos >= 0, {
      message: 'The amount can’t be negative.',
    });
}

/** A form field holding a calendar day (`<input type="date">` sends `"YYYY-MM-DD"`). */
export function businessDateField(requiredMessage = 'Enter a date.') {
  return z
    .string({ error: requiredMessage })
    .trim()
    .min(1, requiredMessage)
    .refine(isBusinessDate, { message: 'Enter a real date.' });
}
