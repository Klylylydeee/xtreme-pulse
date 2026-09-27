// Spec: docs/modules/talent.md#timesheet-types — the two timesheet types. Kept in @pulse/core
// because each position carries one (docs/modules/core.md#departments-and-positions); Talent reads
// it from the position.
export const TIMESHEET_TYPES = ['overtime', 'standard'] as const;
export type TimesheetType = (typeof TIMESHEET_TYPES)[number];
