import type { ClientSession, Types } from 'mongoose';
import {
  APPROVAL_DECISIONS,
  APPROVAL_WHEN_EMPTY,
  type ApprovalDecision,
  type ApprovalStatus,
  type ApprovalWhenEmpty,
} from '../../approvals';
import { AUDIT_MODULES, type AuditModule } from '../../audit';
import { APPROVAL_TYPE_PATTERN } from './model';
import type { ApprovalSignatureStamp } from './signer';

// Spec: docs/modules/core.md#approvals and docs/ARCHITECTURE.md#cross-module-integration
// (decision 100 in docs/BUILD_PLAN.md) — a module registers each kind of request it sends for
// approval: its name, steps, allowed decisions, what an empty step does, and its hooks. Submitting
// or deciding an unregistered type is refused (fail closed).
//
// Registrations are per process and explicit, like the file access registry (files/access.ts):
// `registerCoreApprovalTypes()` registers Core's own, and a module's `register<Module>ApprovalTypes()`
// is called beside it by whatever submits or decides (the Approvals page, the dev script). A
// missed call refuses requests; it never lets one through unchecked.

/** A set an `anyOf` or `allOf` step asks: the Board, HR, or named users. */
export type ApproverSet =
  { set: 'board' } | { set: 'hr' } | { userIds: readonly (Types.ObjectId | string)[] };

/** One step of a type, as the module describes it. The engine works out its approvers at submit. */
export type ApprovalStepSpec =
  | {
      kind: 'reportingTo';
      /** What the Approvals list shows for the step, for example "Supervisor". */
      label: string;
      /** Overrides the type's `whenEmpty` for this step. */
      whenEmpty?: ApprovalWhenEmpty;
    }
  | {
      kind: 'anyOf' | 'allOf';
      label: string;
      approvers: ApproverSet;
      whenEmpty?: ApprovalWhenEmpty;
    };

/** The request a hook sees, after the decision. Plain values only. */
export interface ApprovalRequestSnapshot {
  id: string;
  type: string;
  module: AuditModule;
  record: { type: string; id: string; label: string };
  title: string;
  requesterUserId: string;
  requesterEmployeeId: string | null;
  status: ApprovalStatus;
  currentStep: number;
  previousRequestId: string | null;
}

/** What every hook gets. Pass `session` to every write so it commits with the decision. */
export interface ApprovalHookContext {
  request: ApprovalRequestSnapshot;
  /** The decision that caused the hook. */
  decision: {
    userId: string;
    email: string;
    decision: ApprovalDecision;
    remarks: string | null;
    /**
     * The e-signature an approve was signed with (build step 2.2), or null: return and reject, and
     * an approver with no signature on file.
     */
    signature: ApprovalSignatureStamp | null;
  };
  session: ClientSession;
}

export interface ApprovalStepApprovedContext extends ApprovalHookContext {
  /** The index of the step that was approved. */
  stepIndex: number;
  stepLabel: string;
}

export interface ApprovalTypeDefinition {
  /** The module that owns the record; audit entries and notifications use it. */
  module: AuditModule;
  /** What the Approvals list shows for the type, for example "Leave". */
  label: string;
  /** The decisions the type allows. Approve is always one of them. */
  allowedDecisions: readonly ApprovalDecision[];
  /**
   * The type's steps, in order. A type whose steps depend on the record (named approvers from the
   * module's settings) leaves this out and gives `steps` to `submitApproval()` instead.
   */
  steps?: readonly ApprovalStepSpec[];
  /** What a step left empty does; without it, a submit that leaves a step empty is refused. */
  whenEmpty?: ApprovalWhenEmpty;
  /**
   * The request was approved, returned or rejected. Runs in the decision's transaction: update and
   * audit the module's own record with `session`. Throwing rolls back the decision.
   */
  onSettled: (context: ApprovalHookContext) => void | Promise<void>;
  /** A step was approved (the last one included, before `onSettled`). Same transaction. */
  onStepApproved?: (context: ApprovalStepApprovedContext) => void | Promise<void>;
  /** Who hears the outcome (user ids). The requester when left out. Same transaction. */
  outcomeRecipients?: (
    context: ApprovalHookContext,
  ) => readonly (Types.ObjectId | string)[] | Promise<readonly (Types.ObjectId | string)[]>;
}

/** Thrown for an approval type nobody registered. A programming error, not a user's. */
export class ApprovalTypeNotRegisteredError extends Error {
  constructor(type: string) {
    super(`The approval type "${type}" isn't registered, so the request was refused.`);
    this.name = 'ApprovalTypeNotRegisteredError';
  }
}

// Per process (and per bundle, since Next evaluates server modules once per bundle).
const registry = new Map<string, Readonly<ApprovalTypeDefinition>>();

function assertValidDefinition(type: string, definition: ApprovalTypeDefinition): void {
  if (!APPROVAL_TYPE_PATTERN.test(type)) {
    throw new Error(
      `"${type}" isn't an approval type name. Use <module>.<name>, like talent.leave.`,
    );
  }
  if (!(AUDIT_MODULES as readonly string[]).includes(definition.module)) {
    throw new Error(`The approval type "${type}" names an unknown module.`);
  }
  if (!definition.label.trim()) throw new Error(`The approval type "${type}" needs a label.`);
  const decisions = definition.allowedDecisions;
  if (
    !decisions.includes('approve') ||
    decisions.some((decision) => !(APPROVAL_DECISIONS as readonly string[]).includes(decision))
  ) {
    throw new Error(`The approval type "${type}" must allow approve, and only known decisions.`);
  }
  const whenEmpty = [definition.whenEmpty, ...(definition.steps ?? []).map((s) => s.whenEmpty)];
  if (
    whenEmpty.some(
      (rule) => rule !== undefined && !(APPROVAL_WHEN_EMPTY as readonly string[]).includes(rule),
    )
  ) {
    throw new Error(`The approval type "${type}" has an unknown whenEmpty rule.`);
  }
  if (definition.steps && definition.steps.length === 0) {
    throw new Error(`The approval type "${type}" needs at least one step.`);
  }
}

/**
 * Registers an approval type (`<module>.<name>`). Only the module that owns the record registers
 * it. Registering the same type again replaces it outside production, where a hot reload evaluates
 * the registering code again; in production it throws, so nothing can quietly swap the hooks of a
 * type that is already registered.
 */
export function registerApprovalType(type: string, definition: ApprovalTypeDefinition): void {
  assertValidDefinition(type, definition);
  if (registry.has(type) && process.env.NODE_ENV === 'production') {
    throw new Error(`The approval type "${type}" is already registered.`);
  }
  registry.set(type, Object.freeze({ ...definition }));
}

/** The registered type, or null. */
export function findApprovalType(type: string): Readonly<ApprovalTypeDefinition> | null {
  return registry.get(type) ?? null;
}

/** The registered type, or {@link ApprovalTypeNotRegisteredError}. */
export function requireApprovalType(type: string): Readonly<ApprovalTypeDefinition> {
  const definition = registry.get(type);
  if (!definition) throw new ApprovalTypeNotRegisteredError(type);
  return definition;
}

/** Removes a registration. For tests only. */
export function unregisterApprovalType(type: string): void {
  registry.delete(type);
}

// --- Core's own types ------------------------------------------------------------------------

/**
 * The development sample type (decision 109): `pnpm dev:approval` submits it to check the engine
 * before any module sends requests. Never registered in production.
 */
export const DEV_SAMPLE_APPROVAL_TYPE = 'dev.sample';
/** The record type of a development sample request. Not a business record. */
export const DEV_SAMPLE_APPROVAL_RECORD_TYPE = 'dev.sample';

/**
 * The sample type's hooks. They do nothing; they're an object so a test can spy on them and see
 * that the engine called them.
 */
export const devSampleApprovalHooks: {
  onSettled: (context: ApprovalHookContext) => void;
  onStepApproved: (context: ApprovalStepApprovedContext) => void;
} = {
  onSettled: () => {},
  onStepApproved: () => {},
};

/**
 * Registers Core's approval types: in development, `dev.sample`, which allows approve, return and
 * reject, and takes its steps at submit. Safe to call on every request; in production it
 * registers nothing.
 */
export function registerCoreApprovalTypes(): void {
  if (process.env.NODE_ENV === 'production') return;
  if (registry.has(DEV_SAMPLE_APPROVAL_TYPE)) return;
  registerApprovalType(DEV_SAMPLE_APPROVAL_TYPE, {
    module: 'core',
    label: 'Sample request',
    allowedDecisions: ['approve', 'return', 'reject'],
    onSettled: (context) => devSampleApprovalHooks.onSettled(context),
    onStepApproved: (context) => devSampleApprovalHooks.onStepApproved(context),
  });
}
