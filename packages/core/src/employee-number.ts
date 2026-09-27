// Spec: docs/modules/core.md#employee-number-company-id — employee numbers are `YYYY-NN`: the
// hire year and a 2-digit sequence within that year, from 01 to at most 99.

/** The highest sequence in a year; a 100th hire that year fails. */
export const EMPLOYEE_SEQUENCE_MAX = 99;

/** `2027-01` to `2027-99`. */
export const EMPLOYEE_NUMBER_PATTERN = /^\d{4}-(?:0[1-9]|[1-9]\d)$/;
