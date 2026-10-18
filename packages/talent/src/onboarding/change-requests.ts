import { CHANGE_REQUEST_SECTION_LABELS, type ChangeRequestSection } from '../fixed-sets';

// Spec: docs/modules/talent.md#onboarding-checklist-and-change-requests-build-step-26 ("Change
// requests"; decisions 267, 269, 271 and 272 in docs/BUILD_PLAN.md) and
// docs/DATA_MODEL.md#collection-ownership (`changeRequests`) — each change request section's
// fields, who approves it, the approval's title and summary, and whether an own save fills blanks
// or changes filled-in values. Pure code, safe in the browser: the sheet's "Save" or "Send for
// approval" and the services use the same rules. Titles and summaries name fields, never values.

/** The fields of each section, in `proposed`'s shape (the employee record's field names). */
export const CHANGE_REQUEST_SECTION_FIELDS = {
  contact: [
    'presentAddress',
    'permanentAddress',
    'mobileNumber',
    'personalEmail',
    'emergencyContact',
  ],
  skills: ['skills'],
  personal: ['dateOfBirth', 'sex', 'civilStatus', 'nationality'],
  governmentIds: ['tin', 'rdoCode', 'sss', 'philhealth', 'pagibig'],
  bankAccount: ['bank', 'accountNumber', 'accountName'],
} as const satisfies Record<ChangeRequestSection, readonly string[]>;

export type ChangeRequestField =
  (typeof CHANGE_REQUEST_SECTION_FIELDS)[ChangeRequestSection][number];
export type ChangeRequestSectionField<S extends ChangeRequestSection> =
  (typeof CHANGE_REQUEST_SECTION_FIELDS)[S][number];

/** The fields stored as `sensitiveField()`s, masked (last 4) with Reveal. */
export const CHANGE_REQUEST_SENSITIVE_FIELDS = [
  'tin',
  'sss',
  'philhealth',
  'pagibig',
  'accountNumber',
] as const satisfies readonly ChangeRequestField[];
export type ChangeRequestSensitiveField = (typeof CHANGE_REQUEST_SENSITIVE_FIELDS)[number];

export function isSensitiveChangeRequestField(
  field: ChangeRequestField,
): field is ChangeRequestSensitiveField {
  return (CHANGE_REQUEST_SENSITIVE_FIELDS as readonly string[]).includes(field);
}

/** The section a field belongs to. */
export function changeRequestSectionOf(field: ChangeRequestField): ChangeRequestSection {
  for (const [section, fields] of Object.entries(CHANGE_REQUEST_SECTION_FIELDS)) {
    if ((fields as readonly string[]).includes(field)) return section as ChangeRequestSection;
  }
  throw new Error(`"${field}" is not a change request field.`);
}

export function isChangeRequestField(
  section: ChangeRequestSection,
  field: string,
): field is ChangeRequestField {
  return (CHANGE_REQUEST_SECTION_FIELDS[section] as readonly string[]).includes(field);
}

export const CHANGE_REQUEST_FIELD_LABELS: Record<ChangeRequestField, string> = {
  presentAddress: 'Present address',
  permanentAddress: 'Permanent address',
  mobileNumber: 'Mobile number',
  personalEmail: 'Personal email',
  emergencyContact: 'Emergency contact',
  skills: 'Skills',
  dateOfBirth: 'Date of birth',
  sex: 'Sex',
  civilStatus: 'Civil status',
  nationality: 'Nationality',
  tin: 'TIN',
  rdoCode: 'RDO code',
  sss: 'SSS number',
  philhealth: 'PhilHealth PIN',
  pagibig: 'Pag-IBIG MID',
  bank: 'Bank',
  accountNumber: 'Account number',
  accountName: 'Account name',
};

/** The labels inside a sentence ("Fields: present address, mobile number"). */
const FIELD_SUMMARY_LABELS: Record<ChangeRequestField, string> = {
  presentAddress: 'present address',
  permanentAddress: 'permanent address',
  mobileNumber: 'mobile number',
  personalEmail: 'personal email',
  emergencyContact: 'emergency contact',
  skills: 'skills',
  dateOfBirth: 'date of birth',
  sex: 'sex',
  civilStatus: 'civil status',
  nationality: 'nationality',
  tin: 'TIN',
  rdoCode: 'RDO code',
  sss: 'SSS number',
  philhealth: 'PhilHealth PIN',
  pagibig: 'Pag-IBIG MID',
  bank: 'bank',
  accountNumber: 'account number',
  accountName: 'account name',
};

/** `changedFields` in the section's order, without repeats. */
export function orderChangedFields(
  section: ChangeRequestSection,
  fields: Iterable<ChangeRequestField>,
): ChangeRequestField[] {
  const given = new Set<string>(fields);
  return (CHANGE_REQUEST_SECTION_FIELDS[section] as readonly ChangeRequestField[]).filter((field) =>
    given.has(field),
  );
}

/** The approval's title: "Change request: Contact details · Ellen Garcia". Never a value. */
export function changeRequestTitle(
  section: ChangeRequestSection,
  firstName: string,
  lastName: string,
): string {
  return `Change request: ${CHANGE_REQUEST_SECTION_LABELS[section]} · ${firstName} ${lastName}`;
}

/** The approval's summary: "Fields: present address, mobile number" (labels only). */
export function changeRequestSummary(
  section: ChangeRequestSection,
  changedFields: Iterable<ChangeRequestField>,
): string {
  const labels = orderChangedFields(section, changedFields).map(
    (field) => FIELD_SUMMARY_LABELS[field],
  );
  return `Fields: ${labels.join(', ')}`;
}

/** The change request page and its approval link. */
export function changeRequestHref(changeRequestId: string): string {
  return `/talent/change-requests/${changeRequestId}`;
}

/**
 * Who approves a section, as the routing names them (any one of):
 * - `supervisorsAndHr`: the employee's active `reportingTo` supervisors and every active HR user
 * - `hr`: every active HR user
 * - `board`: every active Board member (an HR employee's government IDs and bank account)
 *
 * The requester is never an approver; an empty step goes to the System Administrators.
 */
export type ChangeRequestApprovers = 'supervisorsAndHr' | 'hr' | 'board';

/** The approvers of `section` for an employee, by whether they are in the HR department now. */
export function changeRequestApprovers(
  section: ChangeRequestSection,
  employeeInHr: boolean,
): ChangeRequestApprovers {
  switch (section) {
    case 'contact':
    case 'skills':
      return 'supervisorsAndHr';
    case 'personal':
      return 'hr';
    case 'governmentIds':
    case 'bankAccount':
      return employeeInHr ? 'board' : 'hr';
  }
}

const APPROVERS_TEXT: Record<ChangeRequestApprovers, string> = {
  supervisorsAndHr: 'your supervisor or HR',
  hr: 'HR',
  board: 'a Board member',
};

/**
 * The Edit sheet's footer on /talent/me: "Empty fields are saved straight away. Changes to
 * filled-in fields go to <approvers> for approval."
 */
export function ownEditFooter(approvers: ChangeRequestApprovers): string {
  return `Empty fields are saved straight away. Changes to filled-in fields go to ${APPROVERS_TEXT[approvers]} for approval.`;
}

/** The Approvals inspector's line on a change request. */
export function changeRequestApprovalNotice(
  employeeName: string,
  section: ChangeRequestSection,
): string {
  const marksVerified = section === 'governmentIds' || section === 'bankAccount';
  return marksVerified
    ? `Approving applies the change to ${employeeName}’s record and marks these details verified.`
    : `Approving applies the change to ${employeeName}’s record.`;
}

/** The note an employee may add: up to 500 characters. */
export const CHANGE_REQUEST_NOTE_MAX_LENGTH = 500;

/** /talent/me's Edit when the section has an open request. */
export const CHANGE_REQUEST_PENDING_NOTICE = 'A change to this section is waiting for approval';
export const CHANGE_REQUEST_RETURNED_NOTICE = 'A change to this section was returned';
/** Sending for a section that already has an open request. */
export const CHANGE_REQUEST_ALREADY_OPEN =
  'A change to this section is already waiting for approval. Open it from My record.';
/** A save that changes nothing. */
export const CHANGE_REQUEST_NOTHING_CHANGED = 'Nothing changed. Edit a field, then save.';
/** The hook's refusal when the approver may no longer approve: "<reason>" filled in. */
export function changeRequestNoLongerApprovable(reason: string): string {
  return `This change can no longer be approved by you: ${reason}. Return it instead.`;
}
/** The audit label of a change request: "<employee number> · <section label>". */
export function changeRequestAuditLabel(
  employeeNumber: string,
  section: ChangeRequestSection,
): string {
  return `${employeeNumber} · ${CHANGE_REQUEST_SECTION_LABELS[section]}`;
}

// ---------------------------------------------------------------------------------------------
// Own entries: fill a blank, or change a filled-in value (decision 267).

/**
 * How one field of an own save compares with the record:
 * - `unchanged`: the same value, or the field wasn't sent (`undefined`: a blank sensitive input
 *   keeps the stored value)
 * - `fill`: the record's field is empty and the save gives a value: saved straight away
 * - `change`: the record's field holds a value and the save changes or clears it: a change request
 */
export type OwnFieldChange = 'unchanged' | 'fill' | 'change';

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object' && !(value instanceof Date)) {
    return Object.values(value as Record<string, unknown>).every(isEmptyValue);
  }
  return false;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (isEmptyValue(a) && isEmptyValue(b)) return true;
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => sameValue(item, b[index]))
    );
  }
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((key) =>
      sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    );
  }
  return a === b;
}

/**
 * Compares one field. Pass plain values (a parsed form value and the stored value decrypted, or
 * for a sensitive field the stored value as `true` for "set" when the sheet can't hold it: any
 * typed value then counts as a change, and the server decides again with the real value).
 * Objects (the emergency contact) compare by their fields; an object whose fields are all empty is
 * empty.
 */
export function ownFieldChange(current: unknown, next: unknown): OwnFieldChange {
  if (next === undefined) return 'unchanged';
  if (sameValue(current, next)) return 'unchanged';
  return isEmptyValue(current) ? 'fill' : 'change';
}

/**
 * What an own save of one section does: `save` when it only fills blanks, `sendForApproval` when
 * it changes or clears any filled-in field (the blanks it fills go with the request), `nothing`
 * when no field changes.
 */
export type OwnSectionSaveKind = 'save' | 'sendForApproval' | 'nothing';

export function ownSectionSaveKind(changes: Iterable<OwnFieldChange>): OwnSectionSaveKind {
  let kind: OwnSectionSaveKind = 'nothing';
  for (const change of changes) {
    if (change === 'change') return 'sendForApproval';
    if (change === 'fill') kind = 'save';
  }
  return kind;
}

/** The sheet's button: "Save" or "Send for approval". */
export function ownSaveButtonLabel(kinds: Iterable<OwnSectionSaveKind>): string {
  for (const kind of kinds) if (kind === 'sendForApproval') return 'Send for approval';
  return 'Save';
}
