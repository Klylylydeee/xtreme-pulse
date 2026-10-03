import { z } from 'zod';
import { isBusinessDate } from './dates';
import { MODULES, type ModuleKey } from './modules';

// The audit log's fixed lists and the filters for browsing it (docs/modules/core.md#audit-log).
// Pure code, safe in the browser, so the audit log page's filters can use the same lists. The
// service that writes and reads entries is server-only (`recordAudit` and `listAuditEntries` in
// `@pulse/core/server`).

/** What an audit entry or a notification belongs to: Pulse Core or one of the modules. */
export const AUDIT_MODULES = ['core', ...MODULES] as const;
export type AuditModule = 'core' | ModuleKey;

/**
 * Every audit action. A fixed list: adding one is a spec change (docs/modules/core.md#audit-log).
 */
export const AUDIT_ACTIONS = [
  'create',
  'update',
  'delete',
  'restore',
  'reveal',
  'export',
  'passwordChange',
  'passwordReset',
  'accessChange',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** A record type: `<module>.<name>`, for example `core.user` or `talent.employeeRecord`. */
export const RECORD_TYPE_PATTERN = /^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*$/;
export const RECORD_TYPE_MAX_LENGTH = 100;
/** The longest reason an entry keeps. */
export const AUDIT_REASON_MAX_LENGTH = 1000;
/** The longest label (an email, a document number) an entry keeps for its record. */
export const AUDIT_LABEL_MAX_LENGTH = 200;

/** A MongoDB ObjectId as 24 hexadecimal characters. */
export const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;

/** The most entries one page of the audit log returns. */
export const AUDIT_PAGE_MAX = 100;

const optionalText = (schema: z.ZodString) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

/**
 * The audit log filters, as the page's search params or a Server Action send them. Empty values
 * mean "any". `from` and `to` are Manila calendar days, both included.
 */
export const auditFiltersSchema = z
  .object({
    from: optionalText(z.string().refine(isBusinessDate, { message: 'Enter a valid start date.' })),
    to: optionalText(z.string().refine(isBusinessDate, { message: 'Enter a valid end date.' })),
    actorId: optionalText(z.string().regex(OBJECT_ID_PATTERN, 'Choose a user from the list.')),
    module: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.enum(AUDIT_MODULES, { error: 'Choose a module from the list.' }).optional(),
    ),
    action: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.enum(AUDIT_ACTIONS, { error: 'Choose an action from the list.' }).optional(),
    ),
    recordType: optionalText(
      z
        .string()
        .max(RECORD_TYPE_MAX_LENGTH)
        .regex(RECORD_TYPE_PATTERN, 'Enter a record type like core.user.'),
    ),
    recordId: optionalText(z.string().regex(OBJECT_ID_PATTERN, 'Enter a valid record id.')),
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    path: ['to'],
    message: 'The end date can’t be before the start date.',
  });

export type AuditFilters = z.output<typeof auditFiltersSchema>;
