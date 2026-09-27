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
} from './auth/authenticate';
export { changePassword } from './auth/change-password';
export {
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
export { type CurrentUser, isSessionCurrent, loadSessionUser } from './auth/session-user';
export { checkEmailDomain, type EmailDomainCheck } from './allowed-email-domains/service';

export {
  checkSharedHelpers,
  type HelperCheck,
  type HelperGroup,
  type SharedHelpersHealth,
} from './dev-health';

// File storage (docs/ARCHITECTURE.md#file-storage)
export { assertFileRouteOpen, authorizeFileAccess } from './files/access';
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
export { SensitiveFieldNotEncryptedError, SensitiveFieldShapeError } from './encryption/guard';
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
export { devEncryptionSampleLastFour, revealDevEncryptionSample } from './encryption/dev-sample';
