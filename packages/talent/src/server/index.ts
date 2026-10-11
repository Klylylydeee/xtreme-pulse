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
  updateEmployment,
  updatePersonal,
} from './employee-records/service';
export { addCompensationEntry } from './compensation/service';

// Who may see and change what (SECURITY.md#sensitive-data). Each service checks again itself.
export {
  assertCanChangeBirthAndCivilStatus,
  assertCanChangeSensitiveDetails,
  assertCanEditEmployeeRecord,
  assertCanReadEmployeeRecords,
  BIRTH_AND_CIVIL_STATUS_DENIED,
  canChangeBirthAndCivilStatus,
  canChangeSensitiveDetails,
  canEditEmployeeRecord,
  canManageEmployeeAccount,
  canReadEmployeeRecords,
  canSeeBirthAndCivilStatus,
  canSeeSensitiveSection,
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
