import { describe, expect, it } from 'vitest';
import { ActionError } from '@pulse/core';
import {
  CHANGE_REQUEST_SECTIONS,
  CHANGE_REQUEST_STATUSES,
  isOpenChangeRequestStatus,
} from '../fixed-sets';
import {
  CHANGE_REQUEST_SECTION_FIELDS,
  CHANGE_REQUEST_SENSITIVE_FIELDS,
  changeRequestApprovers,
  changeRequestSectionOf,
  changeRequestSummary,
  changeRequestTitle,
  ownFieldChange,
  ownSaveButtonLabel,
  ownSectionSaveKind,
} from './change-requests';
import {
  assertOnboardingGate,
  checkOnboardingGate,
  ONBOARDING_GATES,
  OnboardingGateError,
  onboardingGateMessage,
} from './gates';
import { ONBOARDING_EMPLOYEE_ITEMS, ONBOARDING_HR_ITEMS } from './items';
import {
  cancelChangeRequestSchema,
  markVerifiedSchema,
  ownPersonalSectionSchema,
  ownSkillsSectionSchema,
} from './inputs';
import {
  EMPLOYEE_UPLOAD_DOCUMENT_TYPES,
  ONBOARDING_DOCUMENT_TYPES,
  onboardingSettingsSchema,
  SEED_ONBOARDING_SETTINGS,
} from './settings';
import {
  type OnboardingFilledFields,
  onboardingFilledFields,
  type OnboardingSnapshot,
  onboardingStatus,
} from './status';
import { onboardingViewOf } from './views';

// The onboarding item rules, progress and the gate map (docs/TESTING.md#onboarding-and-change-
// request-tests; decisions 257–263 and 269 in docs/BUILD_PLAN.md). Pure code: plain facts in, no
// database. "Today" is 2026-09-14, as in the timesheet tests. Made-up values only.

const TODAY = '2026-09-14';

const NOTHING_FILLED = onboardingFilledFields(null);

/** A new employee: the password changed, nothing else filled in, created by HR as usual. */
function newEmployee(overrides: Partial<OnboardingSnapshot> = {}): OnboardingSnapshot {
  return {
    today: TODAY,
    core: {
      temporaryPassword: false,
      needsAccess: true,
      hasPhoto: false,
      isBoardMember: false,
      activeSupervisorCount: 0,
      hasDepartment: true,
      hasPosition: true,
      hasEmploymentStatus: true,
    },
    filled: NOTHING_FILLED,
    governmentIdsVerified: false,
    bankAccountVerified: false,
    noSupervisorConfirmed: false,
    workRegion: 'NCR',
    ownWorkSchedule: false,
    hasESignature: false,
    hasCompensation: false,
    documents: [],
    requiredDocumentTypes: SEED_ONBOARDING_SETTINGS.requiredDocumentTypes,
    ...overrides,
  };
}

/** A full record, as stored (the sensitive fields as made-up ciphertext). */
const FULL_RECORD = {
  dateOfBirth: new Date('1995-03-01T00:00:00+08:00'),
  sex: 'female',
  civilStatus: 'single',
  nationality: 'Filipino',
  presentAddress: '1 Made-up St, Pasig',
  permanentAddress: '1 Made-up St, Pasig',
  mobileNumber: '09170000000',
  personalEmail: null,
  emergencyContact: { name: 'Rosa Garcia', relationship: 'Mother', mobileNumber: '09180000000' },
  governmentIds: {
    tin: { ciphertext: 'x' },
    rdoCode: '043',
    sss: { ciphertext: 'x' },
    philhealth: { ciphertext: 'x' },
    pagibig: { ciphertext: 'x' },
  },
  bankAccount: {
    bank: 'unionbank',
    accountNumber: { ciphertext: 'x' },
    accountName: 'Ellen Garcia',
  },
};

const LIVE_DOCUMENTS = [
  { type: 'governmentIdCopy', archived: false, expiryDate: null },
  { type: 'nbiClearance', archived: false, expiryDate: '2027-01-31' },
] as const;

/** Every employee and HR item done, IDs and bank verified. */
function completeEmployee(): OnboardingSnapshot {
  return newEmployee({
    core: { ...newEmployee().core, needsAccess: false, hasPhoto: true, activeSupervisorCount: 1 },
    filled: onboardingFilledFields(FULL_RECORD),
    governmentIdsVerified: true,
    bankAccountVerified: true,
    hasESignature: true,
    hasCompensation: true,
    documents: LIVE_DOCUMENTS,
  });
}

function filledExcept(...empty: (keyof OnboardingFilledFields)[]): OnboardingFilledFields {
  const filled = { ...onboardingFilledFields(FULL_RECORD) };
  for (const field of empty) filled[field] = false;
  return filled;
}

describe('the items and progress', () => {
  it('lists the eight employee items and the nine HR items', () => {
    const status = onboardingStatus(newEmployee());
    expect(status.employeeItems.map((item) => item.key)).toEqual([...ONBOARDING_EMPLOYEE_ITEMS]);
    expect(status.hrItems.map((item) => item.key)).toEqual([...ONBOARDING_HR_ITEMS]);
    expect(status.employeeItems.map((item) => item.label)).toEqual([
      'Change temporary password',
      'Personal info and addresses',
      'Emergency contact',
      'Government IDs',
      'Payroll bank account',
      '201 documents',
      'Profile photo',
      'E-signature',
    ]);
  });

  it('starts a new employee at 1 of 8 (the password)', () => {
    const status = onboardingStatus(newEmployee());
    expect(status.employeeProgress).toEqual({ done: 1, total: 8 });
    expect(status.states.password).toBe('done');
    expect(status.complete).toBe(false);
    expect(status.showReminder).toBe(true);
  });

  it('marks each item done when its required fields are filled in', () => {
    const status = onboardingStatus(
      newEmployee({
        core: { ...newEmployee().core, hasPhoto: true },
        filled: onboardingFilledFields(FULL_RECORD),
        hasESignature: true,
        documents: LIVE_DOCUMENTS,
      }),
    );
    expect(status.states).toMatchObject({
      personalInfo: 'done',
      emergencyContact: 'done',
      governmentIds: 'waitingForVerification',
      bankAccount: 'waitingForVerification',
      documents: 'done',
      photo: 'done',
      eSignature: 'done',
    });
    expect(status.employeeProgress).toEqual({ done: 8, total: 8 });
  });

  it('doesn’t need the personal email, but needs every other personal field', () => {
    expect(onboardingFilledFields(FULL_RECORD)).not.toHaveProperty('personalEmail');
    expect(onboardingStatus(newEmployee({ filled: filledExcept() })).states.personalInfo).toBe(
      'done',
    );
    for (const field of [
      'dateOfBirth',
      'sex',
      'civilStatus',
      'nationality',
      'presentAddress',
      'permanentAddress',
      'mobileNumber',
    ] as const) {
      const status = onboardingStatus(newEmployee({ filled: filledExcept(field) }));
      expect(status.states.personalInfo, field).toBe('todo');
    }
  });

  it('needs the emergency contact’s name, relationship and mobile number', () => {
    for (const field of [
      'emergencyContactName',
      'emergencyContactRelationship',
      'emergencyContactMobile',
    ] as const) {
      const status = onboardingStatus(newEmployee({ filled: filledExcept(field) }));
      expect(status.states.emergencyContact, field).toBe('todo');
    }
    const blankContact = onboardingFilledFields({
      ...FULL_RECORD,
      emergencyContact: { name: '  ', relationship: 'Mother', mobileNumber: '09180000000' },
    });
    expect(onboardingStatus(newEmployee({ filled: blankContact })).states.emergencyContact).toBe(
      'todo',
    );
  });

  it('stops Government IDs without the RDO code, and the bank account without its name', () => {
    const status = onboardingStatus(
      newEmployee({ filled: filledExcept('rdoCode', 'accountName') }),
    );
    expect(status.states.governmentIds).toBe('todo');
    expect(status.states.bankAccount).toBe('todo');
  });

  it('reads filled-in IDs as waiting for HR: counted for the employee, but not complete until both are verified', () => {
    const waiting = completeEmployee();
    waiting.governmentIdsVerified = false;
    const status = onboardingStatus(waiting);
    expect(status.states.governmentIds).toBe('waitingForVerification');
    expect(status.employeeItems.find((item) => item.key === 'governmentIds')?.state).toBe(
      'waitingForVerification',
    );
    expect(status.employeeProgress).toEqual({ done: 8, total: 8 });
    expect(status.showReminder).toBe(false);
    expect(status.complete).toBe(false);

    const bankWaiting = completeEmployee();
    bankWaiting.bankAccountVerified = false;
    expect(onboardingStatus(bankWaiting).complete).toBe(false);
    expect(onboardingStatus(completeEmployee()).complete).toBe(true);
  });

  it('a verification alone doesn’t mark an empty group done', () => {
    const status = onboardingStatus(
      newEmployee({ governmentIdsVerified: true, bankAccountVerified: true }),
    );
    expect(status.states.governmentIds).toBe('todo');
    expect(status.states.bankAccount).toBe('todo');
  });
});

describe('201 documents', () => {
  it('is done with a live government ID copy and NBI clearance, under the seeded setting', () => {
    expect(onboardingStatus(newEmployee({ documents: LIVE_DOCUMENTS })).states.documents).toBe(
      'done',
    );
  });

  it('doesn’t count an archived or expired document, and names what is needed', () => {
    const archived = onboardingStatus(
      newEmployee({
        documents: [LIVE_DOCUMENTS[0], { ...LIVE_DOCUMENTS[1], archived: true }],
      }),
    );
    expect(archived.states.documents).toBe('todo');
    expect(archived.employeeItems.find((item) => item.key === 'documents')?.detail).toBe(
      'Needed: NBI clearance',
    );
    // Expired on the day it expires (step 2.2's rule); valid the day before.
    const expiresToday = onboardingStatus(
      newEmployee({ documents: [LIVE_DOCUMENTS[0], { ...LIVE_DOCUMENTS[1], expiryDate: TODAY }] }),
    );
    expect(expiresToday.states.documents).toBe('todo');
    const expiresTomorrow = onboardingStatus(
      newEmployee({
        documents: [LIVE_DOCUMENTS[0], { ...LIVE_DOCUMENTS[1], expiryDate: '2026-09-15' }],
      }),
    );
    expect(expiresTomorrow.states.documents).toBe('done');
    // An expired copy beside a live one still counts.
    const renewed = onboardingStatus(
      newEmployee({
        documents: [
          ...LIVE_DOCUMENTS,
          { type: 'nbiClearance', archived: false, expiryDate: '2025-01-01' },
        ],
      }),
    );
    expect(renewed.states.documents).toBe('done');
  });

  it('is done with an empty requiredDocumentTypes', () => {
    const status = onboardingStatus(newEmployee({ requiredDocumentTypes: [] }));
    expect(status.states.documents).toBe('done');
    expect(status.employeeItems.find((item) => item.key === 'documents')?.detail).toBeNull();
  });

  it('needs every required type: one type isn’t enough for two', () => {
    const status = onboardingStatus(newEmployee({ documents: [LIVE_DOCUMENTS[1]] }));
    expect(status.employeeItems.find((item) => item.key === 'documents')?.detail).toBe(
      'Needed: Government ID copy',
    );
  });
});

describe('the HR items', () => {
  it('follows "Needs access" for module access', () => {
    expect(onboardingStatus(newEmployee()).states.moduleAccess).toBe('todo');
    const withAccess = newEmployee({ core: { ...newEmployee().core, needsAccess: false } });
    expect(onboardingStatus(withAccess).states.moduleAccess).toBe('done');
  });

  it('is done for reportingTo with one active supervisor, a Board member, or "No supervisor" confirmed', () => {
    const core = newEmployee().core;
    expect(onboardingStatus(newEmployee()).states.reportingTo).toBe('todo');
    expect(
      onboardingStatus(newEmployee({ core: { ...core, activeSupervisorCount: 1 } })).states
        .reportingTo,
    ).toBe('done');
    expect(
      onboardingStatus(newEmployee({ core: { ...core, isBoardMember: true } })).states.reportingTo,
    ).toBe('done');
    const confirmed = onboardingStatus(newEmployee({ noSupervisorConfirmed: true }));
    expect(confirmed.states.reportingTo).toBe('done');
    expect(confirmed.hrItems.find((item) => item.key === 'reportingTo')?.detail).toBe(
      'No supervisor (confirmed)',
    );
  });

  it('isn’t done with only a separated supervisor (no active one)', () => {
    // Core counts active supervisors only, so a separated one gives 0.
    const status = onboardingStatus(
      newEmployee({ core: { ...newEmployee().core, activeSupervisorCount: 0 } }),
    );
    expect(status.states.reportingTo).toBe('todo');
  });

  it('marks the work schedule and region done by default, and shows which', () => {
    const status = onboardingStatus(newEmployee());
    const detail = (key: string) => status.hrItems.find((item) => item.key === key)?.detail;
    expect(status.states.workSchedule).toBe('done');
    expect(status.states.workRegion).toBe('done');
    expect(detail('workSchedule')).toBe('Company default');
    expect(detail('workRegion')).toBe('National Capital Region (NCR)');
    const own = onboardingStatus(newEmployee({ ownWorkSchedule: true, workRegion: 'VII' }));
    expect(own.hrItems.find((item) => item.key === 'workSchedule')?.detail).toBe('Own schedule');
    expect(own.hrItems.find((item) => item.key === 'workRegion')?.detail).toBe(
      'Central Visayas (Region VII)',
    );
  });

  it('needs a compensation entry for salary and allowances', () => {
    expect(onboardingStatus(newEmployee()).states.compensation).toBe('todo');
    expect(onboardingStatus(newEmployee({ hasCompensation: true })).states.compensation).toBe(
      'done',
    );
  });

  it('keeps assets a placeholder, never counted', () => {
    const status = onboardingStatus(completeEmployee());
    expect(status.states.assets).toBe('placeholder');
    expect(status.hrItems.find((item) => item.key === 'assets')?.detail).toBe(
      'Available when Pulse Supply is set up',
    );
    expect(status.hrProgress).toEqual({ done: 8, total: 8 });
    expect(status.complete).toBe(true);
  });

  it('counts HR’s own progress without the employee items', () => {
    const status = onboardingStatus(newEmployee());
    // Department, position, employment status, work schedule and work region.
    expect(status.hrProgress).toEqual({ done: 5, total: 8 });
  });
});

describe('the reminder', () => {
  it('shows while an employee item is To do, and goes once each is done or waiting for HR', () => {
    expect(onboardingStatus(newEmployee()).showReminder).toBe(true);
    const waiting = completeEmployee();
    waiting.governmentIdsVerified = false;
    waiting.bankAccountVerified = false;
    expect(onboardingStatus(waiting).showReminder).toBe(false);
    const oneLeft = completeEmployee();
    oneLeft.hasESignature = false;
    expect(onboardingStatus(oneLeft).showReminder).toBe(true);
  });

  it('isn’t kept showing by HR items', () => {
    const snapshot = completeEmployee();
    snapshot.core = { ...snapshot.core, needsAccess: true, activeSupervisorCount: 0 };
    snapshot.hasCompensation = false;
    const status = onboardingStatus(snapshot);
    expect(status.showReminder).toBe(false);
    expect(status.complete).toBe(false);
  });
});

describe('the hidden-item view', () => {
  it('hides the state of items the viewer can’t see, and any count that includes them', () => {
    const status = onboardingStatus(completeEmployee());
    const view = onboardingViewOf(status, ['governmentIds', 'bankAccount', 'compensation']);
    const ids = view.employeeItems.find((item) => item.key === 'governmentIds');
    expect(ids).toEqual({
      key: 'governmentIds',
      label: 'Government IDs',
      state: 'hidden',
      detail: null,
    });
    expect(view.employeeProgress).toBeNull();
    expect(view.hrProgress).toBeNull();
    expect(view.complete).toBeNull();
    expect(view.showReminder).toBeNull();
    expect(view.employeeItems.find((item) => item.key === 'photo')?.state).toBe('done');
  });

  it('keeps everything for a viewer who sees every section', () => {
    const status = onboardingStatus(newEmployee());
    const view = onboardingViewOf(status);
    expect(view.employeeProgress).toEqual(status.employeeProgress);
    expect(view.complete).toBe(false);
    expect(view.showReminder).toBe(true);
  });
});

describe('the gate map', () => {
  it('has exactly the three gates and their items', () => {
    expect(ONBOARDING_GATES).toEqual({
      applyESignature: ['eSignature'],
      fileTimeRequest: ['reportingTo'],
      includeInPayroll: ['governmentIds', 'bankAccount'],
    });
  });

  it('names the missing items in the map’s order', () => {
    const status = onboardingStatus(newEmployee());
    expect(checkOnboardingGate('applyESignature', status)).toEqual(['eSignature']);
    expect(checkOnboardingGate('fileTimeRequest', status)).toEqual(['reportingTo']);
    expect(checkOnboardingGate('includeInPayroll', status)).toEqual([
      'governmentIds',
      'bankAccount',
    ]);
    expect(checkOnboardingGate('applyESignature', onboardingStatus(completeEmployee()))).toEqual(
      [],
    );
  });

  it('reports a complete but unverified bank account as missing for payroll', () => {
    const snapshot = completeEmployee();
    snapshot.bankAccountVerified = false;
    const status = onboardingStatus(snapshot);
    expect(checkOnboardingGate('includeInPayroll', status)).toEqual(['bankAccount']);
    expect(onboardingGateMessage(['bankAccount'], status)).toBe(
      'Complete this onboarding item first: Payroll bank account. Ask HR to verify it.',
    );
  });

  it('takes just the states a caller knows; an item left out is missing', () => {
    expect(checkOnboardingGate('applyESignature', { states: { eSignature: 'done' } })).toEqual([]);
    expect(checkOnboardingGate('applyESignature', { states: {} })).toEqual(['eSignature']);
  });

  it('words the refusal for one item and for several, as the spec does', () => {
    expect(onboardingGateMessage(['eSignature'])).toBe(
      'Complete this onboarding item first: E-signature. Upload it in My record, then try again.',
    );
    expect(onboardingGateMessage(['reportingTo'])).toBe(
      'Complete this onboarding item first: Reports to. Ask HR to set it.',
    );
    expect(onboardingGateMessage(['governmentIds', 'bankAccount'])).toBe(
      'Complete these onboarding items first: Government IDs, Payroll bank account.',
    );
  });

  it('throws OnboardingGateError, an ActionError carrying the keys', () => {
    const status = onboardingStatus(newEmployee());
    let thrown: unknown;
    try {
      assertOnboardingGate('applyESignature', status);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OnboardingGateError);
    expect(thrown).toBeInstanceOf(ActionError);
    expect((thrown as OnboardingGateError).message).toBe(
      'Complete this onboarding item first: E-signature. Upload it in My record, then try again.',
    );
    expect((thrown as OnboardingGateError).items).toEqual(['eSignature']);
    expect((thrown as OnboardingGateError).gate).toBe('applyESignature');
    expect(() =>
      assertOnboardingGate('applyESignature', onboardingStatus(completeEmployee())),
    ).not.toThrow();
  });
});

describe('the onboarding setting', () => {
  it('seeds a government ID copy and an NBI clearance', () => {
    expect(onboardingSettingsSchema.parse(SEED_ONBOARDING_SETTINGS)).toEqual({
      requiredDocumentTypes: ['governmentIdCopy', 'nbiClearance'],
    });
  });

  it('refuses the employment contract, the regularization evaluation, "other" and repeats', () => {
    for (const type of ['employmentContract', 'regularizationEvaluation', 'other']) {
      expect(
        onboardingSettingsSchema.safeParse({ requiredDocumentTypes: [type] }).success,
        type,
      ).toBe(false);
    }
    expect(
      onboardingSettingsSchema.safeParse({
        requiredDocumentTypes: ['nbiClearance', 'nbiClearance'],
      }).success,
    ).toBe(false);
    expect(onboardingSettingsSchema.safeParse({ requiredDocumentTypes: ['made-up'] }).success).toBe(
      false,
    );
  });

  it('accepts an empty list, and the checkboxes’ one value or none', () => {
    expect(onboardingSettingsSchema.parse({ requiredDocumentTypes: [] })).toEqual({
      requiredDocumentTypes: [],
    });
    expect(onboardingSettingsSchema.parse({})).toEqual({ requiredDocumentTypes: [] });
    expect(onboardingSettingsSchema.parse({ requiredDocumentTypes: 'medicalCertificate' })).toEqual(
      { requiredDocumentTypes: ['medicalCertificate'] },
    );
  });

  it('lets employees upload every type but the two HR issues', () => {
    expect(EMPLOYEE_UPLOAD_DOCUMENT_TYPES).toEqual([
      'governmentIdCopy',
      'nbiClearance',
      'medicalCertificate',
      'diplomaTor',
      'other',
    ]);
    expect(ONBOARDING_DOCUMENT_TYPES).toEqual([
      'governmentIdCopy',
      'nbiClearance',
      'medicalCertificate',
      'diplomaTor',
    ]);
  });
});

describe('change request sections', () => {
  it('has the five sections, each field in exactly one', () => {
    expect([...CHANGE_REQUEST_SECTIONS]).toEqual([
      'contact',
      'skills',
      'personal',
      'governmentIds',
      'bankAccount',
    ]);
    const all = CHANGE_REQUEST_SECTIONS.flatMap((section) => [
      ...CHANGE_REQUEST_SECTION_FIELDS[section],
    ]);
    expect(new Set(all).size).toBe(all.length);
    expect(changeRequestSectionOf('mobileNumber')).toBe('contact');
    expect(changeRequestSectionOf('civilStatus')).toBe('personal');
    expect(changeRequestSectionOf('accountNumber')).toBe('bankAccount');
    expect([...CHANGE_REQUEST_SENSITIVE_FIELDS]).toEqual([
      'tin',
      'sss',
      'philhealth',
      'pagibig',
      'accountNumber',
    ]);
  });

  it('routes each section to its approvers', () => {
    expect(changeRequestApprovers('contact', false)).toBe('supervisorsAndHr');
    expect(changeRequestApprovers('skills', true)).toBe('supervisorsAndHr');
    expect(changeRequestApprovers('personal', false)).toBe('hr');
    expect(changeRequestApprovers('personal', true)).toBe('hr');
    expect(changeRequestApprovers('governmentIds', false)).toBe('hr');
    expect(changeRequestApprovers('governmentIds', true)).toBe('board');
    expect(changeRequestApprovers('bankAccount', true)).toBe('board');
  });

  it('titles and summarizes a request with labels only, in the section’s order', () => {
    expect(changeRequestTitle('contact', 'Ellen', 'Garcia')).toBe(
      'Change request: Contact details · Ellen Garcia',
    );
    expect(
      changeRequestSummary('contact', ['mobileNumber', 'presentAddress', 'mobileNumber']),
    ).toBe('Fields: present address, mobile number');
    expect(changeRequestSummary('governmentIds', ['sss', 'tin'])).toBe('Fields: TIN, SSS number');
  });

  it('has the five statuses, two of them open', () => {
    expect([...CHANGE_REQUEST_STATUSES]).toEqual([
      'pending',
      'returned',
      'approved',
      'rejected',
      'cancelled',
    ]);
    expect(CHANGE_REQUEST_STATUSES.filter(isOpenChangeRequestStatus)).toEqual([
      'pending',
      'returned',
    ]);
  });
});

describe('own entries: fill or change', () => {
  it('saves a blank filled in, and sends a changed or cleared value for approval', () => {
    expect(ownFieldChange(null, '09170000000')).toBe('fill');
    expect(ownFieldChange('', 'Filipino')).toBe('fill');
    expect(ownFieldChange('09170000000', '09170000000')).toBe('unchanged');
    expect(ownFieldChange('09170000000', '09171111111')).toBe('change');
    expect(ownFieldChange('09170000000', null)).toBe('change');
    expect(ownFieldChange(null, null)).toBe('unchanged');
    // A blank sensitive input keeps the stored value.
    expect(ownFieldChange(true, undefined)).toBe('unchanged');
    expect(ownFieldChange(true, '123456789')).toBe('change');
    expect(ownFieldChange([], ['Cisco'])).toBe('fill');
    expect(ownFieldChange(['Cisco'], ['Cisco', 'Fortinet'])).toBe('change');
    expect(
      ownFieldChange(
        { name: null, relationship: null, mobileNumber: null },
        { name: 'Rosa', relationship: 'Mother', mobileNumber: null },
      ),
    ).toBe('fill');
  });

  it('decides the save: blanks only save, any change sends, nothing changed is nothing', () => {
    expect(ownSectionSaveKind(['fill', 'unchanged'])).toBe('save');
    expect(ownSectionSaveKind(['fill', 'change'])).toBe('sendForApproval');
    expect(ownSectionSaveKind(['unchanged'])).toBe('nothing');
    expect(ownSaveButtonLabel(['save', 'nothing'])).toBe('Save');
    expect(ownSaveButtonLabel(['save', 'sendForApproval'])).toBe('Send for approval');
  });

  it('takes no employee id on the own sheets', () => {
    const parsed = ownPersonalSectionSchema.parse({
      employeeId: '0123456789abcdef01234567',
      version: '0',
      sex: '',
      nationality: '',
      presentAddress: '',
      permanentAddress: '',
      mobileNumber: '0917 000 0000',
      personalEmail: '',
      emergencyContactName: '',
      emergencyContactRelationship: '',
      emergencyContactMobile: '',
      note: '  New number  ',
    });
    expect(parsed).not.toHaveProperty('employeeId');
    expect(parsed.mobileNumber).toBe('09170000000');
    expect(parsed.note).toBe('New number');
    expect(
      ownSkillsSectionSchema.safeParse({ version: 1, skills: 'a', note: 'x'.repeat(501) }).success,
    ).toBe(false);
  });

  it('parses the verification and cancel inputs', () => {
    expect(
      markVerifiedSchema.safeParse({
        employeeId: '0123456789abcdef01234567',
        version: 3,
        group: 'bankAccount',
      }).success,
    ).toBe(true);
    expect(
      markVerifiedSchema.safeParse({
        employeeId: '0123456789abcdef01234567',
        version: 3,
        group: 'compensation',
      }).success,
    ).toBe(false);
    expect(cancelChangeRequestSchema.safeParse({ changeRequestId: 'nope' }).success).toBe(false);
  });
});
