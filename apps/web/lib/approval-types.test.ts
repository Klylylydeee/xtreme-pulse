import { describe, expect, it } from 'vitest';
import { hasApprovalSigner } from '@pulse/core/server';
import { CHANGE_REQUEST_TYPE } from '@pulse/talent/server';
// Core's registry lookup isn't part of `@pulse/core/server`; this is the same module it uses.
import { findApprovalType } from '../../../packages/core/src/server/approvals/registry';
import { registerApprovalTypes } from './approval-types';

// Spec: docs/modules/talent.md#onboarding-checklist-and-change-requests-build-step-26 (decision
// 271 in docs/BUILD_PLAN.md) and docs/TESTING.md#onboarding-and-change-request-tests — the
// Approvals page and its Server Actions register Talent's `talent.changeRequest` beside Core's
// types and the e-signature signer, so a change request can be read and decided from Approvals
// (without it the engine refuses the decision: fail closed).

describe('the approval registrations', () => {
  it('registers the change request type and the e-signature signer', () => {
    registerApprovalTypes();
    const changeRequest = findApprovalType(CHANGE_REQUEST_TYPE);
    expect(changeRequest).not.toBeNull();
    expect(changeRequest?.module).toBe('talent');
    expect(changeRequest?.whenEmpty).toBe('systemAdministrator');
    expect(changeRequest?.allowedDecisions).toEqual(['approve', 'return', 'reject']);
    expect(hasApprovalSigner()).toBe(true);
  });

  it('is safe to call on every request', () => {
    registerApprovalTypes();
    expect(() => registerApprovalTypes()).not.toThrow();
    expect(findApprovalType(CHANGE_REQUEST_TYPE)).not.toBeNull();
  });
});
