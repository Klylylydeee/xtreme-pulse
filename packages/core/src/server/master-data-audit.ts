import { AUDIT_LABEL_MAX_LENGTH } from '../audit';
import type { MasterDataActor } from './master-data-access';

// Spec: SECURITY.md#audit-logging and docs/modules/core.md#managing-master-data (decision 96 in
// docs/BUILD_PLAN.md) — helpers shared by the master data services for their audit entries. A
// label that joins two names (`<client> · <site>`, `<client> · <contact>`,
// `<product> · <part number>`) can be longer than the audit log allows, so it is cut to fit.

/**
 * Joins the parts of an audit label with ` · `, cut to the audit log's label limit with `…`.
 */
export function auditLabel(...parts: string[]): string {
  const label = parts.join(' · ');
  return label.length <= AUDIT_LABEL_MAX_LENGTH
    ? label
    : `${label.slice(0, AUDIT_LABEL_MAX_LENGTH - 1)}…`;
}

/** Who did it, for the audit entry. */
export function auditActor(actor: MasterDataActor): { actorId: string; actorEmail: string } {
  return { actorId: actor.id, actorEmail: actor.email };
}
