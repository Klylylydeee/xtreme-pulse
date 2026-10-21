'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  AccessDeniedError,
  type AccessCheck,
  type Centavos,
  defineAction,
  OBJECT_ID_PATTERN,
} from '@pulse/core';
import {
  type PayrollManualEntryInputValues,
  payrollManualEntryFormSchema,
  type PayrollManualEntryValues,
  type PayrollTotals,
} from '@pulse/talent';
import {
  acknowledgeAllPayrollFlag,
  acknowledgePayrollFlag,
  addPayrollManualEntry,
  assertCanAcknowledgePayrollFlags,
  assertCanComputePayrollRuns,
  assertCanSeePayrollRegister,
  assertCanSeePayrollRuns,
  assertCanSubmitPayrollRuns,
  canSeePayrollRuns,
  createPayrollDraftRun,
  editPayrollManualEntry,
  getPayrollRegister,
  getPayrollRunApproverView,
  getPayrollRunBreakdown,
  getPayrollRunView,
  mayEnterPayrollManualEntries,
  PAYROLL_CUT_OFF_INVALID,
  PAYROLL_LINE_GONE,
  PAYROLL_MANUAL_ENTRY_DENIED,
  PAYROLL_MANUAL_ENTRY_GONE,
  PAYROLL_RUN_GONE,
  type PayrollRegisterView,
  type PayrollRunBreakdownView,
  type PayrollRunView,
  payrollRunHref,
  recomputePayrollRun,
  removePayrollManualEntry,
  submitPayrollRun,
} from '@pulse/talent/server';
import { signedInUser } from '@/lib/auth';
import { PAYROLL_HREF } from '@/lib/navigation';

// Spec: docs/modules/talent.md#payroll-run-computation-build-step-29 ("Creating a draft",
// "Recomputing a draft", "Who may see and do what", "Screens"; decisions 341–343 in
// docs/BUILD_PLAN.md), docs/modules/talent.md#payroll-review-approval-and-payslips-build-step-210
// (step 2.10: "Review flags", "Manual entries", "Submitting", "The Board's view while approving",
// "The payroll register"; decisions 350–376) and SECURITY.md#sensitive-data ("Payroll runs") —
// the Server Actions behind `/talent/payroll`, `/talent/payroll/<runId>` and
// `/talent/payroll/<runId>/register`.
//
// - Access is checked here first, against the signed-in user: seeing runs needs Talent Read and
//   HR, Accounting or the System Administrator (`assertCanSeePayrollRuns`); "Compute draft run",
//   "Recompute", "Acknowledge", "Acknowledge all" and "Submit for approval" need Talent Write and
//   HR or the System Administrator; manual entries need Talent Write and HR, the System
//   Administrator or a Board member (`mayEnterPayrollManualEntries`; the service decides each
//   employee: HR staff's lines, one's own line); the register needs the rule for seeing runs.
//   "Show amounts" is the one exception: a Board member who is a pending approver of the run's
//   request reaches it with no module access (the approver exception), so its access check only
//   needs a signed-in user and the services decide (`getPayrollRunApproverView` refuses anyone who
//   isn't a pending approver before any `reveal`). The services check everything again.
// - Amounts and account numbers leave the server only from the explicit reveal actions: "Show
//   amounts" (a `reveal` on the run, field `amounts`, first), opening one person's breakdown (a
//   `reveal` on the line, field `breakdown`) and "Show register" (a `reveal` on the run, field
//   `register`). Pages never call them while rendering. Every other action answers ids, versions
//   or counts only.
// - No amount, name, account number or breakdown is put in a URL, a log or a cache here. Refusals
//   come back in the services' words.

const runIdField = z
  .string({ error: PAYROLL_RUN_GONE })
  .max(100)
  .regex(OBJECT_ID_PATTERN, PAYROLL_RUN_GONE);
const lineIdField = z
  .string({ error: PAYROLL_LINE_GONE })
  .max(100)
  .regex(OBJECT_ID_PATTERN, PAYROLL_LINE_GONE);
const employeeIdField = lineIdField;
const entryIdField = z
  .string({ error: PAYROLL_MANUAL_ENTRY_GONE })
  .max(100)
  .regex(OBJECT_ID_PATTERN, PAYROLL_MANUAL_ENTRY_GONE);
/** The flag and reason go to the service as typed; it parses them (one place for the rules). */
const flagField = z.string().max(100);
const reasonField = z.string().max(2000);

/** Talent Read and HR, Accounting or the System Administrator. */
const payrollReaders: AccessCheck = async () => {
  assertCanSeePayrollRuns(await signedInUser());
};

/** Talent Write and HR or the System Administrator. */
const payrollComputers: AccessCheck = async () => {
  assertCanComputePayrollRuns(await signedInUser());
};

/** Talent Write and HR or the System Administrator (the acknowledgement rule). */
const flagAcknowledgers: AccessCheck = async () => {
  assertCanAcknowledgePayrollFlags(await signedInUser());
};

/** Talent Write and HR or the System Administrator (the submit rule). */
const payrollSubmitters: AccessCheck = async () => {
  assertCanSubmitPayrollRuns(await signedInUser());
};

/** Talent Write and HR, the System Administrator or a Board member; the service decides each line. */
const manualEntryWriters: AccessCheck = async () => {
  if (!mayEnterPayrollManualEntries(await signedInUser())) {
    throw new AccessDeniedError(PAYROLL_MANUAL_ENTRY_DENIED);
  }
};

/** Any signed-in user; the services decide (the approver exception). */
const signedIn: AccessCheck = async () => {
  await signedInUser();
};

/** The register's readers: the rule for seeing runs. */
const registerReaders: AccessCheck = async () => {
  assertCanSeePayrollRegister(await signedInUser());
};

function revalidateRun(runId: string) {
  revalidatePath(PAYROLL_HREF);
  revalidatePath(payrollRunHref(runId));
}

/** "Compute draft run": the cut-off starting on `periodStart`. Answers the new run's id and number. */
export const createPayrollDraftRunAction = defineAction({
  access: payrollComputers,
  schema: z.object({
    periodStart: z
      .string({ error: PAYROLL_CUT_OFF_INVALID })
      .regex(/^\d{4}-\d{2}-\d{2}$/, PAYROLL_CUT_OFF_INVALID),
  }),
  handler: async ({ periodStart }) => {
    const user = await signedInUser();
    const created = await createPayrollDraftRun(user, { periodStart });
    revalidatePath(PAYROLL_HREF);
    return { id: created.id, number: created.number, href: payrollRunHref(created.id) };
  },
});

/** "Recompute" on an editable run. Answers the run's new version only. */
export const recomputePayrollRunAction = defineAction({
  access: payrollComputers,
  schema: z.object({ runId: runIdField }),
  handler: async ({ runId }) => {
    const user = await signedInUser();
    const done = await recomputePayrollRun(user, { runId });
    revalidateRun(done.id);
    return { id: done.id, version: done.version };
  },
});

/** One manual entry's amounts, after "Show amounts". */
export interface PayrollManualEntryAmount {
  id: string;
  amountCentavos: Centavos;
  computedAmountCentavos: Centavos | null;
}

/** What "Show amounts" sends: each person's net pay, the totals and the manual entries' amounts. */
export interface PayrollAmounts {
  /** The run's version the amounts belong to; the page drops them when it changes. */
  version: number;
  netPay: { lineId: string; netPayCentavos: Centavos }[];
  totals: PayrollTotals;
  manualEntries: PayrollManualEntryAmount[];
}

function amountsOf(view: PayrollRunView): PayrollAmounts | null {
  if (!view.totals) return null;
  return {
    version: view.version,
    netPay: view.people.flatMap((person) =>
      person.netPayCentavos === null
        ? []
        : [{ lineId: person.lineId, netPayCentavos: person.netPayCentavos }],
    ),
    totals: view.totals,
    manualEntries: view.manualEntries.flatMap((entry) =>
      entry.amountCentavos === null
        ? []
        : [
            {
              id: entry.id,
              amountCentavos: entry.amountCentavos,
              computedAmountCentavos: entry.computedAmountCentavos,
            },
          ],
    ),
  };
}

/**
 * "Show amounts": writes and commits a `reveal` on the run (field `amounts`), then answers each
 * person's net pay, the totals and each manual entry's amount. HR, Accounting and the System
 * Administrator (Talent Read) get the payroll view; anyone else goes through the Board's view,
 * which answers only while they are a pending approver of the run's request and refuses before
 * any `reveal` otherwise. Null when the run is gone.
 */
export const showPayrollAmountsAction = defineAction({
  access: signedIn,
  schema: z.object({ runId: runIdField }),
  handler: async ({ runId }): Promise<PayrollAmounts | null> => {
    const user = await signedInUser();
    const view = canSeePayrollRuns(user)
      ? await getPayrollRunView(user, runId, { showAmounts: true })
      : await getPayrollRunApproverView(user, runId, { showAmounts: true });
    return view ? amountsOf(view) : null;
  },
});

/**
 * Opens one person's breakdown: writes and commits a `reveal` on the line (field `breakdown`),
 * then answers it. Null when the line is gone or isn't in `runId`. Never for the Board's view.
 */
export const getPayrollBreakdownAction = defineAction({
  access: payrollReaders,
  schema: z.object({ runId: runIdField, lineId: lineIdField }),
  handler: async ({ runId, lineId }): Promise<PayrollRunBreakdownView | null> => {
    const user = await signedInUser();
    // The service refuses a line from another run before it writes the reveal.
    return getPayrollRunBreakdown(user, lineId, { runId });
  },
});

/** "Acknowledge" one person's flag, with a reason. Answers how many were acknowledged. */
export const acknowledgePayrollFlagAction = defineAction({
  access: flagAcknowledgers,
  schema: z.object({
    runId: runIdField,
    employeeId: employeeIdField,
    flag: flagField,
    reason: reasonField,
  }),
  handler: async (input) => {
    const user = await signedInUser();
    const done = await acknowledgePayrollFlag(user, input);
    revalidateRun(input.runId);
    return done;
  },
});

/** "Acknowledge all" on a flag's tile, with one reason. Answers how many were acknowledged. */
export const acknowledgeAllPayrollFlagAction = defineAction({
  access: flagAcknowledgers,
  schema: z.object({ runId: runIdField, flag: flagField, reason: reasonField }),
  handler: async (input) => {
    const user = await signedInUser();
    const done = await acknowledgeAllPayrollFlag(user, input);
    revalidateRun(input.runId);
    return done;
  },
});

/** The manual entry sheet's values, shaped for the services (amounts in whole centavos). */
function serviceValuesOf(values: PayrollManualEntryValues): PayrollManualEntryInputValues {
  switch (values.kind) {
    case 'earning':
      return {
        kind: 'earning',
        label: values.label ?? '',
        amountCentavos: values.amountCentavos,
        taxable: values.taxable ?? false,
        countsAsBasicSalary: values.countsAsBasicSalary ?? false,
        reason: values.reason,
      };
    case 'deduction':
      return {
        kind: 'deduction',
        label: values.label ?? '',
        amountCentavos: values.amountCentavos,
        reducesTaxablePay: values.reducesTaxablePay ?? false,
        authorizedInWriting: values.authorizedInWriting ?? false,
        countsAsBasicSalary: values.countsAsBasicSalary ?? false,
        reason: values.reason,
      };
    case 'override':
      return {
        kind: 'override',
        targetLineKey: values.targetLineKey ?? '',
        amountCentavos: values.amountCentavos,
        reason: values.reason,
      };
  }
}

/** "Add manual entry" on a person's line (the amount typed in pesos). Answers the run's version. */
export const addPayrollManualEntryAction = defineAction({
  access: manualEntryWriters,
  schema: z.intersection(
    z.object({ runId: runIdField, employeeId: employeeIdField }),
    payrollManualEntryFormSchema,
  ),
  handler: async (input) => {
    const user = await signedInUser();
    const { runId, employeeId, ...values } = input;
    const saved = await addPayrollManualEntry(user, {
      runId,
      employeeId,
      ...serviceValuesOf(values),
    });
    revalidateRun(saved.runId);
    return { entryId: saved.entryId, version: saved.version };
  },
});

/** "Edit" a live manual entry (a new entry superseding it). Answers the run's version. */
export const editPayrollManualEntryAction = defineAction({
  access: manualEntryWriters,
  schema: z.intersection(
    z.object({ runId: runIdField, entryId: entryIdField }),
    payrollManualEntryFormSchema,
  ),
  handler: async (input) => {
    const user = await signedInUser();
    const { runId, entryId, ...values } = input;
    const saved = await editPayrollManualEntry(user, {
      runId,
      entryId,
      ...serviceValuesOf(values),
    });
    revalidateRun(saved.runId);
    return { entryId: saved.entryId, version: saved.version };
  },
});

/** "Remove" a live manual entry, with a reason. Answers the run's version. */
export const removePayrollManualEntryAction = defineAction({
  access: manualEntryWriters,
  schema: z.object({ runId: runIdField, entryId: entryIdField, reason: reasonField }),
  handler: async (input) => {
    const user = await signedInUser();
    const saved = await removePayrollManualEntry(user, input);
    revalidateRun(saved.runId);
    return { entryId: saved.entryId, version: saved.version };
  },
});

/**
 * "Submit for approval": the run version the page shows. Answers the new version; a refusal
 * (cut-off order, a changed run, the recompute at submit, flags, no employee, no Board member)
 * comes back in the service's words.
 */
export const submitPayrollRunAction = defineAction({
  access: payrollSubmitters,
  schema: z.object({
    runId: runIdField,
    version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  }),
  handler: async ({ runId, version }) => {
    const user = await signedInUser();
    try {
      const submitted = await submitPayrollRun(user, { runId, version });
      return { id: submitted.id, version: submitted.version };
    } finally {
      // A refused submit may have saved a recompute (the page must load it again).
      revalidateRun(runId);
    }
  },
});

/**
 * "Show register": writes and commits a `reveal` on the run (field `register`), then answers the
 * register with each person's bank, account name, full account number and net pay. Null when the
 * run is gone.
 */
export const showPayrollRegisterAction = defineAction({
  access: registerReaders,
  schema: z.object({ runId: runIdField }),
  handler: async ({ runId }): Promise<PayrollRegisterView | null> => {
    const user = await signedInUser();
    return getPayrollRegister(user, runId, { show: true });
  },
});
