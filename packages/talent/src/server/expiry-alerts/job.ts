import { z } from 'zod';
import type { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { addDays, type BusinessDate, formatDate, now, toBusinessDate } from '@pulse/core';
import {
  activeHrUserIds,
  activeSystemAdministrators,
  defineJob,
  defineSchedule,
  type EmployeeNotificationContact,
  employeeNotificationContacts,
  notify,
} from '@pulse/core/server';
import { DOCUMENT_201_TYPE_LABELS, type Document201Type } from '../../fixed-sets';
import { CERTIFICATION_TYPE, EMPLOYEE_DOCUMENT_TYPE } from '../../views';
import { CertificationModel } from '../certifications/model';
import { EmployeeDocumentModel } from '../documents/model';
import { instantOf } from '../shared';
import { expiryLeadDaysOn } from './settings';

// Spec: docs/ARCHITECTURE.md#background-jobs ("201 document and certification expiry") and
// docs/modules/talent.md#documents-photo-e-signature-and-certifications-build-step-22 (decisions
// 185 and 186 in docs/BUILD_PLAN.md) — one daily job, `talent.expiryAlerts`, at 8:00 AM Manila.
//
// - Two alerts per item with an expiry date: "expiring" once it is within the lead days
//   (`talent.expiryAlerts`, 30 by default), and "expired" on or after the expiry date. Once each
//   per expiry date, through `notify()`'s `dedupeKey` (`talent.documentExpiring:<id>:<YYYY-MM-DD>`
//   and so on): a rerun sends nothing twice, and a changed expiry date alerts again.
// - Skipped: archived documents, removed certifications and separated employees.
// - Recipients: documents to the active HR users (linking `/talent?employee=<id>`) and the employee
//   (`/talent/me`); certifications also to the employee's active `reportingTo` supervisors
//   (`/directory?person=<id>`, since they may lack Talent Read). With no active HR user, the HR
//   alerts go to the active System Administrators.
// - The text names the type and the person, never a file name or a document title.
// - It has no actor: it reads Core's job-only recipient helpers, which carry no sensitive field.

export const DOCUMENT_EXPIRING_EVENT = 'talent.documentExpiring';
export const DOCUMENT_EXPIRED_EVENT = 'talent.documentExpired';
export const CERTIFICATION_EXPIRING_EVENT = 'talent.certificationExpiring';
export const CERTIFICATION_EXPIRED_EVENT = 'talent.certificationExpired';

/** The job: no data, everything is read when it runs. */
export const EXPIRY_ALERTS_JOB = defineJob('talent.expiryAlerts', { schema: z.object({}) });

/** Every day at 8:00 AM Manila, weekends included. */
export const EXPIRY_ALERTS_SCHEDULE = defineSchedule({
  id: 'talent.expiryAlerts',
  job: EXPIRY_ALERTS_JOB,
  data: {},
  pattern: '0 8 * * *',
});

export interface ExpiryAlertsResult {
  /** The Manila day the run was for. */
  date: BusinessDate;
  documentLeadDays: number;
  certificationLeadDays: number;
  /** Unarchived documents of employees who aren't separated, within the window or expired. */
  documents: number;
  /** Live certifications of employees who aren't separated, within the window or expired. */
  certifications: number;
  /** Notifications written in this run. */
  notified: number;
}

type Phase = 'expiring' | 'expired';

interface Alert {
  phase: Phase;
  event: string;
  recordType: string;
  recordId: Types.ObjectId;
  expiryDate: BusinessDate;
  /** "NBI clearance", "Certification". */
  typeLabel: string;
  contact: EmployeeNotificationContact;
  /** Certifications also go to the supervisors. */
  toSupervisors: boolean;
}

/** The duplicate check's key: once per item, phase and expiry date. */
export function expiryAlertKey(
  event: string,
  recordId: Types.ObjectId | string,
  expiryDate: BusinessDate,
): string {
  const id = typeof recordId === 'string' ? recordId : recordId.toHexString();
  return `${event}:${id}:${expiryDate}`;
}

/** `NBI clearance` stays as it is; `Medical certificate` becomes `medical certificate`. */
function lowerFirst(text: string): string {
  const second = text.charAt(1);
  return second && second === second.toUpperCase() && second !== second.toLowerCase()
    ? text
    : text.charAt(0).toLowerCase() + text.slice(1);
}

/** Sends one item's alerts: the employee first, then HR (or the System Administrators), then supervisors. */
async function send(alert: Alert, hrRecipients: string[]): Promise<number> {
  const { contact, phase, typeLabel, expiryDate } = alert;
  const dedupeKey = expiryAlertKey(alert.event, alert.recordId, expiryDate);
  const record = { type: alert.recordType, id: alert.recordId };
  const verb = phase === 'expired' ? 'expired' : 'expiring';
  const ownTitle =
    phase === 'expired'
      ? `Your ${lowerFirst(typeLabel)} expired on ${formatDate(expiryDate)}`
      : `Your ${lowerFirst(typeLabel)} expires on ${formatDate(expiryDate)}`;
  const othersTitle = `${typeLabel} ${verb}: ${contact.name}`;
  const othersBody =
    phase === 'expired'
      ? `It expired on ${formatDate(expiryDate)}.`
      : `It expires on ${formatDate(expiryDate)}.`;
  let notified = 0;

  // A recipient gets one notification per key: whoever is the employee gets the /talent/me link,
  // and an HR user who is also a supervisor gets the record link.
  if (contact.userId) {
    notified += await notify({
      recipients: [contact.userId],
      module: 'talent',
      event: alert.event,
      title: ownTitle,
      body: 'Send HR the renewed copy so they can update your record.',
      href: '/talent/me',
      record,
      dedupeKey,
    });
  }
  notified += await notify({
    recipients: hrRecipients,
    module: 'talent',
    event: alert.event,
    title: othersTitle,
    body: othersBody,
    href: `/talent?employee=${contact.employeeId}`,
    record,
    dedupeKey,
  });
  if (alert.toSupervisors && contact.supervisorUserIds.length > 0) {
    notified += await notify({
      recipients: contact.supervisorUserIds,
      module: 'talent',
      event: alert.event,
      title: othersTitle,
      body: othersBody,
      href: `/directory?person=${contact.employeeId}`,
      record,
      dedupeKey,
    });
  }
  return notified;
}

/**
 * Sends the 201 document and certification expiry alerts for the Manila day of `at`. Safe to run
 * again: each recipient gets each alert once per item and expiry date.
 */
export async function runExpiryAlerts(at: Date = now()): Promise<ExpiryAlertsResult> {
  await connectDb();
  const date = toBusinessDate(at);
  const { documentLeadDays, certificationLeadDays } = await expiryLeadDaysOn(date);
  const today = instantOf(date);

  const [documents, certifications] = await Promise.all([
    EmployeeDocumentModel.find(
      {
        archivedAt: null,
        expiryDate: { $type: 'date', $lte: instantOf(addDays(date, documentLeadDays)) },
      },
      { employeeId: 1, type: 1, expiryDate: 1 },
    ).lean<
      { _id: Types.ObjectId; employeeId: Types.ObjectId; type: Document201Type; expiryDate: Date }[]
    >(),
    CertificationModel.find(
      { expiryDate: { $type: 'date', $lte: instantOf(addDays(date, certificationLeadDays)) } },
      { employeeId: 1, expiryDate: 1 },
    ).lean<{ _id: Types.ObjectId; employeeId: Types.ObjectId; expiryDate: Date }[]>(),
  ]);

  const contacts = new Map(
    (
      await employeeNotificationContacts([
        ...documents.map((document) => document.employeeId),
        ...certifications.map((certification) => certification.employeeId),
      ])
    ).map((contact) => [contact.employeeId, contact]),
  );
  const liveContact = (employeeId: Types.ObjectId) => {
    const contact = contacts.get(employeeId.toHexString());
    return contact && !contact.separated ? contact : null;
  };

  const alerts: Alert[] = [];
  for (const document of documents) {
    const contact = liveContact(document.employeeId);
    if (!contact) continue;
    const expired = document.expiryDate.getTime() <= today.getTime();
    alerts.push({
      phase: expired ? 'expired' : 'expiring',
      event: expired ? DOCUMENT_EXPIRED_EVENT : DOCUMENT_EXPIRING_EVENT,
      recordType: EMPLOYEE_DOCUMENT_TYPE,
      recordId: document._id,
      expiryDate: toBusinessDate(document.expiryDate),
      typeLabel: DOCUMENT_201_TYPE_LABELS[document.type],
      contact,
      toSupervisors: false,
    });
  }
  for (const certification of certifications) {
    const contact = liveContact(certification.employeeId);
    if (!contact) continue;
    const expired = certification.expiryDate.getTime() <= today.getTime();
    alerts.push({
      phase: expired ? 'expired' : 'expiring',
      event: expired ? CERTIFICATION_EXPIRED_EVENT : CERTIFICATION_EXPIRING_EVENT,
      recordType: CERTIFICATION_TYPE,
      recordId: certification._id,
      expiryDate: toBusinessDate(certification.expiryDate),
      typeLabel: 'Certification',
      contact,
      toSupervisors: true,
    });
  }

  let notified = 0;
  if (alerts.length > 0) {
    let hrRecipients = await activeHrUserIds();
    if (hrRecipients.length === 0) {
      hrRecipients = (await activeSystemAdministrators()).map((admin) =>
        admin.userId.toHexString(),
      );
    }
    for (const alert of alerts) notified += await send(alert, hrRecipients);
  }
  return {
    date,
    documentLeadDays,
    certificationLeadDays,
    documents: alerts.filter((alert) => alert.recordType === EMPLOYEE_DOCUMENT_TYPE).length,
    certifications: alerts.filter((alert) => alert.recordType === CERTIFICATION_TYPE).length,
    notified,
  };
}
