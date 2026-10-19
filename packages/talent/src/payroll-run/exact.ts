import { type Centavos, MoneyError, type Ratio, ratio, roundHalfUp } from '@pulse/core';

// Exact sums of ratios for the pay engine (docs/DATA_MODEL.md#money: "round only at the line
// level"). Every line is an exact ratio of centavos until it is rounded, half-up, once.

export const ZERO: Ratio = ratio(0);
export const ONE: Ratio = ratio(1);

/** a + b, exactly. */
export function addRatio(a: Ratio, b: Ratio): Ratio {
  return ratio(
    a.numerator * b.denominator + b.numerator * a.denominator,
    a.denominator * b.denominator,
  );
}

/** a − b, exactly. */
export function subtractRatio(a: Ratio, b: Ratio): Ratio {
  return ratio(
    a.numerator * b.denominator - b.numerator * a.denominator,
    a.denominator * b.denominator,
  );
}

/** A ratio of centavos rounded half-up to a whole centavo: the one rounding of a line. */
export function roundCentavos(value: Ratio): Centavos {
  const rounded = roundHalfUp(value.numerator, value.denominator);
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER) || rounded < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new MoneyError('The amount is too large to store as centavos.');
  }
  return Number(rounded) || 0;
}

/**
 * A quantity as a plain decimal string ("1", "0.5", "480"). A fraction whose denominator has
 * factors other than 2 and 5 is shown to 6 places, rounded half-up.
 */
export function decimalText(value: Ratio): string {
  const { numerator, denominator } = value;
  let places = 0;
  let scale = 1n;
  while (places < 6 && (numerator * scale) % denominator !== 0n) {
    places += 1;
    scale *= 10n;
  }
  const scaled = roundHalfUp(numerator * scale, denominator);
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled).toString().padStart(places + 1, '0');
  const whole = places === 0 ? digits : digits.slice(0, -places);
  const fraction = places === 0 ? '' : `.${digits.slice(-places)}`;
  return `${negative ? '-' : ''}${whole}${fraction.replace(/\.?0+$/, '')}`;
}

/** A rate multiplier as text: "1.25", "1.3", "0.1". */
export function multiplierText(value: Ratio): string {
  return decimalText(value);
}
