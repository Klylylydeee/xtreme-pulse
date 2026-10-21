import { type ClientSession, Types } from 'mongoose';
import { z } from 'zod';
import { AccessDeniedError, ActionError, type Centavos } from '@pulse/core';
import {
  encryptSensitive,
  getEmployeeIdentity,
  recordAudit,
  reloadActorAccess,
  snapshotForAudit,
  snapshotsForAudit,
} from '@pulse/core/server';
import {
  isEditablePayrollRunStatus,
  livePayrollManualEntries,
  PAYROLL_MANUAL_REASON_MAX_LENGTH,
  PAYROLL_OVERRIDE_TARGET_MESSAGE,
  payrollManualEntrySchema,
  type PayrollManualEntryInputValues,
  type PayrollManualEntryValues,
} from '../../payroll-run';
import { inputError } from '../input';
import {
  loadPayrollManualEntries,
  PAYROLL_READER,
  type StoredPayrollManualEntry,
} from '../payroll-runs/compute';
import type { PayrollRunDocument } from '../payroll-runs/model';
import {
  getPayrollRunLine,
  PAYROLL_LINE_GONE,
  PAYROLL_RUN_GONE,
  PAYROLL_RUN_NOT_EDITABLE,
  payrollOverrideTargets,
  recomputeEditablePayrollRun,
} from '../payroll-runs/service';
import {
  assertCanEnterPayrollManualEntry,
  mayEnterPayrollManualEntries,
  PAYROLL_MANUAL_ENTRY_DENIED,
  type TalentActor,
} from '../policy';
import { auditLabelOf, isDuplicateKey, objectIdOf, targetOf } from '../shared';
import {
  PAYROLL_MANUAL_ENTRY_AMOUNT_SELECT,
  PAYROLL_MANUAL_ENTRY_RECORD_TYPE,
  type PayrollManualEntryDocument,
  PayrollManualEntryModel,
} from './model';

// Spec: docs/modules/talent.md#payroll-review-approval-and-payslips-build-step-210 ("Manual
// entries", "Who may see and do what"), SECURITY.md#sensitive-data ("Payroll runs") and
// SECURITY.md#audit-logging (decisions 355–359 in docs/BUILD_PLAN.md; HANDOFF items 286, 299–303).
//
// - Adding, editing and removing a manual entry on an editable (`draft` or `returned`) run's line.
//   Each change is a new insert-only entry: an edit or a removal supersedes the latest of its
//   chain (`supersedesId`, unique), a removal is marked `removed`; the live entries are the latest
//   of each chain not removed.
// - Who: Talent Write and HR or the System Administrator; for an employee in the HR department,
//   Talent Write and the System Administrator or a Board member, never HR; never on one's own
//   line. Checked first, and again in the transaction against the account and the employee's
//   department as they are then.
// - Each save recomputes the whole run (decision 358; HANDOFF item 302) with the new entry applied,
//   then in one transaction stores the run (version raised), its lines, the run's `update`
//   ("Recomputed after a manual entry"), the entry and its audit entry. An override is checked
//   against the line's override targets and named after its line; a second live override of the
//   same line is refused (edit that one instead).
// - Audit: `create` (add), `update` (edit) or `delete` (remove) on `talent.payrollManualEntry`,
//   the record id being the chain's first entry, labelled `<run number> · <employee number> ·
//   <label>`, with the typed reason. The amount is a sensitive field, so the snapshots only mark
//   it hidden and changed; the old and new amounts stay encrypted in the chain (the breakdown's
//   History). Nothing here logs anything.

export const PAYROLL_MANUAL_ENTRY_GONE = 'This manual entry no longer exists. Reload the page.';
export const PAYROLL_MANUAL_ENTRY_CHANGED =
  'This manual entry changed since the page loaded. Reload the page.';
export const PAYROLL_OVERRIDE_EXISTS =
  'This line is already overridden. Edit that override instead.';
export const PAYROLL_MANUAL_ENTRY_KIND_FIXED =
  'Remove this entry and add a new one to change its kind or the line it overrides.';
/** The run's audit reason when a manual entry save recomputes it. */
export const PAYROLL_MANUAL_RECOMPUTE_REASON = 'Recomputed after a manual entry';

/** The reason a removal takes: 1–500 characters, trimmed. */
const removeSchema = z.object({
  reason: z.preprocess(
    (value) => (typeof value === 'string' ? value.trim() : value),
    z
      .string({ error: 'Enter the reason for removing this entry.' })
      .min(1, 'Enter the reason for removing this entry.')
      .max(
        PAYROLL_MANUAL_REASON_MAX_LENGTH,
        `Use at most ${PAYROLL_MANUAL_REASON_MAX_LENGTH} characters.`,
      ),
  ),
});

/** "Add manual entry": the run, the employee and the entry (amounts in whole centavos). */
export type AddPayrollManualEntryInput = {
  runId: string;
  employeeId: string;
} & PayrollManualEntryInputValues;

/** "Edit": the run, the entry being changed (the latest of its chain) and its new values. */
export type EditPayrollManualEntryInput = {
  runId: string;
  entryId: string;
} & PayrollManualEntryInputValues;

/** "Remove": the run, the entry (the latest of its chain) and the reason. */
export interface RemovePayrollManualEntryInput {
  runId: string;
  entryId: string;
  reason: string;
}

export interface PayrollManualEntrySaved {
  /** The new entry (for a removal, the removal itself). */
  entryId: string;
  runId: string;
  /** The run's version after the recompute. */
  version: number;
}

type Change =
  | { action: 'create'; values: PayrollManualEntryValues; employeeId: string }
  | { action: 'update'; values: PayrollManualEntryValues; entryId: string }
  | { action: 'delete'; reason: string; entryId: string };

function parseValues(input: Record<string, unknown>): PayrollManualEntryValues {
  const { runId: _runId, employeeId: _employeeId, entryId: _entryId, ...rest } = input;
  void _runId;
  void _employeeId;
  void _entryId;
  const parsed = payrollManualEntrySchema.safeParse(rest);
  if (!parsed.success) throw inputError(parsed.error.issues);
  return parsed.data;
}

/** "Add manual entry" on an employee's line (decision 355). */
export async function addPayrollManualEntry(
  actor: TalentActor,
  input: AddPayrollManualEntryInput,
): Promise<PayrollManualEntrySaved> {
  if (!mayEnterPayrollManualEntries(actor)) {
    throw new AccessDeniedError(PAYROLL_MANUAL_ENTRY_DENIED);
  }
  const values = parseValues((input ?? {}) as Record<string, unknown>);
  if (!objectIdOf(input.employeeId)) throw new ActionError(PAYROLL_LINE_GONE);
  return saveChange(actor, input.runId, {
    action: 'create',
    values,
    employeeId: String(input.employeeId),
  });
}

/** "Edit" a live manual entry: a new entry superseding it, of the same kind and line. */
export async function editPayrollManualEntry(
  actor: TalentActor,
  input: EditPayrollManualEntryInput,
): Promise<PayrollManualEntrySaved> {
  if (!mayEnterPayrollManualEntries(actor)) {
    throw new AccessDeniedError(PAYROLL_MANUAL_ENTRY_DENIED);
  }
  const values = parseValues((input ?? {}) as Record<string, unknown>);
  if (!objectIdOf(input.entryId)) throw new ActionError(PAYROLL_MANUAL_ENTRY_GONE);
  return saveChange(actor, input.runId, {
    action: 'update',
    values,
    entryId: String(input.entryId),
  });
}

/** "Remove" a live manual entry: a removal superseding it, with its reason. */
export async function removePayrollManualEntry(
  actor: TalentActor,
  input: RemovePayrollManualEntryInput,
): Promise<PayrollManualEntrySaved> {
  if (!mayEnterPayrollManualEntries(actor)) {
    throw new AccessDeniedError(PAYROLL_MANUAL_ENTRY_DENIED);
  }
  const parsed = removeSchema.safeParse({ reason: input?.reason });
  if (!parsed.success) throw inputError(parsed.error.issues);
  if (!objectIdOf(input.entryId)) throw new ActionError(PAYROLL_MANUAL_ENTRY_GONE);
  return saveChange(actor, input.runId, {
    action: 'delete',
    reason: parsed.data.reason,
    entryId: String(input.entryId),
  });
}

/** The employee's identity (separated ones included), or refuses. */
async function employeeOf(employeeId: string, session: ClientSession | null = null) {
  const identity = await getEmployeeIdentity(PAYROLL_READER, employeeId, {
    separated: true,
    session,
  });
  if (!identity) throw new ActionError(PAYROLL_LINE_GONE);
  return identity;
}

/** The first entry of `id`'s chain. */
function chainRootOf(entries: readonly StoredPayrollManualEntry[], id: string): string {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  let current = byId.get(id);
  let guard = 0;
  while (current?.supersedesId && byId.has(current.supersedesId) && guard <= entries.length) {
    current = byId.get(current.supersedesId);
    guard += 1;
  }
  return current?.id ?? id;
}

/** What one attempt prepared: the new entry, as computed and as stored. */
interface Prepared {
  pending: StoredPayrollManualEntry;
  document: Record<string, unknown>;
  rootId: string;
  employeeNumber: string;
  previousId: string | null;
}

async function saveChange(
  actor: TalentActor,
  runIdInput: unknown,
  change: Change,
): Promise<PayrollManualEntrySaved> {
  const runId = objectIdOf(runIdInput);
  if (!runId) throw new ActionError(PAYROLL_RUN_GONE);

  // Who the entry is for, checked before anything is computed.
  let employeeId: string;
  if (change.action === 'create') {
    employeeId = change.employeeId;
  } else {
    const found = await PayrollManualEntryModel.findOne(
      { _id: new Types.ObjectId(change.entryId), runId },
      { employeeId: 1 },
    ).lean<Pick<PayrollManualEntryDocument, 'employeeId'>>();
    if (!found) throw new ActionError(PAYROLL_MANUAL_ENTRY_GONE);
    employeeId = found.employeeId.toHexString();
  }
  const identity = await employeeOf(employeeId);
  assertCanEnterPayrollManualEntry(actor, targetOf(identity));

  let prepared: Prepared | null = null;
  const prepare = async (run: PayrollRunDocument): Promise<StoredPayrollManualEntry[]> => {
    prepared = await prepareChange(actor, run, change, employeeId, identity.employeeNumber);
    return [prepared.pending];
  };

  const recheck = async (session: ClientSession) => {
    const reloaded = await reloadActorAccess({ id: actor.id }, session);
    assertCanEnterPayrollManualEntry(reloaded, targetOf(await employeeOf(employeeId, session)));
  };

  try {
    const saved = await recomputeEditablePayrollRun(runId, {
      actor,
      prepare,
      recheck,
      auditReason: PAYROLL_MANUAL_RECOMPUTE_REASON,
      inTransaction: async ({ session, before }) => {
        const current = prepared as Prepared | null;
        if (!current) throw new Error('The manual entry was not prepared.');
        await storeEntry(actor, current, change, before, session);
        return current.pending.id;
      },
    });
    return { entryId: saved.result ?? '', runId: saved.id, version: saved.version };
  } catch (error) {
    // Another edit or removal of the same entry won (the unique `supersedesId`).
    if (isDuplicateKey(error)) throw new ActionError(PAYROLL_MANUAL_ENTRY_CHANGED);
    throw error;
  }
}

/** Checks the change against the run and its entries as they are now, and builds the new entry. */
async function prepareChange(
  actor: TalentActor,
  run: PayrollRunDocument,
  change: Change,
  employeeId: string,
  employeeNumber: string,
): Promise<Prepared> {
  const entries = await loadPayrollManualEntries(run._id, { employeeId });
  const live = livePayrollManualEntries(entries);
  let previous: StoredPayrollManualEntry | null = null;
  if (change.action !== 'create') {
    previous = entries.find((entry) => entry.id === change.entryId) ?? null;
    if (!previous) throw new ActionError(PAYROLL_MANUAL_ENTRY_GONE);
    if (!live.some((entry) => entry.id === change.entryId)) {
      throw new ActionError(PAYROLL_MANUAL_ENTRY_CHANGED);
    }
  }
  const values: PayrollManualEntryValues | null = change.action === 'delete' ? null : change.values;
  if (values && previous) {
    if (values.kind !== previous.kind || values.targetLineKey !== previous.targetLineKey) {
      throw new ActionError(PAYROLL_MANUAL_ENTRY_KIND_FIXED);
    }
  }

  // Adding needs the employee's line; an override needs its target on it (decision 356).
  let label = values?.label ?? previous?.label ?? '';
  if (values && (change.action === 'create' || values.kind === 'override')) {
    const line = await getPayrollRunLine(run._id.toHexString(), employeeId);
    if (!line) throw new ActionError(PAYROLL_LINE_GONE);
    if (values.kind === 'override') {
      const target = payrollOverrideTargets(line.breakdown).find(
        (candidate) => candidate.key === values.targetLineKey,
      );
      if (!target) {
        throw new ActionError(PAYROLL_OVERRIDE_TARGET_MESSAGE, { field: 'targetLineKey' });
      }
      const other = live.find(
        (entry) =>
          entry.kind === 'override' &&
          entry.targetLineKey === values.targetLineKey &&
          entry.id !== previous?.id,
      );
      if (other) throw new ActionError(PAYROLL_OVERRIDE_EXISTS, { field: 'targetLineKey' });
      label = target.label;
    }
  }

  const id = new Types.ObjectId();
  const createdAt = new Date();
  const source = values ?? previous;
  if (!source) throw new ActionError(PAYROLL_MANUAL_ENTRY_GONE);
  const amount: Centavos | null = values ? values.amountCentavos : null;
  const reason = change.action === 'delete' ? change.reason : (values?.reason ?? '');
  const pending: StoredPayrollManualEntry = {
    id: id.toHexString(),
    runId: run._id.toHexString(),
    employeeId,
    kind: source.kind,
    targetLineKey: source.targetLineKey,
    label,
    amountCentavos: amount,
    taxable: source.taxable,
    reducesTaxablePay: source.reducesTaxablePay,
    authorizedInWriting: source.authorizedInWriting,
    countsAsBasicSalary: source.countsAsBasicSalary,
    reason,
    supersedesId: previous?.id ?? null,
    removed: change.action === 'delete',
    createdAt,
    createdBy: actor.id,
  };
  const by = new Types.ObjectId(actor.id);
  const document: Record<string, unknown> = {
    _id: id,
    runId: run._id,
    employeeId: new Types.ObjectId(employeeId),
    kind: pending.kind,
    targetLineKey: pending.targetLineKey,
    label: pending.label,
    taxable: pending.taxable,
    reducesTaxablePay: pending.reducesTaxablePay,
    authorizedInWriting: pending.authorizedInWriting,
    countsAsBasicSalary: pending.countsAsBasicSalary,
    reason: pending.reason,
    supersedesId: previous ? new Types.ObjectId(previous.id) : null,
    removed: pending.removed,
    createdAt,
    createdBy: by,
    updatedBy: by,
  };
  if (amount !== null) document.amountCentavos = await encryptSensitive(amount);
  return {
    pending,
    document,
    rootId: previous ? chainRootOf(entries, previous.id) : pending.id,
    employeeNumber,
    previousId: previous?.id ?? null,
  };
}

/** Inserts the entry (the run checked editable in the session by the model) and audits it. */
async function storeEntry(
  actor: TalentActor,
  prepared: Prepared,
  change: Change,
  run: PayrollRunDocument,
  session: ClientSession,
): Promise<void> {
  if (!isEditablePayrollRunStatus(run.status)) throw new ActionError(PAYROLL_RUN_NOT_EDITABLE);
  const [created] = await PayrollManualEntryModel.create([prepared.document], {
    session,
    ordered: true,
  });
  if (!created) throw new Error('The manual entry was not saved.');
  const after = created.toObject();
  let snapshots: { before: unknown; after: unknown };
  if (prepared.previousId) {
    const previous = await PayrollManualEntryModel.findById(prepared.previousId)
      .select(PAYROLL_MANUAL_ENTRY_AMOUNT_SELECT)
      .session(session)
      .lean();
    snapshots = snapshotsForAudit(PayrollManualEntryModel, previous, after);
  } else {
    snapshots = { before: null, after: snapshotForAudit(PayrollManualEntryModel, after) };
  }
  await recordAudit(
    {
      actorId: actor.id,
      actorEmail: actor.email,
      module: 'talent',
      action: change.action,
      record: {
        type: PAYROLL_MANUAL_ENTRY_RECORD_TYPE,
        id: new Types.ObjectId(prepared.rootId),
        label: auditLabelOf(run.number, prepared.employeeNumber, prepared.pending.label),
      },
      before: snapshots.before,
      after: change.action === 'delete' ? null : snapshots.after,
      reason: prepared.pending.reason,
    },
    { session },
  );
}
