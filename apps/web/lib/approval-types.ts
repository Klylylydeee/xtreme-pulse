import { registerCoreApprovalTypes } from '@pulse/core/server';
import { registerTalentApprovalSigner, registerTalentApprovalTypes } from '@pulse/talent/server';

// Spec: docs/modules/core.md#approvals (decision 100 in docs/BUILD_PLAN.md) and
// docs/modules/talent.md#onboarding-checklist-and-change-requests-build-step-26 (decision 271) —
// the approval types and the e-signature signer every reader and decider of approvals registers
// first. Registrations are per process and explicit (packages/core/src/server/approvals/registry.ts):
// a missed one refuses the request (fail closed) and shows the type's raw name in the list. Each
// call is safe on every request.
//
// - Core's own types (`registerCoreApprovalTypes`: `dev.sample` outside production).
// - From step 2.2, Talent's e-signature signer: an approve applies the approver's own current
//   signature in the decision's transaction (from step 2.6, the e-signature gate).
// - From step 2.6, Talent's `talent.changeRequest`, whose `onSettled` hook applies an approved
//   change. Without it, deciding a change request from Approvals is refused.
//
// Later modules add their `register<Module>ApprovalTypes()` here, beside these.

/** Registers every approval type and the signer. Safe to call on every request. */
export function registerApprovalTypes(): void {
  registerCoreApprovalTypes();
  registerTalentApprovalTypes();
  registerTalentApprovalSigner();
}
