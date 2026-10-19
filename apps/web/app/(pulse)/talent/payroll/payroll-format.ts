import { type Centavos, formatPeso } from '@pulse/core';
import type { PayrollLine, PayrollQuantityUnit } from '@pulse/talent';

// Spec: docs/modules/talent.md#payroll-run-computation-build-step-29 ("The employee line",
// "Screens") and docs/DESIGN_SYSTEM.md#layout--components ("Payroll runs on a phone": amounts are
// right-aligned tabular numerals, negatives with a minus sign, never color alone) — the payroll
// screens' display helpers. Amounts are whole centavos, formatted with Core's `formatPeso` (exact,
// no floating point). Pure, safe in the browser; nothing here is logged.

/** "₱1,234.50", or "-₱1,000.00" for a negative amount. */
export function pesoText(amount: Centavos): string {
  return formatPeso(amount);
}

/** "+₱1,000.00" or "-₱1,000.00": a settlement's effect, with its sign always shown. */
export function signedPesoText(amount: Centavos): string {
  return amount > 0 ? `+${formatPeso(amount)}` : formatPeso(amount);
}

/**
 * What a line does to net pay, as the breakdown shows it. Earnings and deductions of the cut-off
 * read as they are (a deduction is positive); a settlement shows its effect on pay, so a settled
 * deduction reads negative ("Absences · Sep 26 – Oct 10 -₱1,000.00") and a reversed one positive.
 */
export function lineAmountText(line: PayrollLine): string {
  if (line.group !== 'settlements') return pesoText(line.amountCentavos);
  const effect = line.side === 'deduction' ? -line.amountCentavos : line.amountCentavos;
  return signedPesoText(effect);
}

const UNIT_WORDS: Record<PayrollQuantityUnit, [one: string, many: string]> = {
  days: ['day', 'days'],
  minutes: ['min', 'min'],
  receipts: ['receipt', 'receipts'],
};

/** "480 min", "1 day", "0.5 day", "2 receipts"; null when the line has no quantity. */
export function quantityText(line: Pick<PayrollLine, 'quantity' | 'unit'>): string | null {
  if (line.quantity === null) return null;
  if (line.unit === null) return line.quantity;
  const [one, many] = UNIT_WORDS[line.unit];
  const singular = line.quantity === '1' || /^0(\.\d+)?$/.test(line.quantity);
  return `${line.quantity} ${singular ? one : many}`;
}

/** A line's quantity and rate in words: "480 min · ₱125.00 an hour × 1.25"; null when neither. */
export function lineDetailText(line: PayrollLine): string | null {
  const parts = [quantityText(line), line.rateText].filter((part): part is string => !!part);
  return parts.length > 0 ? parts.join(' · ') : null;
}
