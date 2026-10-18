import { ActionError, type BusinessDate, startOfBusinessDate, toBusinessDate } from '@pulse/core';
import { decryptSensitive, encryptSensitive } from '@pulse/core/server';
import {
  CHANGE_REQUEST_SECTION_FIELDS,
  type ChangeRequestField,
  isSensitiveChangeRequestField,
  orderChangedFields,
  type OwnFieldChange,
  ownFieldChange,
  type OwnSectionSaveKind,
  ownSectionSaveKind,
} from '../../onboarding/change-requests';
import type {
  OwnBankAccountSectionInput,
  OwnGovernmentIdsSectionInput,
  OwnPersonalSectionInput,
  OwnSkillsSectionInput,
} from '../../onboarding/inputs';
import type { OwnSection } from '../../onboarding/inputs';
import type { ChangeRequestSection } from '../../fixed-sets';
import type { EmergencyContact, EmployeeRecordDocument } from '../employee-records/model';
import type { ChangeRequestValues } from './model';

// Spec: docs/modules/talent.md#onboarding-checklist-and-change-requests-build-step-26 ("What the
// employee changes themselves", "Change requests"; decisions 267 and 272 in docs/BUILD_PLAN.md) —
// how an own save compares with the stored record, field by field, and how a change request's
// values map onto the employee record. Server-only: a stored sensitive value is decrypted here
// only to tell "unchanged" from "changed" when the employee typed a value for it, and never leaves
// this module.

/** A form's new value for each field of a section; `undefined` keeps the stored value. */
export type SectionFormValues = Partial<Record<ChangeRequestField, unknown>>;

/** The change request sections each on-screen section holds, in order. */
export const OWN_SECTION_PARTS: Record<OwnSection, readonly ChangeRequestSection[]> = {
  personal: ['contact', 'personal'],
  governmentIds: ['governmentIds'],
  bankAccount: ['bankAccount'],
  skills: ['skills'],
};

/** The on-screen section a change request section is edited in. */
export function ownSectionOf(section: ChangeRequestSection): OwnSection {
  if (section === 'contact' || section === 'personal') return 'personal';
  return section;
}

function emergencyContactOf(input: OwnPersonalSectionInput): EmergencyContact | null {
  const contact = {
    name: input.emergencyContactName ?? null,
    relationship: input.emergencyContactRelationship ?? null,
    mobileNumber: input.emergencyContactMobile ?? null,
  };
  return Object.values(contact).some((value) => value !== null) ? contact : null;
}

/** The form values of one change request section, from a parsed own sheet. */
export function formValuesOf(
  section: ChangeRequestSection,
  input:
    | OwnPersonalSectionInput
    | OwnGovernmentIdsSectionInput
    | OwnBankAccountSectionInput
    | OwnSkillsSectionInput,
): SectionFormValues {
  switch (section) {
    case 'contact': {
      const values = input as OwnPersonalSectionInput;
      return {
        presentAddress: values.presentAddress,
        permanentAddress: values.permanentAddress,
        mobileNumber: values.mobileNumber,
        personalEmail: values.personalEmail,
        emergencyContact: emergencyContactOf(values),
      };
    }
    case 'personal': {
      const values = input as OwnPersonalSectionInput;
      return {
        dateOfBirth: values.dateOfBirth,
        sex: values.sex,
        civilStatus: values.civilStatus,
        nationality: values.nationality,
      };
    }
    case 'skills':
      return { skills: (input as OwnSkillsSectionInput).skills };
    case 'governmentIds': {
      const values = input as OwnGovernmentIdsSectionInput;
      return {
        tin: values.tin,
        rdoCode: values.rdoCode,
        sss: values.sss,
        philhealth: values.philhealth,
        pagibig: values.pagibig,
      };
    }
    case 'bankAccount': {
      const values = input as OwnBankAccountSectionInput;
      return {
        bank: values.bank,
        accountNumber: values.accountNumber,
        accountName: values.accountName,
      };
    }
  }
}

/** Where each field lives on the employee record. */
export const RECORD_PATHS: Record<ChangeRequestField, string> = {
  presentAddress: 'presentAddress',
  permanentAddress: 'permanentAddress',
  mobileNumber: 'mobileNumber',
  personalEmail: 'personalEmail',
  emergencyContact: 'emergencyContact',
  skills: 'skills',
  dateOfBirth: 'dateOfBirth',
  sex: 'sex',
  civilStatus: 'civilStatus',
  nationality: 'nationality',
  tin: 'governmentIds.tin',
  rdoCode: 'governmentIds.rdoCode',
  sss: 'governmentIds.sss',
  philhealth: 'governmentIds.philhealth',
  pagibig: 'governmentIds.pagibig',
  bank: 'bankAccount.bank',
  accountNumber: 'bankAccount.accountNumber',
  accountName: 'bankAccount.accountName',
};

type StoredRecord = Partial<EmployeeRecordDocument> | null;

/** The value at a dotted path of a lean record, or null. */
export function valueAt(record: unknown, path: string): unknown {
  let value: unknown = record;
  for (const key of path.split('.')) {
    if (value === null || value === undefined || typeof value !== 'object') return null;
    value = (value as Record<string, unknown>)[key];
  }
  return value ?? null;
}

/** A stored value in the form's shape (a date as its Manila day, the contact as plain fields). */
function plainStored(field: ChangeRequestField, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (field === 'dateOfBirth' && value instanceof Date) return toBusinessDate(value);
  if (field === 'emergencyContact') {
    const contact = value as Partial<EmergencyContact>;
    return {
      name: contact.name ?? null,
      relationship: contact.relationship ?? null,
      mobileNumber: contact.mobileNumber ?? null,
    };
  }
  if (field === 'skills') return [...(value as string[])];
  return value;
}

function combine(changes: OwnFieldChange[]): OwnFieldChange {
  if (changes.includes('change')) return 'change';
  return changes.includes('fill') ? 'fill' : 'unchanged';
}

/** How one field of a save compares with the stored record (sensitive values decrypted here). */
async function fieldChange(
  field: ChangeRequestField,
  stored: StoredRecord,
  next: unknown,
): Promise<OwnFieldChange> {
  if (next === undefined) return 'unchanged';
  const raw = valueAt(stored, RECORD_PATHS[field]);
  if (isSensitiveChangeRequestField(field)) {
    if (raw === null) return ownFieldChange(null, next);
    return ownFieldChange(String(await decryptSensitive(raw)), next);
  }
  const current = plainStored(field, raw);
  if (field === 'emergencyContact') {
    // Each part of the contact on its own: filling an empty part is a fill, not a change.
    const before = (current ?? {}) as Partial<EmergencyContact>;
    const after = (next ?? {}) as Partial<EmergencyContact>;
    return combine(
      (['name', 'relationship', 'mobileNumber'] as const).map((part) =>
        ownFieldChange(before[part] ?? null, after[part] ?? null),
      ),
    );
  }
  return ownFieldChange(current, next);
}

/** One change request section of a save, compared with the record. */
export interface SectionComparison {
  section: ChangeRequestSection;
  kind: OwnSectionSaveKind;
  /** The fields that fill a blank or change a value, in the section's order. */
  fields: ChangeRequestField[];
  /** The form's new values (plain), for every field of the section. */
  values: SectionFormValues;
}

/** Compares a section's form values with the stored record. */
export async function compareSection(
  section: ChangeRequestSection,
  stored: StoredRecord,
  values: SectionFormValues,
): Promise<SectionComparison> {
  const changes: { field: ChangeRequestField; change: OwnFieldChange }[] = [];
  for (const field of CHANGE_REQUEST_SECTION_FIELDS[section] as readonly ChangeRequestField[]) {
    changes.push({ field, change: await fieldChange(field, stored, values[field]) });
  }
  return {
    section,
    kind: ownSectionSaveKind(changes.map((entry) => entry.change)),
    fields: orderChangedFields(
      section,
      changes.filter((entry) => entry.change !== 'unchanged').map((entry) => entry.field),
    ),
    values,
  };
}

/** A form value as it is stored (a date at 00:00 Manila, an ID encrypted). */
async function storedFormOf(field: ChangeRequestField, value: unknown): Promise<unknown> {
  if (value === null || value === undefined) return null;
  if (isSensitiveChangeRequestField(field)) return encryptSensitive(String(value));
  if (field === 'dateOfBirth') return startOfBusinessDate(value as BusinessDate);
  return value;
}

/** The `$set` of the employee record for `fields`, from the form's values. */
export async function recordChangesOf(
  fields: readonly ChangeRequestField[],
  values: SectionFormValues,
): Promise<Record<string, unknown>> {
  const changes: Record<string, unknown> = {};
  for (const field of fields) {
    const value = await storedFormOf(field, values[field]);
    if (value === null && isSensitiveChangeRequestField(field)) continue;
    changes[RECORD_PATHS[field]] = value;
  }
  return changes;
}

/** A change request's `proposed`, from the form's values: only `fields`, stored as on the record. */
export async function proposedOf(
  fields: readonly ChangeRequestField[],
  values: SectionFormValues,
): Promise<ChangeRequestValues> {
  const proposed: Record<string, unknown> = {};
  for (const field of fields) {
    const value = await storedFormOf(field, values[field]);
    // A sensitive field is never stored as null: it is left out instead.
    if (value === null && isSensitiveChangeRequestField(field)) continue;
    proposed[field] = value;
  }
  return proposed as ChangeRequestValues;
}

const BIRTH_IN_FUTURE = 'The date of birth can’t be in the future.';

/**
 * The record's own checks that the form schema can't make alone, against the stored record: a
 * date of birth in the future, and a first bank account without its number. Throws ActionError.
 */
export function checkSectionValues(
  comparison: SectionComparison,
  stored: StoredRecord,
  today: BusinessDate,
): void {
  if (comparison.kind === 'nothing') return;
  const { section, values, fields } = comparison;
  if (section === 'personal' && fields.includes('dateOfBirth')) {
    const date = values.dateOfBirth;
    if (typeof date === 'string' && date > today) {
      throw new ActionError(BIRTH_IN_FUTURE, { field: 'dateOfBirth' });
    }
  }
  if (
    section === 'bankAccount' &&
    values.accountNumber === undefined &&
    valueAt(stored, RECORD_PATHS.accountNumber) === null
  ) {
    throw new ActionError('Enter the account number.', { field: 'accountNumber' });
  }
}
