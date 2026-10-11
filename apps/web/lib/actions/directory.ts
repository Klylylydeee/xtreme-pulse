'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { defineAction, OBJECT_ID_PATTERN, reportingLinesInputSchema } from '@pulse/core';
import {
  getDirectoryPerson,
  searchSupervisorCandidates,
  setReportingLines,
} from '@pulse/core/server';
import { reportingLineEditorsOnly, requireSignedIn, signedInUser } from '@/lib/auth';
import { withListFields } from '@/lib/reporting-to-list';

// Spec: docs/modules/core.md#company-directory, #org-chart and #reporting-lines (build step 1.11).
// The directory and the org chart are Pulse Core pages open to every signed-in user
// (SECURITY.md#rules), so reading a card checks only that someone is signed in; the directory
// service builds it from directory fields only and decides who may see a separated person.
// Editing reporting lines in the inspector is for HR, Board members and System Administrators,
// checked by role here (`reportingLineEditorsOnly`) and again in the services, which also refuse
// one's own lines, the system account and a separated employee. A save is audit-logged by the
// service in its transaction; reading a card and searching are neither audit-logged nor logged,
// and nothing here is cached (decision 152).

const PERSON_GONE = 'This person no longer exists. Reload the page.';

/**
 * One person's directory card for the inspector, or null when there is no such person or the
 * viewer may not see them (the same answer, so separated people can't be probed). Any string: the
 * id may come from a hand-edited `?person=` link, and the service returns null for a bad one.
 */
export const getDirectoryPersonAction = defineAction({
  access: requireSignedIn(),
  schema: z.object({ id: z.string().max(100) }),
  handler: async ({ id }) => getDirectoryPerson(await signedInUser(), id),
});

/**
 * Saves a person's reporting lines from the inspector. The form posts one `reportingTo` field per
 * supervisor (as the supervisor picker does) and one `expected` field per supervisor it opened
 * with, both in order; a save whose `expected` no longer matches the stored lines is refused (the
 * stale-form message). The service checks the rest and writes the one `update` audit entry.
 */
export const setReportingLinesAction = defineAction({
  access: reportingLineEditorsOnly(
    'Only HR, the Board and the System Administrator can change reporting lines.',
  ),
  schema: z.preprocess(
    (raw) => withListFields(raw, ['reportingTo', 'expected']),
    z.object({
      employeeId: z.string({ error: PERSON_GONE }).regex(OBJECT_ID_PATTERN, PERSON_GONE),
      reportingTo: reportingLinesInputSchema.shape.supervisorIds,
      expected: reportingLinesInputSchema.shape.expected,
    }),
  ),
  handler: async ({ employeeId, reportingTo, expected }) => {
    const result = await setReportingLines(await signedInUser(), employeeId, {
      supervisorIds: reportingTo,
      expected,
    });
    // Reporting lines show on the directory, the org chart, Home's team tile and /admin/users.
    if (result.changed) revalidatePath('/', 'layout');
    return result;
  },
});

/**
 * The inspector's supervisor search (decision 142): active employees by name or employee number,
 * at most 20, without the person being edited. For the reporting line editors only;
 * `/admin/users` keeps its own search (`searchSupervisorsAction`).
 */
export const searchReportingLineSupervisorsAction = defineAction({
  access: reportingLineEditorsOnly(
    'Only HR, the Board and the System Administrator can change reporting lines.',
  ),
  schema: z.object({
    search: z.string().trim().max(100).default(''),
    excludeEmployeeId: z.string().regex(OBJECT_ID_PATTERN).nullable().optional(),
  }),
  handler: async ({ search, excludeEmployeeId }) =>
    searchSupervisorCandidates(await signedInUser(), {
      search,
      excludeEmployeeId: excludeEmployeeId ?? null,
    }),
});
