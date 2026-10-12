// Pulse Talent's server-only services and registrations (docs/ARCHITECTURE.md#modules-and-packages).
// Import them from `@pulse/talent/server`; the pure code is in `@pulse/talent`. Services only: the
// models are never exported.

// The employee record (docs/modules/talent.md#the-employee-record-build-step-21, build step 2.1)
export {
  getEmployeeRecordView,
  getOwnRecordView,
  listEmployeeRecords,
  type ListEmployeeRecordsOptions,
  setBankAccount,
  setGovernmentIds,
  setSkills,
  updateEmployment,
  updatePersonal,
} from './employee-records/service';
export { addCompensationEntry } from './compensation/service';

// The 201 file (build step 2.2): add (optionally archiving the document a renewal replaces),
// edit the details, archive with a reason, and the gated list.
export {
  addEmployeeDocument,
  archiveEmployeeDocument,
  type DocumentsSection,
  listEmployeeDocuments,
  REPLACED_BY_RENEWAL_REASON,
  updateEmployeeDocument,
} from './documents/service';
// The e-signature (build step 2.2): owner-only upload and history, the one apply service, and the
// approval signer registration (call beside registerCoreApprovalTypes()).
export {
  applyESignature,
  type ApplyESignatureInput,
  getESignatureStatus,
  listOwnESignatures,
  registerTalentApprovalSigner,
  uploadESignature,
} from './e-signatures/service';
// Certifications (build step 2.2) and the read services for Pulse Ops and Pulse Engage.
export {
  countCertifiedEmployeesByBrand,
  createCertification,
  listCertifications,
  type ListCertificationsOptions,
  removeCertification,
  updateCertification,
} from './certifications/service';
// The expiry alerts (build step 2.2): the lead days setting and the daily job.
export {
  DEFAULT_EXPIRY_LEAD_DAYS_SETTING,
  EXPIRY_ALERTS_SETTING,
  expiryLeadDaysOn,
  type ExpiryLeadDays,
  getExpiryAlertSettings,
  updateExpiryAlertSettings,
} from './expiry-alerts/settings';
export {
  CERTIFICATION_EXPIRED_EVENT,
  CERTIFICATION_EXPIRING_EVENT,
  DOCUMENT_EXPIRED_EVENT,
  DOCUMENT_EXPIRING_EVENT,
  EXPIRY_ALERTS_JOB,
  EXPIRY_ALERTS_SCHEDULE,
  expiryAlertKey,
  type ExpiryAlertsResult,
  runExpiryAlerts,
} from './expiry-alerts/job';
// File access (build step 2.2): the file route calls this beside registerCoreFileAccess().
export { registerTalentFileAccess } from './files/registrations';

// Who may see and change what (SECURITY.md#sensitive-data). Each service checks again itself.
export {
  assertCanChangeBirthAndCivilStatus,
  assertCanChangeExpiryAlertSettings,
  assertCanChangeSensitiveDetails,
  assertCanEditCertifications,
  assertCanEditEmployeeRecord,
  assertCanManageDocuments,
  assertCanReadCertifications,
  assertCanReadEmployeeRecords,
  assertCanRemoveCertifications,
  BIRTH_AND_CIVIL_STATUS_DENIED,
  canChangeBirthAndCivilStatus,
  canChangeExpiryAlertSettings,
  canChangeSensitiveDetails,
  canEditCertifications,
  canEditEmployeeRecord,
  canEditSkills,
  canManageDocuments,
  canManageEmployeeAccount,
  canOpenCertificationAttachment,
  canReadCertifications,
  canReadEmployeeRecords,
  canRemoveCertifications,
  canSeeBirthAndCivilStatus,
  canSeeDocumentCategory,
  canSeeESignatureImage,
  canSeeSensitiveSection,
  CERTIFICATION_REMOVE_DENIED,
  CERTIFICATIONS_READ_DENIED,
  DOCUMENTS_MANAGE_DENIED,
  EXPIRY_SETTINGS_DENIED,
  NO_EMPLOYEE_SIGNATURE,
  HR_SENSITIVE_CHANGE_DENIED,
  OWN_RECORD_DENIED,
  type RecordTarget,
  SENSITIVE_CHANGE_DENIED,
  type TalentActor,
  TALENT_READ_DENIED,
  TALENT_WRITE_DENIED,
} from './policy';

// The reveals (SECURITY.md#sensitive-data): call before `revealSensitiveField`.
export { registerTalentSensitiveReveals } from './sensitive/reveals';
