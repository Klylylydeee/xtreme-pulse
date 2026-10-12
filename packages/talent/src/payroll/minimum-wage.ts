import { type BusinessDate, type Centavos, formatPeso } from '@pulse/core';
import type { RateType, WorkRegion } from '../fixed-sets';
import { dailyRateRatio, isBelowMinimumWage } from './lookups';
import type { MinimumWages } from './schemas';

// Spec: docs/modules/talent.md#payroll-settings-and-allowances-build-step-23 ("Minimum wage
// warning", decisions 205 and 206 in docs/BUILD_PLAN.md). Pure code, safe in the browser.

/** The warning "Add salary change" shows under the amount; the button becomes "Save anyway". */
export interface MinimumWageWarning {
  /** "The daily rate ₱650.00 is below the NCR minimum wage of ₱755.00 (Wage Order NCR-28). It will be flagged in payroll." */
  message: string;
  region: WorkRegion;
  wageOrder: string;
  /** The minimum wage in effect, a day. */
  minimumDailyRateCentavos: Centavos;
  /** The entry's daily rate, rounded down to the centavo for display, so it always reads below the minimum. */
  dailyRateCentavos: Centavos;
  /** The day whose versions were used: the later of the effective date and today. */
  checkedOn: BusinessDate;
}

/** The note when no minimum wage is on file for the region; the salary still saves. */
export function noMinimumWageNote(region: WorkRegion): string {
  return `No minimum wage on file for ${region}. Add it in Payroll settings.`;
}

/** The region's row of a `talent.minimumWages` version, or null. */
export function minimumWageForRegion(
  wages: MinimumWages | null | undefined,
  region: WorkRegion,
): MinimumWages['regions'][number] | null {
  return wages?.regions.find((row) => row.region === region) ?? null;
}

/** The warning for a salary below the minimum, or null when it isn't below. */
export function minimumWageWarningFor({
  amountCentavos,
  rateType,
  region,
  wageOrder,
  minimumDailyRateCentavos,
  dailyRateFactor,
  checkedOn,
}: {
  amountCentavos: Centavos;
  rateType: RateType;
  region: WorkRegion;
  wageOrder: string;
  minimumDailyRateCentavos: Centavos;
  dailyRateFactor: number;
  checkedOn: BusinessDate;
}): MinimumWageWarning | null {
  if (!isBelowMinimumWage(amountCentavos, rateType, minimumDailyRateCentavos, dailyRateFactor)) {
    return null;
  }
  // Rounded down for the sentence, so a rate just under the minimum (₱16,421.24 a month is
  // ₱754.9995… a day) never reads as the minimum itself ("₱755.00 is below … ₱755.00").
  const exact = dailyRateRatio(amountCentavos, rateType, dailyRateFactor);
  const daily = Number(exact.numerator / exact.denominator);
  return {
    message: `The daily rate ${formatPeso(daily)} is below the ${region} minimum wage of ${formatPeso(minimumDailyRateCentavos)} (${wageOrder}). It will be flagged in payroll.`,
    region,
    wageOrder,
    minimumDailyRateCentavos,
    dailyRateCentavos: daily,
    checkedOn,
  };
}
