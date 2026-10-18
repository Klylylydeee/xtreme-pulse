import type { BusinessDate } from '@pulse/core';
import type { ChangeRequestSection, ChangeRequestStatus, Document201Type } from '../fixed-sets';
import type { MaskedDigitsView } from '../views';
import type { ChangeRequestApprovers, ChangeRequestField } from './change-requests';
import type { OnboardingItemKey, OnboardingItemState } from './items';
import type { OnboardingItemStatus, OnboardingProgress, OnboardingStatus } from './status';

// Spec: docs/modules/talent.md#onboarding-checklist-and-change-requests-build-step-26 ("Screens",
// "Who sees a change request"; decisions 274 and 275 in docs/BUILD_PLAN.md) — what the onboarding,
// change request and setting services send to the pages. Types and one pure redaction, safe in
// the browser.

/** An item as a viewer sees it: `hidden` when it is about a section they can't see. */
export interface OnboardingItemView {
  key: OnboardingItemKey;
  label: string;
  state: OnboardingItemState | 'hidden';
  detail: string | null;
}

/** The checklist, own (`/talent/onboarding`) or in the inspector's Onboarding section. */
export interface OnboardingView {
  employeeItems: OnboardingItemView[];
  hrItems: OnboardingItemView[];
  /** Null when an item it counts is hidden from the viewer, so the count can't give it away. */
  employeeProgress: OnboardingProgress | null;
  hrProgress: OnboardingProgress | null;
  complete: boolean | null;
  /** The reminder's condition; null with a hidden employee item, as for the progress. */
  showReminder: boolean | null;
}

/** The own checklist's extra controls. */
export interface OwnOnboardingView extends OnboardingView {
  /** The 201 document types the employee may upload. */
  uploadTypes: Document201Type[];
}

/** The inspector's Onboarding section. */
export interface EmployeeOnboardingView extends OnboardingView {
  /** "Confirm no supervisor" or "Withdraw" (HR, a Board member or the System Administrator). */
  noSupervisor: {
    confirmed: { at: Date; byName: string } | null;
    /** Shown only while `reportingTo` has no active supervisor. */
    canConfirm: boolean;
    canWithdraw: boolean;
  };
}

/**
 * The status as a viewer may see it: the items in `hidden` show "hidden" instead of their state
 * and detail, and any progress, completion or reminder they count becomes null.
 */
export function onboardingViewOf(
  status: OnboardingStatus,
  hidden: Iterable<OnboardingItemKey> = [],
): OnboardingView {
  const hide = new Set(hidden);
  const view = (item: OnboardingItemStatus): OnboardingItemView =>
    hide.has(item.key)
      ? { key: item.key, label: item.label, state: 'hidden', detail: null }
      : { ...item };
  const employeeHidden = status.employeeItems.some((item) => hide.has(item.key));
  const hrHidden = status.hrItems.some(
    (item) => item.state !== 'placeholder' && hide.has(item.key),
  );
  return {
    employeeItems: status.employeeItems.map(view),
    hrItems: status.hrItems.map(view),
    employeeProgress: employeeHidden ? null : { ...status.employeeProgress },
    hrProgress: hrHidden ? null : { ...status.hrProgress },
    complete: employeeHidden || hrHidden ? null : status.complete,
    showReminder: employeeHidden ? null : status.showReminder,
  };
}

/** The verification badge in Government IDs and Payroll bank account. */
export type VerificationView = { verifiedAt: Date; verifiedByName: string } | null;

/** "Verified by <name> on <date>" or "Not verified" (`<date>` already formatted). */
export function verificationBadgeText(
  verification: { verifiedByName: string } | null,
  formattedDate?: string,
): string {
  if (!verification) return 'Not verified';
  return formattedDate
    ? `Verified by ${verification.verifiedByName} on ${formattedDate}`
    : `Verified by ${verification.verifiedByName}`;
}

/** One changed field on the change request page. */
export interface ChangeRequestFieldView {
  field: ChangeRequestField;
  label: string;
  /** Before approval: the record's current value; after: the previous value. Display text. */
  current: string | null;
  /** Before approval: the proposed value; after: the applied value. Display text. */
  proposed: string | null;
  /**
   * A government ID number or the account number: `current` and `proposed` are null, and the
   * masked values (last 4, with their Reveal targets) are in `currentMasked` and `proposedMasked`.
   */
  sensitive: boolean;
  /** For a sensitive field: the current (or previous) value masked, or null when there is none. */
  currentMasked?: MaskedDigitsView | null;
  /** For a sensitive field: the proposed (or applied) value masked. */
  proposedMasked?: MaskedDigitsView | null;
}

/** `/talent/change-requests/<id>`. */
export interface ChangeRequestView {
  id: string;
  employee: { id: string; name: string; employeeNumber: string };
  section: ChangeRequestSection;
  sectionLabel: string;
  status: ChangeRequestStatus;
  statusLabel: string;
  sentAt: Date;
  note: string | null;
  fields: ChangeRequestFieldView[];
  /** The approver's remarks on a returned or rejected request. */
  remarks: string | null;
  decided: { at: Date; byName: string } | null;
  /** `/approvals?request=<id>`. */
  approvalHref: string;
  /** May reveal the masked values (audit-logged as `talent.changeRequest`). */
  canReveal: boolean;
}

/** A row of the employee's own Change requests list on /talent/me, newest first. */
export interface OwnChangeRequestListItem {
  id: string;
  section: ChangeRequestSection;
  sectionLabel: string;
  status: ChangeRequestStatus;
  statusLabel: string;
  sentAt: Date;
  /** "Fields: present address, mobile number". */
  summary: string;
  remarks: string | null;
  /** A returned request: "Edit and send again" and "Cancel request". */
  canResend: boolean;
  canCancel: boolean;
}

/** An own Edit sheet's state on /talent/me. */
export interface OwnSectionEditView {
  /** The open request on the section, if any: Edit opens it instead. */
  openRequest: { id: string; status: 'pending' | 'returned' } | null;
  /** The footer's approvers. */
  approvers: ChangeRequestApprovers;
}

/** What an own save did: what was saved straight away and which requests it sent. */
export interface OwnSaveResult {
  /** The record's new `version`, or null when nothing was saved directly. */
  savedVersion: number | null;
  /** The fields saved straight away. */
  saved: ChangeRequestField[];
  /** The change requests the save sent. */
  sent: { id: string; section: ChangeRequestSection }[];
}

/** The `talent.onboardingSettings` setting for the Settings sheet on /talent. */
export interface OnboardingSettingsView {
  requiredDocumentTypes: Document201Type[];
  /** The types the sheet offers. */
  options: Document201Type[];
  /** The Manila day the version in effect started, or null with no version (the seeded value applies). */
  effectiveFrom: BusinessDate | null;
  source: string | null;
  /** True when a change already takes effect today: another one is refused until tomorrow. */
  changedToday: boolean;
  /** True for a Talent Owner. */
  canChange: boolean;
}
