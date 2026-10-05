'use server';

import { z } from 'zod';
import { AUDIT_PAGE_MAX, auditFiltersSchema, defineAction } from '@pulse/core';
import { listAuditEntries } from '@pulse/core/server';
import { adminOnly } from '@/lib/auth';

// Spec: docs/modules/core.md#audit-log — the audit log, for the System Administrator only (an admin
// area role, checked here rather than module access: SECURITY.md#resolving-and-enforcing-build-step-16).
// Viewing it is not audit-logged.

const ONLY_SYSTEM_ADMINISTRATOR = 'Only the System Administrator can do this.';

/** One page of the audit log, newest first, with the page's filters. */
export const listAuditEntriesAction = defineAction({
  access: adminOnly('systemAdministrator', ONLY_SYSTEM_ADMINISTRATOR),
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
