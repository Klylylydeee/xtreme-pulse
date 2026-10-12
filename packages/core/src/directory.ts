import { z } from 'zod';
import { OBJECT_ID_PATTERN } from './audit';
import { MAX_SUPERVISORS } from './user-accounts';

// The company directory, the org chart and the command bar (build step 1.11): the result shapes,
// the fixed sets and the reporting line form schema. Pure code, safe in the browser. The services
// are server-only, in `@pulse/core/server`.
//
// Spec: docs/modules/core.md#company-directory, #org-chart, #command-bar and #home, and
// SECURITY.md#sensitive-data (the directory allowlist, decision 134 in docs/BUILD_PLAN.md). Every
// result here holds directory fields only: name, initials, the profile photo's URL (build step
// 2.2), employee number, department, position, login email, reporting lines and direct reports,
// plus the "Inactive" flag. The date hired, employment status, separation date, module access and every
// Pulse Talent field never appear in them.

// --- The directory ---------------------------------------------------------------------------

/** A person named on a card ("Reports to", "Direct reports"), the Home team tile or a list row. */
export interface DirectoryPersonLink {
  /** The employee ID; `/directory?person=<id>` opens their card. */
  id: string;
  /** `First Last`. */
  name: string;
  /** The first letter of the first name and of the last name. */
  initials: string;
  /** The current profile photo (`/files/<id>?inline=1`), or null: show the initials. */
  photoUrl: string | null;
  employeeNumber: string;
  departmentName: string | null;
  positionName: string | null;
  /**
   * True for a stored line to someone who isn't active. Only HR, Board members and System
   * Administrators (the reporting line editors) ever see one, on a card's "Reports to"; for anyone
   * else it is always false.
   */
  inactive: boolean;
}

/** One person in the directory list. */
export interface DirectoryPerson {
  /** The employee ID. */
  id: string;
  /** `First Last`. */
  name: string;
  initials: string;
  /** The current profile photo, or null. */
  photoUrl: string | null;
  employeeNumber: string;
  departmentId: string;
  departmentName: string | null;
  /** The department's code, for example `BOD` (the "No supervisor" hint is for non-Board staff). */
  departmentCode: string | null;
  positionName: string | null;
  /** The login email; null only for an employee with no account (shown to HR only, as inactive). */
  email: string | null;
  /** Active supervisors, in the stored order. */
  reportingTo: DirectoryPersonLink[];
  /** Active people whose `reportingTo` names this person, by last name. */
  directReports: DirectoryPersonLink[];
  /** True for a separated person, shown only to HR and System Administrators ("Inactive"). */
  inactive: boolean;
}

/** One person's directory card, in the inspector. */
export interface DirectoryCard extends DirectoryPerson {
  /**
   * True when the viewer may edit this person's reporting lines here: HR, a Board member or a
   * System Administrator, not their own, and the person is active. The service checks again.
   */
  canEditReportingLines: boolean;
}

/** The Home "Your team" tile: the user's active supervisors and active direct reports. */
export interface OwnTeam {
  supervisors: DirectoryPersonLink[];
  directReports: DirectoryPersonLink[];
}

/** A department in the directory and org chart filter. */
export interface DirectoryDepartmentOption {
  id: string;
  name: string;
}

/** A person the inspector's supervisor picker offers. */
export interface SupervisorCandidate {
  /** The employee ID. */
  id: string;
  name: string;
  employeeNumber: string;
  departmentName: string | null;
}

// --- The org chart ---------------------------------------------------------------------------

/** A supervisor outside the department filter, for the "Reports to <names>" caption. */
export interface OrgChartExternalSupervisor {
  id: string;
  name: string;
}

/** One person on the org chart. Active people only. */
export interface OrgChartNode {
  /** The employee ID; the card opens `/org-chart?person=<id>`. */
  id: string;
  name: string;
  initials: string;
  /** The current profile photo, or null. */
  photoUrl: string | null;
  departmentId: string;
  departmentName: string | null;
  positionName: string | null;
  /**
   * The supervisors drawn as lines, in the stored order: active, and on the chart (in the
   * department, when it is filtered). Empty puts the person at the top level.
   */
  supervisorIds: string[];
  /**
   * With a department filter, the active supervisors outside the department, in the stored
   * order; always empty without one. When `supervisorIds` is empty and this isn't, the card shows
   * "Reports to <names>".
   */
  externalSupervisors: OrgChartExternalSupervisor[];
}

// --- Reporting lines ---------------------------------------------------------------------------

const employeeIdField = z
  .string()
  .regex(OBJECT_ID_PATTERN, 'One of the chosen supervisors doesn’t exist. Reload the page.');

/**
 * What the inspector's Save sends: the new supervisors, and the ones it opened with (`expected`),
 * both in order. The service checks the rest (docs/modules/core.md#reporting-lines).
 */
export const reportingLinesInputSchema = z.object({
  supervisorIds: z
    .array(employeeIdField)
    .max(MAX_SUPERVISORS, `Choose at most ${MAX_SUPERVISORS} supervisors.`),
  expected: z.array(employeeIdField).max(100),
});

export type ReportingLinesInput = z.infer<typeof reportingLinesInputSchema>;

/** The error when someone else saved the lines since the inspector opened them. */
export function reportingLinesChangedMessage(name: string): string {
  return `Someone else changed ${name}’s reporting lines since you opened them. Reload to see the change.`;
}

/** The refusal on one's own card. */
export const OWN_REPORTING_LINES = 'You can’t change your own reporting lines.';

// --- The command bar ---------------------------------------------------------------------------

/** What a provider adds to the command bar: records (people, later each module's) or actions. */
export const COMMAND_PROVIDER_KINDS = ['records', 'actions'] as const;
export type CommandProviderKind = (typeof COMMAND_PROVIDER_KINDS)[number];

/**
 * The icon a result names. Icons can't cross from the server, so a result names one of these and
 * the command bar maps it to a component. Later modules add their keys here as they register.
 */
export const COMMAND_ICONS = ['person', 'action'] as const;
export type CommandIcon = (typeof COMMAND_ICONS)[number];

/** True for one of {@link COMMAND_ICONS}. */
export function isCommandIcon(value: unknown): value is CommandIcon {
  return typeof value === 'string' && (COMMAND_ICONS as readonly string[]).includes(value);
}

/** The command bar searches from this many characters. */
export const COMMAND_QUERY_MIN_LENGTH = 2;
/** A longer query is cut to this many characters. */
export const COMMAND_QUERY_MAX_LENGTH = 100;
/** The most results one provider returns. */
export const COMMAND_PROVIDER_RESULT_LIMIT = 8;
/** How long the command bar waits after the last key before it searches. */
export const COMMAND_SEARCH_DELAY_MS = 200;

/** One command bar entry: a link inside the app. */
export interface CommandResult {
  /** Unique within its provider. */
  id: string;
  title: string;
  subtitle: string | null;
  /** A path inside the app (the notification link rule). */
  href: string;
  icon: CommandIcon;
  /**
   * A picture for the result (a person's profile photo, `/files/<id>?inline=1`), or null for the
   * icon alone. Only a `/files/` path is kept.
   */
  photoUrl: string | null;
}

/** One provider's results, in the order the providers were registered (People first). */
export interface CommandResultGroup {
  /** The provider's key, for example `core.people`. */
  key: string;
  /** The group heading, for example "People". */
  group: string;
  kind: CommandProviderKind;
  results: CommandResult[];
}

/** The People result's link: the person's directory card. */
export function directoryPersonHref(employeeId: string): string {
  return `/directory?person=${encodeURIComponent(employeeId)}`;
}

/** The first letter of the first name and of the last name, in capitals. */
export function initialsOf(person: { firstName: string; lastName: string }): string {
  const first = Array.from(person.firstName.trim())[0] ?? '';
  const last = Array.from(person.lastName.trim())[0] ?? '';
  return `${first}${last}`.toUpperCase();
}
