import { z } from 'zod';
import { OBJECT_ID_PATTERN } from './audit';
import { TIMESHEET_TYPES, type TimesheetType } from './timesheet-types';

// Spec: docs/modules/core.md#managing-departments-and-positions — the department and position
// forms. Pure code, safe in the browser, so the sheets and the services check the same rules. The
// services are server-only (`@pulse/core/server`).

/** A department code: 2 to 10 capital letters or digits, starting with a letter. Never changes. */
export const DEPARTMENT_CODE_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/;
export const DEPARTMENT_CODE_HELP =
  'Use 2 to 10 capital letters or digits, starting with a letter.';
export const DEPARTMENT_NAME_MAX_LENGTH = 100;
export const POSITION_NAME_MAX_LENGTH = 100;

// Spec: docs/modules/talent.md#timesheet-types — shown as a segmented control, Standard first.
export const TIMESHEET_TYPE_OPTIONS: readonly TimesheetType[] = ['standard', 'overtime'];
export const TIMESHEET_TYPE_LABELS: Readonly<Record<TimesheetType, string>> = {
  standard: 'Standard',
  overtime: 'Overtime',
};
/** Under the timesheet type: a change applies from the next cut-off, never in the middle of one. */
export const TIMESHEET_TYPE_CHANGE_NOTE = 'Takes effect from the next cut-off.';

const departmentName = z
  .string({ error: 'Enter the department name.' })
  .trim()
  .min(1, 'Enter the department name.')
  .max(DEPARTMENT_NAME_MAX_LENGTH, `Use ${DEPARTMENT_NAME_MAX_LENGTH} characters or fewer.`);

const departmentCode = z
  .string({ error: 'Enter a code.' })
  .trim()
  .toUpperCase()
  .min(1, 'Enter a code.')
  .regex(DEPARTMENT_CODE_PATTERN, DEPARTMENT_CODE_HELP);

// Optional: an empty value (a cleared picker) means no head.
const departmentHead = z
  .union([z.literal(''), z.string().regex(OBJECT_ID_PATTERN, 'Choose the department head again.')])
  .nullable()
  .optional()
  .transform((value) => (value ? value : null));

const positionName = z
  .string({ error: 'Enter the position name.' })
  .trim()
  .min(1, 'Enter the position name.')
  .max(POSITION_NAME_MAX_LENGTH, `Use ${POSITION_NAME_MAX_LENGTH} characters or fewer.`);

// Each *Input type is what a service takes: the form's values as sent (the service parses them
// again with the same schema).

const timesheetType = z.enum(TIMESHEET_TYPES, { error: 'Choose a timesheet type.' });

/** Adding a department: the name, the code (fixed from then on) and an optional head. */
export const departmentInputSchema = z.object({
  name: departmentName,
  code: departmentCode,
  headEmployeeId: departmentHead,
});
export type DepartmentInput = z.input<typeof departmentInputSchema>;

/** Editing a department: only the name and the head. The code can't be changed. */
export const departmentUpdateSchema = departmentInputSchema.omit({ code: true });
export type DepartmentUpdateInput = z.input<typeof departmentUpdateSchema>;

/** Adding a position: its department (fixed from then on), name and timesheet type. */
export const positionInputSchema = z.object({
  departmentId: z
    .string({ error: 'Choose a department.' })
    .regex(OBJECT_ID_PATTERN, 'Choose a department.'),
  name: positionName,
  timesheetType,
});
export type PositionInput = z.input<typeof positionInputSchema>;

/** Editing a position: only the name and the timesheet type. The department can't be changed. */
export const positionUpdateSchema = positionInputSchema.omit({ departmentId: true });
export type PositionUpdateInput = z.input<typeof positionUpdateSchema>;
