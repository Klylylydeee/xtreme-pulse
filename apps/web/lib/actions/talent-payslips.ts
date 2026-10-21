'use server';

import { z } from 'zod';
import { ActionError, defineAction } from '@pulse/core';
import { openPayslipHref } from '@pulse/talent/server';
import { requireSignedIn, signedInUser } from '@/lib/auth';

// Spec: docs/modules/talent.md#payroll-review-approval-and-payslips-build-step-210 ("Payslips":
// self-service and who opens a payslip) and SECURITY.md#exceptions-to-module-access — "Open
// payslip" on `/talent/me#payslips`. Self-service, outside module access: the action needs only a
// signed-in user (`requireSignedIn`). It takes the payslip's line id, never an employee id;
// `openPayslipHref` checks the user may open that line (their own, or Talent Read and HR,
// Accounting or the System Administrator), renders the PDF if it isn't rendered yet, and returns
// its file route URL. A missing, unfinalized or refused line gets the same answer, so ids can't be
// probed. Opening the URL is what writes the `reveal` entry (the file route's `auditView`); this
// action writes none, returns no file contents and logs nothing.

const NOT_FOUND = 'This payslip isn’t available. Reload the page.';

/** "Open payslip": the payslip PDF's file route URL (`/files/<id>`), rendering it first if needed. */
export const openPayslipAction = defineAction({
  access: requireSignedIn(),
  schema: z.object({ lineId: z.string().regex(/^[0-9a-f]{24}$/i, NOT_FOUND) }),
  handler: async ({ lineId }) => {
    const href = await openPayslipHref(await signedInUser(), lineId);
    if (!href) throw new ActionError(NOT_FOUND);
    return { href };
  },
});
