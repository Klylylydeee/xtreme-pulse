import type { AuditModule } from '../../audit';

// Which sensitive fields can be revealed, and how (SECURITY.md#sensitive-data). The module that
// owns a record with sensitive fields registers each one it lets users reveal, with its category,
// when its service module loads. `revealSensitiveField` refuses any record type or field that
// isn't registered, so a reveal can only reach what a module chose to expose.

/** The kinds of sensitive data the reveal rules talk about (SECURITY.md#sensitive-data). */
export const SENSITIVE_CATEGORIES = [
  'salary',
  'allowances',
  'governmentId',
  'bankAccount',
  'payslip',
  'medical',
  'file201',
  'disciplinary',
] as const;
export type SensitiveCategory = (typeof SENSITIVE_CATEGORIES)[number];

/** The employee a sensitive value belongs to, for the reveal rules. */
export interface SensitiveSubject {
  employeeId: string;
  /** The employee's department code (`HR` matters for the Board rule); null for none. */
  departmentCode: string | null;
}

export interface SensitiveRevealDefinition {
  /** The module that owns the record, for the audit entry. */
  module: AuditModule;
  /** Each field that may be revealed, with its category. Any other field is refused. */
  fields: Readonly<Record<string, SensitiveCategory>>;
  /**
   * The stored (encrypted) value of `field` on the record, or null when the record or the value
   * doesn't exist. Load it with `.select('+field')`; never decrypt here.
   */
  loadValue(ownerId: string, field: string): Promise<unknown>;
  /** The employee the record belongs to, or null for a record that belongs to no employee. */
  subject(ownerId: string): Promise<SensitiveSubject | null>;
  /** Something to show for the record in the audit log, such as an employee number. */
  label?(ownerId: string): Promise<string | null>;
}

// Per process (and per bundle, since Next evaluates server modules once per bundle; each bundle's
// own registrations then fill its own copy).
const registry = new Map<string, SensitiveRevealDefinition>();

const OWNER_TYPE = /^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*$/;

/**
 * Lets users reveal the listed sensitive fields of records of `ownerType` (`<module>.<name>`, for
 * example `talent.employeeRecord`), through `revealSensitiveField`. Registering the same type
 * again replaces it (a development hot reload evaluates the module again).
 */
export function registerSensitiveReveal(
  ownerType: string,
  definition: SensitiveRevealDefinition,
): void {
  if (!OWNER_TYPE.test(ownerType)) {
    throw new Error(`"${ownerType}" isn't a record type. Use <module>.<name>, like core.user.`);
  }
  registry.set(ownerType, definition);
}

/** The registration for `ownerType` and the category of `field`, or null when either is unknown. */
export function findSensitiveReveal(
  ownerType: string,
  field: string,
): { definition: SensitiveRevealDefinition; category: SensitiveCategory } | null {
  const definition = registry.get(ownerType);
  if (!definition || !Object.hasOwn(definition.fields, field)) return null;
  const category = definition.fields[field];
  return category ? { definition, category } : null;
}
