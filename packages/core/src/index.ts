// Shared helpers every module uses (build step 0.6). Pure code: safe on the server and in the
// browser. The database-bound helpers (document number counters, versioned configuration) are
// server-only, in `@pulse/core/server`.

export { DISPLAY_LOCALE } from './locale';
export {
  addCentavos,
  allocateCentavos,
  assertCentavos,
  type Centavos,
  centavosToDecimalString,
  CURRENCY,
  formatPeso,
  type FormatPesoOptions,
  isCentavos,
  MoneyError,
  multiplyRatios,
  negateCentavos,
  parsePesos,
  type Ratio,
  ratio,
  type RatioInput,
  roundHalfUp,
  scaleCentavos,
  subtractCentavos,
  sumCentavos,
} from './money';
export {
  addDays,
  assertBusinessDate,
  BUSINESS_TIME_ZONE,
  type BusinessDate,
  businessDateRange,
  businessToday,
  businessYear,
  compareBusinessDates,
  DateError,
  formatDate,
  formatDateTime,
  formatTime,
  isBusinessDate,
  now,
  startOfBusinessDate,
  toBusinessDate,
} from './dates';
export {
  assertDocumentPrefix,
  DOCUMENT_PREFIX_PATTERN,
  type DocumentNumberParts,
  formatDocumentNumber,
  parseDocumentNumber,
} from './document-number';
export {
  AccessDeniedError,
  type AccessCheck,
  ActionError,
  type ActionDefinition,
  type ActionResult,
  defineAction,
  type FieldErrors,
  fieldError,
  formDataToObject,
  formFailure,
  noAccessCheckYet,
  type ServerAction,
  validationFailure,
} from './actions';
export { businessDateField, pesoField, type PesoFieldOptions } from './validation';
export { lastFourOf, MASKED_VISIBLE_CHARACTERS } from './sensitive';
export {
  type AccountStatus,
  ALLOWED_EMAIL_DOMAINS,
  type AllowedEmailDomain,
  EMAIL_DOMAIN_PATTERN,
  emailDomainOf,
  EMPLOYMENT_STATUS,
  EMPLOYMENT_STATUSES,
  type EmploymentStatus,
  normalizeEmail,
} from './account';
export { EMPLOYEE_NUMBER_PATTERN, EMPLOYEE_SEQUENCE_MAX } from './employee-number';
export { isPlaceholder } from './placeholder';
export { TIMESHEET_TYPES, type TimesheetType } from './timesheet-types';
