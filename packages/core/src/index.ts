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
  formatRelativeTime,
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
  publicAction,
  type ServerAction,
  validationFailure,
} from './actions';
export { businessDateField, pesoField, type PesoFieldOptions } from './validation';
export { lastFourOf, MASKED_VISIBLE_CHARACTERS } from './sensitive';
export {
  type AccountStatus,
  ALLOWED_EMAIL_DOMAINS,
  type AllowedEmailDomain,
  type ChangePasswordInput,
  changePasswordSchema,
  EMAIL_DOMAIN_PATTERN,
  emailDomainOf,
  EMPLOYMENT_STATUS,
  EMPLOYMENT_STATUSES,
  type EmploymentStatus,
  newPasswordField,
  newPasswordSchema,
  normalizeEmail,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_RULE_HELP,
  SAME_AS_CURRENT,
  SAME_AS_EMAIL,
  SESSION_MAX_AGE_HOURS,
  type SignInInput,
  signInSchema,
} from './account';
export {
  EMPLOYEE_NUMBER_PATTERN,
  EMPLOYEE_SEQUENCE_MAX,
  type EmployeeNumberParts,
  formatEmployeeNumber,
  parseEmployeeNumber,
} from './employee-number';
// User accounts (docs/modules/core.md#managing-user-accounts): the user sheet's schemas and rules.
export * from './user-accounts';
export { isPlaceholder } from './placeholder';
export { TIMESHEET_TYPES, type TimesheetType } from './timesheet-types';
export { isModuleKey, type ModuleKey, MODULES } from './modules';
export {
  AUDIT_ACTIONS,
  AUDIT_LABEL_MAX_LENGTH,
  AUDIT_MODULES,
  AUDIT_PAGE_MAX,
  AUDIT_REASON_MAX_LENGTH,
  type AuditAction,
  type AuditFilters,
  auditFiltersSchema,
  type AuditModule,
  OBJECT_ID_PATTERN,
  RECORD_TYPE_MAX_LENGTH,
  RECORD_TYPE_PATTERN,
} from './audit';
export {
  isInternalHref,
  NOTIFICATION_BODY_MAX_LENGTH,
  NOTIFICATION_EVENT_PATTERN,
  NOTIFICATION_HREF_MAX_LENGTH,
  NOTIFICATION_PAGE_MAX,
  NOTIFICATION_TITLE_MAX_LENGTH,
} from './notifications';
export {
  COMPANY_DETAIL_FIELDS,
  COMPANY_DETAIL_MAX_LENGTH,
  COMPANY_LOGO_DETAIL,
  type CompanyDetailField,
  type CompanyDetailPath,
  type CompanyDetailsFormInput,
  companyDetailsSchema,
  type CompanyDetailsSource,
  type CompanyDetailsValues,
  type EmailDomainInput,
  emailDomainSchema,
  type FileUploadSettingsInput,
  fileUploadSettingsInputSchema,
  type FileUploadSettingsValues,
  pendingCompanyDetails,
  UPLOAD_SIZE_MAX_MEGABYTES,
} from './company-details';
export { UPLOAD_TYPES, type UploadType } from './server/files/file-types';
export {
  DEPARTMENT_CODE_HELP,
  DEPARTMENT_CODE_PATTERN,
  DEPARTMENT_NAME_MAX_LENGTH,
  type DepartmentInput,
  departmentInputSchema,
  type DepartmentUpdateInput,
  departmentUpdateSchema,
  POSITION_NAME_MAX_LENGTH,
  type PositionInput,
  positionInputSchema,
  type PositionUpdateInput,
  positionUpdateSchema,
  TIMESHEET_TYPE_CHANGE_NOTE,
  TIMESHEET_TYPE_LABELS,
  TIMESHEET_TYPE_OPTIONS,
} from './org-structure';
