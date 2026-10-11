import { z } from 'zod';
import { OBJECT_ID_PATTERN } from './audit';

// Spec: docs/modules/core.md#approvals and #approvals-list — the approvals engine's fixed sets and
// the decision form's schema (build step 1.9, decisions 99–110 in docs/BUILD_PLAN.md). Pure code,
// safe in the browser, so the Approvals list and the engine (`@pulse/core/server`) share the same
// rules.

/** A request's status. `returned` and `rejected` are final: a module resubmits a new request. */
export const APPROVAL_STATUSES = ['pending', 'approved', 'returned', 'rejected'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/**
 * The kinds of step: the requester's supervisors (any one), any one of a set, or all of a set.
 */
export const APPROVAL_STEP_KINDS = ['reportingTo', 'anyOf', 'allOf'] as const;
export type ApprovalStepKind = (typeof APPROVAL_STEP_KINDS)[number];

/** How a step is settled: by any one of its approvers, or by all of them. */
export const APPROVAL_STEP_RULES = ['any', 'all'] as const;
export type ApprovalStepRule = (typeof APPROVAL_STEP_RULES)[number];

/** A step's status. Only one step is `pending` at a time; later ones are `waiting`. */
export const APPROVAL_STEP_STATUSES = [
  'waiting',
  'pending',
  'approved',
  'returned',
  'rejected',
  'skipped',
] as const;
export type ApprovalStepStatus = (typeof APPROVAL_STEP_STATUSES)[number];

/** The decisions. Each approval type declares which it allows (approve always). */
export const APPROVAL_DECISIONS = ['approve', 'return', 'reject'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

/** What an empty step does: skip it, or send it to HR or to the System Administrator. */
export const APPROVAL_WHEN_EMPTY = ['skip', 'hr', 'systemAdministrator'] as const;
export type ApprovalWhenEmpty = (typeof APPROVAL_WHEN_EMPTY)[number];

/** The decisions as the inspector's buttons name them. */
export const APPROVAL_DECISION_LABELS = {
  approve: 'Approve',
  return: 'Return',
  reject: 'Reject',
} as const satisfies Record<ApprovalDecision, string>;

/** The statuses as the Approvals list shows them. */
export const APPROVAL_STATUS_LABELS = {
  pending: 'Pending',
  approved: 'Approved',
  returned: 'Returned',
  rejected: 'Rejected',
} as const satisfies Record<ApprovalStatus, string>;

/** The longest remarks a decision keeps. */
export const APPROVAL_REMARKS_MAX_LENGTH = 1000;
/** The longest title a request keeps. */
export const APPROVAL_TITLE_MAX_LENGTH = 200;
/** The longest summary a request keeps. */
export const APPROVAL_SUMMARY_MAX_LENGTH = 1000;

/** The most requests one page of the Approvals list returns. */
export const APPROVAL_PAGE_MAX = 50;

/** The link every approval notification opens: the request in the Approvals list. */
export function approvalHref(requestId: string): string {
  return `/approvals?request=${encodeURIComponent(requestId)}`;
}

/** The decision that settles the request's status. */
export const DECISION_STATUS = {
  approve: 'approved',
  return: 'returned',
  reject: 'rejected',
} as const satisfies Record<ApprovalDecision, ApprovalStatus>;

/** True when `decision` needs remarks: a return or a rejection. */
export function decisionNeedsRemarks(decision: ApprovalDecision): boolean {
  return decision !== 'approve';
}

/** Refusal for a form loaded before the request last changed. */
export const APPROVAL_CHANGED_ELSEWHERE =
  'This request changed since you opened it. Reload to see where it stands.';

const REMARKS_REQUIRED = {
  return: 'Enter remarks saying what to fix before returning this request.',
  reject: 'Enter remarks saying why you’re rejecting this request.',
} as const;

/**
 * What the inspector sends: the request, the decision, remarks (required for a return or a
 * rejection, optional for an approval) and the `version` the inspector loaded, so a decision on a
 * request that changed since is refused.
 */
export const decideApprovalSchema = z
  .object({
    requestId: z.string().regex(OBJECT_ID_PATTERN, 'Reload the page and try again.'),
    decision: z.enum(APPROVAL_DECISIONS, { error: 'Choose approve, return or reject.' }),
    remarks: z.preprocess(
      (value) => (typeof value === 'string' ? value.trim() : value),
      z
        .string()
        .max(
          APPROVAL_REMARKS_MAX_LENGTH,
          `Keep remarks to ${APPROVAL_REMARKS_MAX_LENGTH.toLocaleString('en-PH')} characters.`,
        )
        .nullish()
        .transform((value) => value || null),
    ),
    // A missing or empty version is refused, never read as 0.
    version: z.preprocess(
      (value) => (value === '' || value === null ? undefined : value),
      z.coerce
        .number({ error: 'Reload the page and try again.' })
        .int('Reload the page and try again.')
        .min(0, 'Reload the page and try again.'),
    ),
  })
  .superRefine((value, context) => {
    if (decisionNeedsRemarks(value.decision) && !value.remarks) {
      context.addIssue({
        code: 'custom',
        path: ['remarks'],
        message: REMARKS_REQUIRED[value.decision as 'return' | 'reject'],
      });
    }
  });

export type DecideApprovalInput = z.input<typeof decideApprovalSchema>;
export type DecideApprovalValues = z.output<typeof decideApprovalSchema>;
