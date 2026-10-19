'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { type AccessCheck, type Centavos, defineAction, OBJECT_ID_PATTERN } from '@pulse/core';
import type { PayrollTotals } from '@pulse/talent';
import {
  assertCanComputePayrollRuns,
  assertCanSeePayrollRuns,
  createPayrollDraftRun,
  getPayrollRunBreakdown,
  getPayrollRunView,
  PAYROLL_CUT_OFF_INVALID,
  PAYROLL_LINE_GONE,
  PAYROLL_RUN_GONE,
  type PayrollRunBreakdownView,
  payrollRunHref,
  recomputePayrollRun,
} from '@pulse/talent/server';
import { signedInUser } from '@/lib/auth';
import { PAYROLL_HREF } from '@/lib/navigation';

// Spec: docs/modules/talent.md#payroll-run-computation-build-step-29 ("Creating a draft",
// "Recomputing a draft", "Who may see and do what", "Screens"; decisions 341–343 in
// docs/BUILD_PLAN.md) and SECURITY.md#sensitive-data ("Payroll runs") — the Server Actions behind
// `/talent/payroll` and `/talent/payroll/<runId>`.
//
// - Access is checked here first, against the signed-in user: seeing runs needs Talent Read and
//   HR, Accounting or the System Administrator (`assertCanSeePayrollRuns`); "Compute draft run"
//   and "Recompute" need Talent Write and HR or the System Administrator
//   (`assertCanComputePayrollRuns`). The services check again, and the compute services re-read
//   the account in their transaction.
// - Amounts leave the server only from the two explicit reveal actions: "Show amounts"
//   (`showPayrollAmountsAction`, which writes and commits a `reveal` on the run first) and opening
//   one person's breakdown (`getPayrollBreakdownAction`, a `reveal` on the line first). Pages never
//   call them while rendering, so a reload or a revalidation never reveals anything. Creating and
//   recomputing answer only the run's id, number or version.
// - No amount, name or breakdown is put in a URL, a log or a cache here. Refusals come back in
//   the services' words.

const runIdField = z
  .string({ error: PAYROLL_RUN_GONE })
  .max(100)
  .regex(OBJECT_ID_PATTERN, PAYROLL_RUN_GONE);
const lineIdField = z
  .string({ error: PAYROLL_LINE_GONE })
  .max(100)
  .regex(OBJECT_ID_PATTERN, PAYROLL_LINE_GONE);

/** Talent Read and HR, Accounting or the System Administrator. */
const payrollReaders: AccessCheck = async () => {
  assertCanSeePayrollRuns(await signedInUser());
};

/** Talent Write and HR or the System Administrator. */
const payrollComputers: AccessCheck = async () => {
  assertCanComputePayrollRuns(await signedInUser());
};

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

/** "Recompute" on a draft. Answers the run's new version only. */
export const recomputePayrollRunAction = defineAction({
  access: payrollComputers,
  schema: z.object({ runId: runIdField }),
  handler: async ({ runId }) => {
    const user = await signedInUser();
    const done = await recomputePayrollRun(user, { runId });
    revalidatePath(PAYROLL_HREF);
    revalidatePath(payrollRunHref(done.id));
    return { id: done.id, version: done.version };
  },
});

/** What "Show amounts" sends: each person's net pay and the run's totals, for one version. */
export interface PayrollAmounts {
  /** The run's version the amounts belong to; the page drops them when it changes. */
  version: number;
  netPay: { lineId: string; netPayCentavos: Centavos }[];
  totals: PayrollTotals;
}

/**
 * "Show amounts": writes and commits a `reveal` on the run (field `amounts`), then answers each
 * person's net pay and the totals. Null when the run is gone.
 */
export const showPayrollAmountsAction = defineAction({
  access: payrollReaders,
  schema: z.object({ runId: runIdField }),
  handler: async ({ runId }): Promise<PayrollAmounts | null> => {
    const user = await signedInUser();
    const view = await getPayrollRunView(user, runId, { showAmounts: true });
    if (!view || !view.totals) return null;
    return {
      version: view.version,
      netPay: view.people.flatMap((person) =>
        person.netPayCentavos === null
          ? []
          : [{ lineId: person.lineId, netPayCentavos: person.netPayCentavos }],
      ),
      totals: view.totals,
    };
  },
});

/**
 * Opens one person's breakdown: writes and commits a `reveal` on the line (field `breakdown`),
 * then answers it. Null when the line is gone or isn't in `runId`.
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
