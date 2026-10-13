'use server';

import { defineAction } from '@pulse/core';
import { checkReceiptSchema } from '@pulse/talent';
import { checkReceipt } from '@pulse/talent/server';
import { requireModuleAccess, signedInUser } from '@/lib/auth';

// Spec: docs/modules/talent.md#reimbursements-build-step-25 ("Check a receipt"; decisions 241,
// 245 and 252 in docs/BUILD_PLAN.md) and docs/RUNBOOK.md#a-receipt-was-rejected-as-a-duplicate —
// the Server Action behind "Check a receipt" on `/talent`.
//
// - Talent Read, checked here first; the service checks it again and throws AccessDeniedError
//   for anyone else. The claimant's name is shown only here, never to the employee whose receipt
//   was refused (SECURITY.md#sensitive-data, "Reimbursements").
// - The merchant TIN and the receipt or invoice number are checked with the service's own schema,
//   so their errors come back inline. Null means nobody has claimed the receipt.
// - Nothing here is sensitive, logged, cached or audit-logged (decision 246).

const TALENT_READ = 'You don’t have access to Pulse Talent. Ask HR or the System Administrator.';

const talentReaders = requireModuleAccess('talent', 'read', TALENT_READ);

/** "Check a receipt": the live claim of a merchant TIN and receipt number, or null. */
export const checkReceiptAction = defineAction({
  access: talentReaders,
  schema: checkReceiptSchema,
  handler: async (input) => checkReceipt(await signedInUser(), input),
});
