import { House, type LucideIcon } from 'lucide-react';
import type { AuditAction, AuditModule } from '@pulse/core';
import { MODULE_ENTRIES } from './navigation';

// Display names and icons for what audit entries and notifications belong to: Pulse Core or one of
// the modules (`AUDIT_MODULES`), and the audit actions (`AUDIT_ACTIONS`).

const CORE = { title: 'Pulse Core', Icon: House } as const;

/** The module's full name and sidebar icon, e.g. "Pulse Talent". */
export function moduleDisplay(module: AuditModule): { title: string; Icon: LucideIcon } {
  if (module === 'core') return CORE;
  const entry = MODULE_ENTRIES.find((candidate) => candidate.href === `/${module}`);
  return entry ? { title: entry.title, Icon: entry.Icon } : CORE;
}

const ACTION_LABELS: Record<AuditAction, string> = {
  create: 'Created',
  update: 'Updated',
  delete: 'Deleted',
  restore: 'Restored',
  reveal: 'Revealed',
  export: 'Exported',
  passwordChange: 'Password changed',
  passwordReset: 'Password reset',
  accessChange: 'Access changed',
};

/** The audit action as people read it, e.g. "Password changed". */
export function auditActionLabel(action: AuditAction): string {
  return ACTION_LABELS[action];
}
