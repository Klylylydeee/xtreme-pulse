'use server';

import { z } from 'zod';
import { AUDIT_PAGE_MAX, auditFiltersSchema, defineAction } from '@pulse/core';
import { listAuditEntries } from '@pulse/core/server';
import { systemAdministratorOnly } from '@/lib/auth';

// Spec: docs/modules/core.md#audit-log — the audit log, for the System Administrator only until
// module access arrives in step 1.6. Viewing it is not audit-logged.

/** One page of the audit log, newest first, with the page's filters. */
export const listAuditEntriesAction = defineAction({
  access: systemAdministratorOnly(),
  schema: z.intersection(
    auditFiltersSchema,
    z.object({
      cursor: z.string().max(200).nullish(),
      limit: z.coerce.number().int().min(1).max(AUDIT_PAGE_MAX).optional(),
    }),
  ),
  handler: async ({ cursor, limit, ...filters }) =>
    listAuditEntries(filters, { cursor: cursor ?? null, limit }),
});
