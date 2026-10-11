// Server-only shared helpers that use the database, the storage folder, Redis or the encryption
// key (build steps 0.6 to 0.8). Import them from `@pulse/core/server`; the pure helpers stay in
// `@pulse/core`, which is safe in the browser. PDF and Excel exports are in
// `@pulse/core/server/exports`, and the worker runtime in `@pulse/core/server/worker`.

export {
  type IssuedDocumentNumber,
  nextDocumentNumber,
  type NextDocumentNumberOptions,
} from './document-numbers';
export {
  addConfigVersion,
  type AddConfigVersionInput,
  type ConfigDate,
  ConfigNotFoundError,
  type ConfigReadOptions,
  type ConfigSetting,
  type ConfigVersion,
  ConfigVersionExistsError,
  defineConfigSetting,
  findConfigVersion,
  listConfigVersions,
  resolveConfig,
} from './config';
// Sign-in, passwords, account status and roles (SECURITY.md#account--access, SECURITY.md#roles)
export { hashPassword, verifyPassword } from './auth/password';
export { assertSignedIn, type SignedInOptions } from './auth/access';
export { type AccountStatusInput, resolveAccountStatus } from './auth/account-status';
export {
  authenticate,
  type AuthenticateFailure,
  type AuthenticateResult,
  needsPasswordChange,
} from './auth/authenticate';
export { changePassword } from './auth/change-password';
// Module access (SECURITY.md#resolving-and-enforcing-build-step-16)
export {
  type AdminAreaKind,
  assertModuleAccess,
  canOpenAdminArea,
  hasModuleAccess,
  type ModuleAccessHolder,
  type ModuleAccessSource,
  resolveModuleAccess,
} from './auth/module-access';
export {
  type AccountActor,
  type AccountTarget,
  assertSystemAdministrator,
  canChangeProtectedFieldsOf,
  canEditAccountOf,
  canManageOrgStructure,
  canManageUsers,
  canEditAccessOf,
  canEditReportingLines,
  canManageAccess,
  canManageHolidays,
  canResetPasswordOf,
  canSeeSeparatedPeople,
  canToggleSystemAdministrator,
  type DepartmentRole,
  departmentRolesFor,
  hasRole,
  isAccounting,
  isBoard,
  isHR,
  isSystemAdministrator,
  type Role,
  type RoleHolder,
  ROLE_DEPARTMENT_CODES,
} from './auth/roles';
export {
  type CurrentUser,
  isSessionAfterReset,
  isSessionCurrent,
  loadSessionUser,
} from './auth/session-user';
export {
  CROCKFORD_BASE32,
  generateTemporaryPassword,
  generateTemporaryPasswordFor,
  TEMPORARY_PASSWORD_PATTERN,
} from './auth/temporary-password';
export { checkEmailDomain, type EmailDomainCheck } from './allowed-email-domains/service';

export {
  checkSharedHelpers,
  type HelperCheck,
  type HelperGroup,
  type SharedHelpersHealth,
} from './dev-health';

// File storage (docs/ARCHITECTURE.md#file-storage)
export {
  authorizeFileAccess,
  type FileAccessCheck,
  findAccessibleFile,
  registerFileAccess,
} from './files/access';
export { registerCoreFileAccess } from './files/registrations';
export {
  GENERATED_TYPES,
  type GeneratedType,
  UPLOAD_TYPES,
  type UploadType,
} from './files/file-types';
export { checkStorage, type StorageHealth } from './files/health';
export { StorageConfigError, storageRoot } from './files/root';
export {
  currentFileUploadSettings,
  DEFAULT_FILE_UPLOAD_SETTINGS,
  FILE_UPLOADS_SETTING,
  type FileUploadSettings,
  UPLOAD_REQUEST_LIMIT_BYTES,
} from './files/settings';
export {
  contentDisposition,
  type FileOwner,
  type FileSource,
  findGeneratedFile,
  findStoredFile,
  openStoredFile,
  sanitizeFileName,
  saveGeneratedFile,
  type SaveGeneratedFileInput,
  saveUpload,
  type SaveUploadInput,
  type StoredFile,
  StoredFileMissingError,
} from './files/stored-files';

// Background jobs (docs/ARCHITECTURE.md#background-jobs)
export {
  describeJobError,
  isJobsConfigured,
  JobsNotConfiguredError,
  JobsUnavailableError,
  type JobsUnavailableReason,
} from './jobs/connection';
export {
  DEFAULT_JOB_ATTEMPTS,
  DEFAULT_JOB_BACKOFF,
  defineJob,
  defineSchedule,
  type JobBackoff,
  type JobDefinition,
  SCHEDULE_TIME_ZONE,
  type ScheduleDefinition,
} from './jobs/define';
export { type EnqueuedJob, enqueueJob, type EnqueueOptions } from './jobs/queue';
export {
  checkRedis,
  type JobRunState,
  type RedisHealth,
  type ScheduleInfo,
  waitForJob,
  type WorkerHeartbeat,
} from './jobs/health';
export {
  DEV_DAILY_PING_SCHEDULE,
  DEV_PING_JOB,
  DEV_SAMPLE_EXPORTS_JOB,
  devSampleExportKeys,
} from './jobs/dev-jobs';
export { type DevJobChecks, runDevJobChecks } from './jobs/dev-checks';

// Field encryption for sensitive data (SECURITY.md#sensitive-data, docs/adr/0005-field-level-encryption.md)
export { DecryptionFailedError } from './encryption/aead';
export {
  decryptSensitive,
  type EncryptedValue,
  EncryptedValueFormatError,
  encryptSensitive,
  isEncryptedValue,
  sensitiveField,
  type SensitivePlaintext,
  SensitiveValueTypeError,
} from './encryption/fields';
export {
  SensitiveFieldNotEncryptedError,
  SensitiveFieldShapeError,
  sensitivePathsOf,
} from './encryption/guard';
export {
  DataKeyInvalidError,
  DataKeyNotFoundError,
  EncryptionKeyMismatchError,
  KEY_VAULT_COLLECTION,
} from './encryption/key-vault';
export {
  EncryptionKeyInvalidError,
  EncryptionNotConfiguredError,
  isEncryptionConfigured,
} from './encryption/master-key';
export {
  revealSensitive,
  type RevealSensitiveInput,
  type SensitiveOwner,
  sensitiveLastFour,
} from './encryption/reveal';
export { checkEncryption, type EncryptionCheck, type EncryptionHealth } from './encryption/health';
export {
  DEV_SAMPLE_FIELD,
  DEV_SAMPLE_OWNER_TYPE,
  devEncryptionSampleForDisplay,
  devEncryptionSampleLastFour,
  revealDevEncryptionSample,
} from './encryption/dev-sample';

// Revealing sensitive values (SECURITY.md#sensitive-data): registered fields, the reveal rules,
// and the access-checked, audit-logged reveal.
export {
  findSensitiveReveal,
  registerSensitiveReveal,
  SENSITIVE_CATEGORIES,
  type SensitiveCategory,
  type SensitiveRevealDefinition,
  type SensitiveSubject,
} from './sensitive/registry';
export { canRevealSensitive, type RevealActor } from './sensitive/policy';
export { revealSensitiveField, type RevealSensitiveFieldInput } from './sensitive/service';

// The audit log (docs/modules/core.md#audit-log). Insert and read only; the model is never exported.
export {
  AuditEntryInvalidError,
  type AuditEntryView,
  type AuditPage,
  listAuditEntries,
  type ListAuditOptions,
  recordAudit,
  type RecordAuditInput,
} from './audit/service';
export {
  type AuditSnapshot,
  HIDDEN_REDACTED,
  HIDDEN_SENSITIVE,
  HIDDEN_SENSITIVE_CHANGED,
  redactForAudit,
  SNAPSHOT_ARRAY_MAX,
  SNAPSHOT_BYTES_MAX,
  SNAPSHOT_DEPTH_MAX,
  SNAPSHOT_STRING_MAX,
  snapshotForAudit,
  snapshotsForAudit,
} from './audit/snapshot';

// In-app notifications (docs/modules/core.md#notifications). The model is never exported.
export {
  countUnread,
  listNotifications,
  type ListNotificationsOptions,
  markAllRead,
  markRead,
  NotificationInvalidError,
  type NotificationPage,
  type NotificationView,
  notify,
  type NotifyInput,
} from './notifications/service';

// Company settings (docs/modules/core.md#company-settings-page): the details, the logo, allowed
// email domains and upload settings. System Administrator only, by role.
export {
  COMPANY_LOGO_OWNER_TYPE,
  COMPANY_LOGO_TYPES,
  COMPANY_SETTINGS_RECORD_TYPE,
  type CompanyDetailsStatus,
  companyLogoUrl,
  CompanySettingsMissingError,
  type CompanySettingsView,
  getCompanyDetailsStatus,
  getCompanyLogoFile,
  getCompanySettings,
  removeCompanyLogo,
  setCompanyLogo,
  updateCompanyDetails,
} from './company-settings/service';
export {
  COMPANY_DETAILS_PENDING_EVENT,
  COMPANY_DETAILS_REMINDER_JOB,
  COMPANY_DETAILS_REMINDER_SCHEDULE,
  type CompanyDetailsReminderResult,
  runCompanyDetailsReminder,
} from './company-settings/reminder-job';
export {
  addAllowedEmailDomain,
  ALLOWED_EMAIL_DOMAIN_RECORD_TYPE,
  type AllowedEmailDomainView,
  listAllowedEmailDomains,
  removeAllowedEmailDomain,
} from './allowed-email-domains/service';
export {
  type FileUploadSettingsInfo,
  getFileUploadSettingsInfo,
  updateFileUploadSettings,
} from './files/settings';

// Departments and positions (docs/modules/core.md#managing-departments-and-positions)
export {
  createDepartment,
  type DepartmentHeadOption,
  type DepartmentView,
  listDepartments,
  listEligibleDepartmentHeads,
  type OrgStructureActor,
  restoreDepartment,
  retireDepartment,
  updateDepartment,
} from './departments/service';
export {
  createPosition,
  listPositions,
  type PositionView,
  restorePosition,
  retirePosition,
  updatePosition,
} from './positions/service';

// User accounts and employee numbers (docs/modules/core.md#managing-user-accounts,
// #employee-number-company-id, #reporting-lines). HR and the System Administrator, by role.
export {
  changeEmploymentStatus,
  type CreatedUser,
  createUser,
  getUser,
  listUsers,
  type ListUsersOptions,
  POSITION_CHANGED_EVENT,
  resetPassword,
  setSystemAccountDisabled,
  type SupervisorView,
  type UserDetail,
  type UserListRow,
  type UserRowActions,
  updateUser,
  USER_CREATED_EVENT,
} from './users/service';
export {
  claimManualEmployeeNumber,
  EMPLOYEE_NUMBER_FIELD,
  EMPLOYEE_NUMBER_FORMAT_MESSAGE,
  EMPLOYEE_NUMBER_IN_USE_MESSAGE,
  type EmployeeNumber,
  employeeNumbersRunOutMessage,
  issueEmployeeNumber,
} from './employee-numbers/service';
export {
  type ReportingLineActor,
  resolveReportingToChange,
  sameSupervisorIds,
  setReportingLines,
  type SetReportingLinesResult,
  validateAndClaimReportingTo,
} from './employees/reporting-lines';
export { claimLiveDepartment, claimLivePosition } from './org-claims';

// User access (docs/modules/core.md#user-access-page): the access setter, the "Needs access"
// count and the daily reminder. HR and the System Administrator, by role.
export {
  countUsersNeedingAccess,
  countUsersNeedingAccessFor,
  getUserAccess,
  listUserAccess,
  type ListUserAccessOptions,
  saveUserAccess,
  type SaveUserAccessResult,
  type UserAccessDetail,
  type UserAccessList,
  type UserAccessRow,
  type UserAccessStats,
} from './access/service';
export {
  ACCESS_REMINDER_JOB,
  ACCESS_REMINDER_SCHEDULE,
  type AccessReminderResult,
  accessReminderKey,
  runAccessReminder,
  USERS_NEED_ACCESS_EVENT,
} from './access/reminder-job';

// Shared master data (docs/modules/core.md#managing-master-data, ADR 0013): clients with their
// sites and contacts, products (`brands`), catalog items and suppliers. Services only; the models
// are never exported. Each service checks Engage or Supply access itself (master-data-access.ts).
export type { MasterDataActor, MasterDataOption } from './master-data-access';
export {
  type BrandOption,
  type BrandView,
  createBrand,
  listBrandOptions,
  listBrands,
  restoreBrand,
  retireBrand,
  updateBrand,
} from './brands/service';
export {
  type CatalogItemOption,
  type CatalogItemView,
  createCatalogItem,
  listCatalogItemOptions,
  listCatalogItems,
  restoreCatalogItem,
  retireCatalogItem,
  updateCatalogItem,
} from './catalog-items/service';
export {
  createSupplier,
  listSupplierOptions,
  listSuppliers,
  restoreSupplier,
  retireSupplier,
  type SupplierContactView,
  type SupplierOption,
  type SupplierProductView,
  type SupplierView,
  updateSupplier,
} from './suppliers/service';
export {
  type AccountManagerOption,
  type ClientDetailView,
  type ClientNameMatch,
  type ClientView,
  createClient,
  findClientsNamed,
  getClient,
  listClientOptions,
  listClients,
  restoreClient,
  retireClient,
  searchEligibleAccountManagers,
  updateClient,
} from './clients/service';
export {
  addClientSite,
  type ClientSiteView,
  listClientSiteOptions,
  removeClientSite,
  restoreClientSite,
  updateClientSite,
} from './clients/sites';
export {
  addClientContact,
  type ClientContactView,
  listClientContactOptions,
  removeClientContact,
  restoreClientContact,
  updateClientContact,
} from './clients/contacts';

// The approvals engine (docs/modules/core.md#approvals, build step 1.9): registering approval
// types, submitting inside the module's transaction, deciding, the Approvals list's reads and the
// read-only approver check. Services only; the model is never exported.
export {
  APPROVAL_OUTCOME_EVENTS,
  APPROVAL_REQUESTED_EVENT,
  APPROVAL_SETTLED_EVENT,
  type ApprovalActor,
  type ApprovalDetail,
  ApprovalInvalidError,
  type ApprovalPage,
  type ApprovalRow,
  type ApprovalStepView,
  type ApprovalViewer,
  assertApproverCanView,
  countApprovalsWaiting,
  decideApproval,
  type DecidedApproval,
  getApproval,
  isApproverFor,
  listApprovalsDecided,
  listApprovalsForRecord,
  listApprovalsWaiting,
  type ListApprovalsOptions,
  oldestApprovalWaitingSubmittedAt,
  submitApproval,
  type SubmitApprovalInput,
  type SubmittedApproval,
} from './approvals/service';
export {
  type ApprovalHookContext,
  type ApprovalRequestSnapshot,
  type ApprovalStepApprovedContext,
  type ApprovalStepSpec,
  type ApprovalTypeDefinition,
  ApprovalTypeNotRegisteredError,
  type ApproverSet,
  DEV_SAMPLE_APPROVAL_RECORD_TYPE,
  DEV_SAMPLE_APPROVAL_TYPE,
  registerApprovalType,
  registerCoreApprovalTypes,
} from './approvals/registry';
export {
  activeBoardApprovers,
  activeHrApprovers,
  activeSystemAdministrators,
  type ApproverCandidate,
  NO_OTHER_SYSTEM_ADMINISTRATOR,
} from './approvals/routing';
export {
  DEV_SAMPLE_STEP_HELP,
  type DevSampleApprovalInput,
  type DevSampleApprovalResult,
  type DevSampleStep,
  parseDevSampleStep,
  submitDevSampleApproval,
} from './approvals/dev-sample';

// The holiday calendar (docs/modules/core.md#holiday-calendar, build step 1.10): the services
// behind `/holidays` (HR and the System Administrator manage, by role; everyone else reads
// confirmed holidays only), the confirmed-holidays read for other modules, the auto-draft, the
// online source, the reminder, and the holidays-changed event. Services only; the model is never
// exported.
export {
  assertCanManageHolidays,
  type ConfirmedHoliday,
  confirmHoliday,
  confirmHolidayYear,
  createHoliday,
  declareHoliday,
  deleteHoliday,
  findHolidaysOnDate,
  getHoliday,
  HOLIDAY_DECLARED_EVENT,
  HOLIDAY_RECORD_TYPE,
  type HolidayActor,
  HolidayLegalBasisMissingError,
  HOLIDAYS_HREF,
  type HolidayView,
  listConfirmedHolidays,
  listHolidays,
  listHolidayYears,
  type SameDateHoliday,
  updateHoliday,
} from './holidays/service';
export { HOLIDAY_RULES_SETTING, SEED_HOLIDAY_RULES } from './holidays/rules';
export {
  HOLIDAY_AUTO_DRAFT_JOB,
  HOLIDAY_AUTO_DRAFT_SCHEDULE,
  type HolidayAutoDraftResult,
  runHolidayAutoDraft,
  type RunHolidayAutoDraftOptions,
  runScheduledHolidayAutoDraft,
} from './holidays/auto-draft';
export {
  HOLIDAY_SOURCE_URL_ENV,
  type HolidayFetch,
  type OnlineSourceResult,
} from './holidays/online-source';
export {
  HOLIDAY_REMINDER_DECEMBER_SCHEDULE,
  HOLIDAY_REMINDER_JANUARY_FEBRUARY_SCHEDULE,
  HOLIDAY_REMINDER_JOB,
  HOLIDAY_REMINDER_SCHEDULES,
  type HolidayReminderResult,
  holidayReminderKey,
  holidayReminderYear,
  HOLIDAYS_UNCONFIRMED_EVENT,
  runHolidayReminder,
} from './holidays/reminder';
export {
  enqueueHolidaysChanged,
  HOLIDAYS_CHANGED_JOB,
  type HolidaysChangedEnqueuer,
  type HolidaysChangedEvent,
  type HolidaysChangedListener,
  type HolidaysChangedResult,
  registerHolidaysChangedListener,
  runHolidaysChangedListeners,
  setHolidaysChangedEnqueuer,
} from './holidays/events';

// The directory, org chart, Home team and command bar (docs/modules/core.md#company-directory,
// #org-chart, #home, #command-bar, build step 1.11). Open to every signed-in user; directory
// fields only (SECURITY.md#sensitive-data). Modules add command bar results through
// `registerCommandProvider` (docs/ARCHITECTURE.md#cross-module-integration).
export {
  type DirectoryViewer,
  getDirectoryPerson,
  getOwnTeam,
  listDirectory,
  listDirectoryDepartments,
  type ListDirectoryOptions,
  searchSupervisorCandidates,
} from './directory/service';
export { getOrgChart, type OrgChartOptions } from './directory/org-chart';
export {
  type CommandBarUser,
  type CommandProviderDefinition,
  type CommandSearchContext,
  normalizeCommandQuery,
  registerCommandProvider,
  searchCommands,
} from './command-bar/registry';
export { PEOPLE_PROVIDER_KEY, registerCoreCommandProviders } from './command-bar/people-provider';
