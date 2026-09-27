import { DISPLAY_LOCALE } from './locale';

// Spec: docs/DATA_MODEL.md#money and docs/adr/0006-money-as-integer-centavos.md
//
// Every amount is an integer number of centavos, in PHP. Never do arithmetic on floating-point
// pesos. Exact intermediate values are kept as ratios of big integers and rounded once, at the
// line level, half-up to the centavo.
//
// "Half-up" is applied symmetrically: a tie rounds away from zero (0.5 → 1, -0.5 → -1), so a
// reversal line always mirrors the line it reverses. See roundHalfUp.

/** An amount in centavos: a safe integer. ₱1,234.50 is 123450. */
export type Centavos = number;

/** The currency of every amount (docs/DATA_MODEL.md#money: currency default PHP). */
export const CURRENCY = 'PHP';

/** Thrown when a value isn't a valid amount, ratio or peso string. */
export class MoneyError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function toSafeNumber(value: bigint, what: string): Centavos {
  if (value > MAX_SAFE || value < -MAX_SAFE) {
    throw new MoneyError(`The ${what} is too large to store as centavos.`);
  }
  // Normalize -0 to 0.
  return Number(value) || 0;
}

/** True when `value` is a valid amount in centavos (a safe integer). */
export function isCentavos(value: unknown): value is Centavos {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/** Throws unless `value` is a safe integer number of centavos. Returns it (with -0 as 0). */
export function assertCentavos(value: unknown, what = 'amount'): Centavos {
  if (!isCentavos(value)) {
    throw new MoneyError(`The ${what} must be a whole number of centavos.`);
  }
  return value || 0;
}

/** Adds amounts exactly. Throws if an input isn't centavos or the total leaves the safe range. */
export function sumCentavos(values: Iterable<Centavos>): Centavos {
  let total = 0n;
  for (const value of values) total += BigInt(assertCentavos(value));
  return toSafeNumber(total, 'total');
}

/** `a + b + …` in centavos. */
export function addCentavos(...values: Centavos[]): Centavos {
  return sumCentavos(values);
}

/** `a - b` in centavos. */
export function subtractCentavos(a: Centavos, b: Centavos): Centavos {
  return toSafeNumber(BigInt(assertCentavos(a)) - BigInt(assertCentavos(b)), 'difference');
}

/** `-a` in centavos (never -0). */
export function negateCentavos(a: Centavos): Centavos {
  return toSafeNumber(-BigInt(assertCentavos(a)), 'amount');
}

// ---------------------------------------------------------------------------------------------
// Exact ratios

/**
 * An exact rational number, used for rates, factors and quantities (12% VAT, 12 ÷ 261, 1.25
 * overtime, 1.5 hours). The denominator is always positive and the fraction is reduced.
 */
export interface Ratio {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

/**
 * Anything {@link ratio} accepts: a Ratio, a bigint, a safe integer number, or a decimal string
 * such as `"0.12"`, `"-1.5"` or `"130%"`. Non-integer JavaScript numbers are refused, because
 * `0.1` is already inexact before it arrives. Write rates as strings (or store them that way in
 * versioned configuration).
 */
export type RatioInput = Ratio | bigint | number | string;

const DECIMAL = /^([+-]?)(\d+)(?:\.(\d+))?(%?)$/;

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y) [x, y] = [y, x % y];
  return x;
}

function makeRatio(numerator: bigint, denominator: bigint): Ratio {
  if (denominator === 0n) throw new MoneyError('A ratio cannot divide by zero.');
  if (denominator < 0n) {
    numerator = -numerator;
    denominator = -denominator;
  }
  const divisor = gcd(numerator, denominator) || 1n;
  return Object.freeze({ numerator: numerator / divisor, denominator: denominator / divisor });
}

function isRatio(value: unknown): value is Ratio {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Ratio).numerator === 'bigint' &&
    typeof (value as Ratio).denominator === 'bigint'
  );
}

function toBigIntInteger(value: number | bigint, what: string): bigint {
  if (typeof value === 'bigint') return value;
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(
      `The ${what} must be a whole number. Pass a decimal as a string, for example "0.12".`,
    );
  }
  return BigInt(value);
}

/**
 * Makes an exact ratio.
 *
 * ```ts
 * ratio('0.12')   // 12/100 (VAT)
 * ratio('125%')   // 5/4
 * ratio(12, 261)  // monthly → daily factor
 * ```
 */
export function ratio(value: RatioInput, denominator: number | bigint = 1n): Ratio {
  const den = toBigIntInteger(denominator, 'denominator');
  if (isRatio(value)) return makeRatio(value.numerator, value.denominator * den);
  if (typeof value === 'string') {
    const match = DECIMAL.exec(value.trim().replaceAll('_', ''));
    if (!match) throw new MoneyError(`"${value}" is not a decimal number.`);
    const [, sign = '', whole = '0', fraction = '', percent] = match;
    let num = BigInt(whole + fraction);
    let scale = 10n ** BigInt(fraction.length);
    if (percent) scale *= 100n;
    if (sign === '-') num = -num;
    return makeRatio(num, scale * den);
  }
  return makeRatio(toBigIntInteger(value, 'ratio'), den);
}

/** The exact product of the given ratios. */
export function multiplyRatios(...factors: RatioInput[]): Ratio {
  let num = 1n;
  let den = 1n;
  for (const factor of factors) {
    const r = ratio(factor);
    num *= r.numerator;
    den *= r.denominator;
  }
  return makeRatio(num, den);
}

/**
 * Rounds `numerator / denominator` to the nearest integer; a tie (exactly .5) rounds away from
 * zero. This is the only rounding the money helpers do.
 */
export function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new MoneyError('Cannot divide by zero.');
  if (denominator < 0n) {
    numerator = -numerator;
    denominator = -denominator;
  }
  const negative = numerator < 0n;
  const abs = negative ? -numerator : numerator;
  const quotient = (abs * 2n + denominator) / (denominator * 2n);
  return negative ? -quotient : quotient;
}

/**
 * Multiplies an amount by any number of rates, factors and quantities, exactly, and rounds the
 * result once, half-up to the centavo. Use one call per line: never round an intermediate value.
 * Spec: docs/DATA_MODEL.md#money ("round only at the line level").
 *
 * ```ts
 * // Overtime line: monthly salary × 12 ÷ 261 ÷ 8 × 1.25 × 3.5 hours
 * scaleCentavos(monthly, ratio(12, 261), ratio(1, 8), '1.25', '3.5')
 * // VAT line
 * scaleCentavos(subtotal, '0.12')
 * ```
 */
export function scaleCentavos(amount: Centavos, ...factors: RatioInput[]): Centavos {
  const r = multiplyRatios(...factors);
  const exact = BigInt(assertCentavos(amount)) * r.numerator;
  return toSafeNumber(roundHalfUp(exact, r.denominator), 'amount');
}

/**
 * Splits `total` into lines in proportion to `weights`. Each line is rounded half-up, except the
 * last line with a non-zero weight, which takes the remainder, so the lines always add up to the
 * total exactly (negative totals too). A zero-weight line always gets 0. Throws when every weight
 * is zero or any is negative.
 * Spec: docs/adr/0006-money-as-integer-centavos.md (billing milestones).
 *
 * ```ts
 * allocateCentavos(100_000_00, ['30', '40', '30'])  // milestone percentages
 * allocateCentavos(1_000_01, [1, 1])                // halves: [500_01, 500_00]
 * ```
 */
export function allocateCentavos(total: Centavos, weights: readonly RatioInput[]): Centavos[] {
  const amount = BigInt(assertCentavos(total, 'total'));
  if (weights.length === 0) throw new MoneyError('Give at least one line to split into.');
  const ratios = weights.map((w) => ratio(w));
  if (ratios.some((r) => r.numerator < 0n)) {
    throw new MoneyError('Split weights cannot be negative.');
  }
  // Put every weight over one common denominator, then compare numerators.
  const common = ratios.reduce((acc, r) => (acc / gcd(acc, r.denominator)) * r.denominator, 1n);
  const scaled = ratios.map((r) => r.numerator * (common / r.denominator));
  const weightTotal = scaled.reduce((a, b) => a + b, 0n);
  if (weightTotal === 0n) throw new MoneyError('Split weights must add up to more than zero.');

  // The last line with a weight takes the remainder; a zero-weight line always gets exactly 0.
  let remainderIndex = scaled.length - 1;
  while (scaled[remainderIndex] === 0n) remainderIndex--;

  const lines: bigint[] = scaled.map((weight, index) =>
    weight === 0n || index === remainderIndex ? 0n : roundHalfUp(amount * weight, weightTotal),
  );
  lines[remainderIndex] = amount - lines.reduce((a, b) => a + b, 0n);
  return lines.map((line) => toSafeNumber(line, 'amount'));
}

// ---------------------------------------------------------------------------------------------
// Display and input

/** `123450` → `"1234.50"`: an exact plain decimal string, for inputs and exports. */
export function centavosToDecimalString(amount: Centavos): string {
  const value = BigInt(assertCentavos(amount));
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const pesos = abs / 100n;
  const cents = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${pesos}.${cents}`;
}

const pesoFormat = new Intl.NumberFormat(DISPLAY_LOCALE, {
  style: 'currency',
  currency: CURRENCY,
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const plainFormat = new Intl.NumberFormat(DISPLAY_LOCALE, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export interface FormatPesoOptions {
  /** Show the ₱ sign (default true). Tables with a ₱ column header can turn it off. */
  symbol?: boolean;
}

/**
 * `123450` → `"₱1,234.50"`, `-5` → `"-₱0.05"`. Formats the exact decimal string, so there is no
 * floating-point step. Show amounts with tabular numerals (docs/DESIGN_SYSTEM.md).
 */
export function formatPeso(amount: Centavos, { symbol = true }: FormatPesoOptions = {}): string {
  // Intl.NumberFormat formats a decimal string exactly (ES2023 Intl.NumberFormat v3).
  const decimal = centavosToDecimalString(amount) as Intl.StringNumericLiteral;
  return (symbol ? pesoFormat : plainFormat).format(decimal);
}

// Optional sign, optional ₱ or PHP (before or after the sign), digits with optional thousands
// commas, optional fraction of up to 2 digits.
const PESO_INPUT = /^([+\-−]?)\s*(?:₱|PHP)?\s*([+\-−]?)\s*(\d{1,3}(?:,\d{3})+|\d+)?(?:\.(\d*))?$/i;

/**
 * Parses what a person types into an amount field: `"1,234.5"`, `"₱1,234.50"`, `"-12"`,
 * `"PHP 99.99"`. Returns centavos. Throws {@link MoneyError} with a message fit for the field when
 * the text isn't an amount or has more than 2 decimal places (it never rounds input).
 */
export function parsePesos(text: string): Centavos {
  const match = PESO_INPUT.exec(text.trim());
  const [, signBefore = '', signAfter = '', whole = '', fraction] = match ?? [];
  if (!match || (!whole && !fraction) || (signBefore && signAfter)) {
    throw new MoneyError('Enter an amount, for example 1,234.50.');
  }
  if (fraction !== undefined && fraction.length > 2) {
    throw new MoneyError('Use at most 2 decimal places (centavos).');
  }
  const sign = signBefore || signAfter;
  const pesos = BigInt(whole.replaceAll(',', '') || '0');
  const cents = BigInt((fraction ?? '').padEnd(2, '0') || '0');
  const value = pesos * 100n + cents;
  return toSafeNumber(sign === '-' || sign === '−' ? -value : value, 'amount');
}
