// Spec: docs/modules/talent.md#onboarding-checklist-and-change-requests-build-step-26 ("The
// checklist"; decisions 257 and 258 in docs/BUILD_PLAN.md) — the onboarding checklist's items, in
// the order the checklist shows them. Pure code, safe in the browser.

/** The eight employee items, in the checklist's order. All are counted in the progress. */
export const ONBOARDING_EMPLOYEE_ITEMS = [
  'password',
  'personalInfo',
  'emergencyContact',
  'governmentIds',
  'bankAccount',
  'documents',
  'photo',
  'eSignature',
] as const;
export type OnboardingEmployeeItem = (typeof ONBOARDING_EMPLOYEE_ITEMS)[number];

/** The nine HR items (status only for the employee). `assets` is a placeholder, never counted. */
export const ONBOARDING_HR_ITEMS = [
  'moduleAccess',
  'department',
  'position',
  'reportingTo',
  'employmentStatus',
  'workSchedule',
  'workRegion',
  'compensation',
  'assets',
] as const;
export type OnboardingHrItem = (typeof ONBOARDING_HR_ITEMS)[number];

export type OnboardingItemKey = OnboardingEmployeeItem | OnboardingHrItem;
export const ONBOARDING_ITEMS: readonly OnboardingItemKey[] = [
  ...ONBOARDING_EMPLOYEE_ITEMS,
  ...ONBOARDING_HR_ITEMS,
];

/** The items that are placeholders until a later module is built. */
export const ONBOARDING_PLACEHOLDER_ITEMS = [
  'assets',
] as const satisfies readonly OnboardingHrItem[];

export function isOnboardingEmployeeItem(key: OnboardingItemKey): key is OnboardingEmployeeItem {
  return (ONBOARDING_EMPLOYEE_ITEMS as readonly string[]).includes(key);
}

export const ONBOARDING_ITEM_LABELS: Record<OnboardingItemKey, string> = {
  password: 'Change temporary password',
  personalInfo: 'Personal info and addresses',
  emergencyContact: 'Emergency contact',
  governmentIds: 'Government IDs',
  bankAccount: 'Payroll bank account',
  documents: '201 documents',
  photo: 'Profile photo',
  eSignature: 'E-signature',
  moduleAccess: 'Module access',
  department: 'Department',
  position: 'Position',
  reportingTo: 'Reports to',
  employmentStatus: 'Employment status',
  workSchedule: 'Work schedule',
  workRegion: 'Work region',
  compensation: 'Salary and allowances',
  assets: 'Company-issued assets',
};

/**
 * An item's state:
 * - `done`
 * - `todo` ("To do")
 * - `waitingForVerification` ("Waiting for HR to verify"): government IDs or the bank account,
 *   filled in but not verified. It counts as done for the employee's progress and the reminder,
 *   but not for onboarding being complete or for the payroll gate
 * - `placeholder`: company-issued assets, until Pulse Supply
 */
export const ONBOARDING_ITEM_STATES = [
  'done',
  'todo',
  'waitingForVerification',
  'placeholder',
] as const;
export type OnboardingItemState = (typeof ONBOARDING_ITEM_STATES)[number];
export const ONBOARDING_ITEM_STATE_LABELS: Record<OnboardingItemState, string> = {
  done: 'Done',
  todo: 'To do',
  waitingForVerification: 'Waiting for HR to verify',
  placeholder: 'Available when Pulse Supply is set up',
};

/** The assets row's line, until Pulse Supply. */
export const ASSETS_PLACEHOLDER_NOTE = 'Available when Pulse Supply is set up';
/**
 * The line the inspector shows instead of the state of an item about a section the viewer can't
 * see (government IDs, bank account, salary, 201 documents).
 */
export const ONBOARDING_HIDDEN_ITEM_NOTICE =
  'Visible to HR, Accounting and the System Administrator';

/**
 * Where to complete an item, for the gate's message ("Complete this onboarding item first:
 * <item>. <where>"). An employee item says where to do it; an HR item asks HR.
 */
export const ONBOARDING_ITEM_WHERE: Record<OnboardingItemKey, string> = {
  password: 'Change it from your account menu, then try again.',
  personalInfo: 'Fill it in in My record, then try again.',
  emergencyContact: 'Fill it in in My record, then try again.',
  governmentIds: 'Fill them in in My record, then try again.',
  bankAccount: 'Fill it in in My record, then try again.',
  documents: 'Upload them in My record, then try again.',
  photo: 'Add it in My record, then try again.',
  eSignature: 'Upload it in My record, then try again.',
  moduleAccess: 'Ask HR to set it.',
  department: 'Ask HR to set it.',
  position: 'Ask HR to set it.',
  reportingTo: 'Ask HR to set it.',
  employmentStatus: 'Ask HR to set it.',
  workSchedule: 'Ask HR to set it.',
  workRegion: 'Ask HR to set it.',
  compensation: 'Ask HR to set it.',
  assets: 'Ask HR to set it.',
};
/**
 * `<where>` for an item filled in but not yet verified (government IDs or the bank account).
 * *Assumption*: the spec gives no wording for this case.
 */
export const ONBOARDING_VERIFY_WHERE: Partial<Record<OnboardingItemKey, string>> = {
  governmentIds: 'Ask HR to verify them.',
  bankAccount: 'Ask HR to verify it.',
};
