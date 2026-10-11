import { describe, expect, it } from 'vitest';
import {
  APPROVAL_DECISIONS,
  APPROVAL_REMARKS_MAX_LENGTH,
  APPROVAL_STATUSES,
  APPROVAL_STEP_KINDS,
  APPROVAL_STEP_STATUSES,
  APPROVAL_WHEN_EMPTY,
  approvalHref,
  decideApprovalSchema,
} from './approvals';
import { isInternalHref } from './notifications';

// The approvals fixed sets and decision schema (docs/modules/core.md#approvals,
// docs/TESTING.md#approvals-tests). Made-up data only.

const REQUEST_ID = '0123456789abcdef01234567';

describe('fixed sets', () => {
  it('holds the specified values', () => {
    expect(APPROVAL_STATUSES).toEqual(['pending', 'approved', 'returned', 'rejected']);
    expect(APPROVAL_STEP_KINDS).toEqual(['reportingTo', 'anyOf', 'allOf']);
    expect(APPROVAL_DECISIONS).toEqual(['approve', 'return', 'reject']);
    expect(APPROVAL_STEP_STATUSES).toEqual([
      'waiting',
      'pending',
      'approved',
      'returned',
      'rejected',
      'skipped',
    ]);
    expect(APPROVAL_WHEN_EMPTY).toEqual(['skip', 'hr', 'systemAdministrator']);
    expect(APPROVAL_REMARKS_MAX_LENGTH).toBe(1000);
  });

  it('links notifications to the request in the Approvals list', () => {
    expect(approvalHref(REQUEST_ID)).toBe(`/approvals?request=${REQUEST_ID}`);
    expect(isInternalHref(approvalHref(REQUEST_ID))).toBe(true);
  });
});

describe('decideApprovalSchema', () => {
  const base = { requestId: REQUEST_ID, version: '3' };

  it('accepts an approval without remarks, and with optional remarks', () => {
    expect(decideApprovalSchema.parse({ ...base, decision: 'approve' })).toEqual({
      requestId: REQUEST_ID,
      decision: 'approve',
      remarks: null,
      version: 3,
    });
    expect(
      decideApprovalSchema.parse({ ...base, decision: 'approve', remarks: '  Looks fine.  ' }),
    ).toMatchObject({ remarks: 'Looks fine.' });
    expect(decideApprovalSchema.parse({ ...base, decision: 'approve', remarks: '' }).remarks).toBe(
      null,
    );
  });

  it.each(['return', 'reject'])('needs remarks for %s', (decision) => {
    for (const remarks of [undefined, null, '', '   ']) {
      const result = decideApprovalSchema.safeParse({ ...base, decision, remarks });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(['remarks']);
    }
    expect(
      decideApprovalSchema.safeParse({ ...base, decision, remarks: 'Fix the dates.' }).success,
    ).toBe(true);
  });

  it('refuses remarks over 1,000 characters', () => {
    const at = 'x'.repeat(APPROVAL_REMARKS_MAX_LENGTH);
    expect(
      decideApprovalSchema.safeParse({ ...base, decision: 'return', remarks: at }).success,
    ).toBe(true);
    const over = decideApprovalSchema.safeParse({ ...base, decision: 'return', remarks: `${at}x` });
    expect(over.success).toBe(false);
    expect(over.error?.issues[0]?.path).toEqual(['remarks']);
  });

  it('refuses an unknown decision, a bad request id and a missing version', () => {
    expect(decideApprovalSchema.safeParse({ ...base, decision: 'withdraw' }).success).toBe(false);
    expect(
      decideApprovalSchema.safeParse({ ...base, requestId: 'nope', decision: 'approve' }).success,
    ).toBe(false);
    expect(
      decideApprovalSchema.safeParse({ requestId: REQUEST_ID, decision: 'approve' }).success,
    ).toBe(false);
    expect(
      decideApprovalSchema.safeParse({ ...base, version: '-1', decision: 'approve' }).success,
    ).toBe(false);
  });
});
