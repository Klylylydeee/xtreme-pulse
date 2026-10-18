import { ActionError } from '@pulse/core';
import {
  ONBOARDING_ITEM_LABELS,
  ONBOARDING_ITEM_WHERE,
  ONBOARDING_VERIFY_WHERE,
  type OnboardingItemKey,
  type OnboardingItemState,
} from './items';

// Spec: docs/modules/talent.md#onboarding-checklist-and-change-requests-build-step-26 ("Gates",
// "The check"; decisions 262 and 263 in docs/BUILD_PLAN.md) — the only things the onboarding
// checklist blocks. One typed constant, not a setting: each gated action calls
// `assertOnboardingGate` itself, so a gate can't be added or dropped from a screen (*Assumption*,
// HANDOFF item 88). Pure code, safe in the browser: a screen can check a gate to explain a
// disabled button, and the server checks it again.
//
// A gate's item counts only when it is Done: government IDs or a bank account waiting for HR to
// verify are missing for `includeInPayroll`.

export const ONBOARDING_GATES = {
  /** Applying an e-signature: approvals now; quotations, POs, DRs, service reports, HR and handover documents as they are built. Wired in step 2.6. */
  applyESignature: ['eSignature'],
  /** Submitting a timesheet, filing leave or offset time off. Wired in steps 2.7 and 2.8. */
  fileTimeRequest: ['reportingTo'],
  /** Inclusion in a payroll run, each item done and verified. Wired in step 2.10. */
  includeInPayroll: ['governmentIds', 'bankAccount'],
} as const satisfies Record<string, readonly OnboardingItemKey[]>;

export type OnboardingGate = keyof typeof ONBOARDING_GATES;
export const ONBOARDING_GATE_KEYS = Object.keys(ONBOARDING_GATES) as OnboardingGate[];

/**
 * What a gate check reads: item states by key. An `OnboardingStatus` fits; a caller that knows
 * only the items its gate needs passes just those (`{ states: { eSignature: 'todo' } }`). An item
 * left out counts as missing.
 */
export interface OnboardingGateStatus {
  states: Partial<Record<OnboardingItemKey, OnboardingItemState>>;
}

/** The gate's missing items, in the map's order. Empty when the action may go ahead. */
export function checkOnboardingGate(
  gate: OnboardingGate,
  status: OnboardingGateStatus,
): OnboardingItemKey[] {
  return ONBOARDING_GATES[gate].filter((key) => status.states[key] !== 'done');
}

/**
 * The refusal: "Complete this onboarding item first: <item>. <where>" for one item, or "Complete
 * these onboarding items first: <item>, <item>." for several. `<where>` says where the employee
 * does the item, "Ask HR to set it." for an HR item, or asks HR to verify an item waiting for it.
 */
export function onboardingGateMessage(
  missing: readonly OnboardingItemKey[],
  status?: OnboardingGateStatus,
): string {
  const [key, ...others] = missing;
  if (key === undefined) return '';
  if (others.length === 0) {
    const waiting = status?.states[key] === 'waitingForVerification';
    const where =
      (waiting ? ONBOARDING_VERIFY_WHERE[key] : undefined) ?? ONBOARDING_ITEM_WHERE[key];
    return `Complete this onboarding item first: ${ONBOARDING_ITEM_LABELS[key]}. ${where}`;
  }
  return `Complete these onboarding items first: ${missing
    .map((key) => ONBOARDING_ITEM_LABELS[key])
    .join(', ')}.`;
}

/** A gated action refused. Carries the missing item keys so a screen can link to each. */
export class OnboardingGateError extends ActionError {
  readonly gate: OnboardingGate;
  readonly items: readonly OnboardingItemKey[];
  constructor(
    gate: OnboardingGate,
    items: readonly OnboardingItemKey[],
    status?: OnboardingGateStatus,
  ) {
    super(onboardingGateMessage(items, status));
    this.name = 'OnboardingGateError';
    this.gate = gate;
    this.items = [...items];
  }
}

/** Throws {@link OnboardingGateError} unless every item the gate needs is done. Writes nothing. */
export function assertOnboardingGate(gate: OnboardingGate, status: OnboardingGateStatus): void {
  const missing = checkOnboardingGate(gate, status);
  if (missing.length > 0) throw new OnboardingGateError(gate, missing, status);
}

/** The Approvals inspector's notice above the decision buttons, for a viewer with no e-signature. */
export const E_SIGNATURE_NEEDED_NOTICE =
  'Approving needs your e-signature. Upload it in My record.';
