import { Types } from 'mongoose';
import {
  AUDIT_LABEL_MAX_LENGTH,
  type BusinessDate,
  startOfBusinessDate,
  toBusinessDate,
} from '@pulse/core';
import type { EmployeeIdentity } from '@pulse/core/server';
import type { RecordTarget } from './policy';

// Small helpers the step 2.2 services share (server-only).

/** The refusal when the employee is gone. */
export { EMPLOYEE_GONE } from '../validation';

/** An ObjectId from a 24-hex string, or null. */
export function objectIdOf(id: unknown): Types.ObjectId | null {
  if (id instanceof Types.ObjectId) return id;
  return typeof id === 'string' && /^[a-f\d]{24}$/i.test(id) ? new Types.ObjectId(id) : null;
}

/** The rules' view of an employee. */
export function targetOf(identity: EmployeeIdentity): RecordTarget {
  return { employeeId: identity.employeeId, departmentCode: identity.department?.code ?? null };
}

/** The Manila day of a stored date. */
export const dayOf = (value: Date): BusinessDate => toBusinessDate(value);
export const dayOrNull = (value: Date | null | undefined): BusinessDate | null =>
  value ? toBusinessDate(value) : null;
/** 00:00 Manila on a day, for storing. */
export const instantOf = (value: BusinessDate): Date => startOfBusinessDate(value);
export const instantOrNull = (value: BusinessDate | null): Date | null =>
  value ? startOfBusinessDate(value) : null;

/** The file route URL of a stored file. */
export const fileUrlOf = (fileId: Types.ObjectId): string => `/files/${fileId.toHexString()}`;
/** The file route URL that shows an image in the page. */
export const inlineFileUrlOf = (fileId: Types.ObjectId): string =>
  `/files/${fileId.toHexString()}?inline=1`;

/** True for MongoDB's duplicate key error. */
export function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 11000;
}

/** An upload the form actually sent: a non-empty File, or null. */
export function sentFile(file: File | null | undefined): File | null {
  return file && typeof file === 'object' && file.size > 0 ? file : null;
}

/** An audit label from its parts (`a · b`), shortened with "…" to the audit log's limit. */
export function auditLabelOf(...parts: string[]): string {
  const label = parts.join(' · ');
  return label.length <= AUDIT_LABEL_MAX_LENGTH
    ? label
    : `${label.slice(0, AUDIT_LABEL_MAX_LENGTH - 1)}…`;
}
