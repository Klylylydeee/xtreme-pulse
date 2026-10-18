import type { ClientSession, Types } from 'mongoose';
import { connectDb, withTransaction } from '@pulse/db';
import { AccessDeniedError, ActionError, businessToday } from '@pulse/core';
import {
  activeBoardApprovers,
  activeHrUserIds,
  activeSystemAdministrators,
  type EmployeeIdentity,
  getEmployeeIdentity,
  notify,
  reloadActorAccess,
  ROLE_DEPARTMENT_CODES,
} from '@pulse/core/server';
import {
  CHANGE_REQUEST_ALREADY_OPEN,
  CHANGE_REQUEST_NOTHING_CHANGED,
  type ChangeRequestField,
} from '../../onboarding/change-requests';
import {
  type OwnBankAccountSectionInput,
  type OwnGovernmentIdsSectionInput,
  type OwnPersonalSectionInput,
  type OwnSection,
  OWN_SECTION_SCHEMAS,
  type OwnSkillsSectionInput,
  type VerificationGroup,
} from '../../onboarding/inputs';
import type { OwnSaveResult } from '../../onboarding/views';
import type { ChangeRequestSection } from '../../fixed-sets';
import { RECORD_CHANGED_ELSEWHERE } from '../../validation';
import { EMPLOYEE_RECORD_TYPE } from '../../views';
import {
  hasOpenChangeRequest,
  isOpenRequestConflict,
  sendChangeRequestInSession,
} from '../change-requests/service';
import {
  checkSectionValues,
  compareSection,
  formValuesOf,
  OWN_SECTION_PARTS,
  recordChangesOf,
  type SectionComparison,
} from '../change-requests/values';
import { inputError } from '../input';
import { NO_EMPLOYEE_RECORD, type TalentActor } from '../policy';
import { isDuplicateKey } from '../shared';
import { loadRecordForWrite, writeEmployeeRecord } from './write';

// Spec: docs/modules/talent.md#onboarding-checklist-and-change-requests-build-step-26 ("What the
// employee changes themselves"; decisions 266 and 267 in docs/BUILD_PLAN.md) and
// SECURITY.md#exceptions-to-module-access — the employee's own Edit sheets on /talent/me and the
// checklist. Self-service: no module access, and no employee id taken; each acts on the signed-in
// user's own employee, reloaded in the transaction.
//
// One save is split by change request section (the on-screen Personal section holds Contact
// details and Personal details). For each part:
// - only filling empty fields: saved straight away (the first save creating the record), with one
//   `create` or `update` entry by the employee. Government IDs or a bank account filled in this way
//   lose their verification, and the verifiers are notified (`talent.verificationNeeded`);
// - changing or clearing a filled-in field: the part becomes one change request, the blanks it
//   fills included, and none of it is saved until approved;
// - nothing changing: left out. A save where no part changes is refused.
// A part whose section has an open request is refused: Edit opens the request instead.
// Everything runs in one transaction with the record's `version` check.

export const VERIFICATION_NEEDED_EVENT = 'talent.verificationNeeded';

const VERIFY_TITLES: Record<VerificationGroup, (name: string) => string> = {
  governmentIds: (name) => `Verify ${name}’s government IDs`,
  bankAccount: (name) => `Verify ${name}’s payroll bank account`,
};

/**
 * Who may verify the employee's details, but `exclude`: every active HR user; for an employee in
 * the HR department, every active Board member and System Administrator. With no one, the active
 * System Administrators (*Assumption*, as for `talent.documentUploaded`).
 */
async function verifierIds(
  identity: EmployeeIdentity,
  exclude: string,
  session: ClientSession,
): Promise<string[]> {
  let ids: string[];
  const admins = async () =>
    (await activeSystemAdministrators(session)).map((admin) => admin.userId.toHexString());
  if (identity.department?.code === ROLE_DEPARTMENT_CODES.hr) {
    const board = (await activeBoardApprovers(session)).map((member) =>
      member.userId.toHexString(),
    );
    ids = [...new Set([...board, ...(await admins())])];
  } else {
    ids = await activeHrUserIds({ session });
    if (ids.length === 0) ids = await admins();
  }
  return ids.filter((id) => id !== exclude);
}

async function notifyVerifiers(
  identity: EmployeeIdentity,
  group: VerificationGroup,
  recordId: Types.ObjectId,
  exclude: string,
  session: ClientSession,
): Promise<void> {
  await notify(
    {
      recipients: await verifierIds(identity, exclude, session),
      module: 'talent',
      event: VERIFICATION_NEEDED_EVENT,
      title: VERIFY_TITLES[group](`${identity.firstName} ${identity.lastName}`),
      href: `/talent?employee=${identity.employeeId}`,
      record: { type: EMPLOYEE_RECORD_TYPE, id: recordId },
    },
    { session },
  );
}

const isVerificationGroup = (section: ChangeRequestSection): section is VerificationGroup =>
  section === 'governmentIds' || section === 'bankAccount';

type OwnInput =
  | OwnPersonalSectionInput
  | OwnGovernmentIdsSectionInput
  | OwnBankAccountSectionInput
  | OwnSkillsSectionInput;

async function saveOwnSection(
  actor: TalentActor,
  ownSection: OwnSection,
  input: unknown,
): Promise<OwnSaveResult> {
  const ownId = actor.employee?.id;
  if (!ownId) throw new AccessDeniedError(NO_EMPLOYEE_RECORD);
  const parsed = OWN_SECTION_SCHEMAS[ownSection].safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const values = parsed.data as OwnInput & { version: number; note?: string | null };
  await connectDb();

  try {
    return await withTransaction(async (session) => {
      const current = await reloadActorAccess({ id: actor.id }, session);
      if (!current.employee || current.employee.id !== ownId) {
        throw new AccessDeniedError(NO_EMPLOYEE_RECORD);
      }
      const identity = await getEmployeeIdentity(current, ownId, { session });
      if (!identity) throw new ActionError('Your employee record no longer exists.');
      const existing = await loadRecordForWrite(ownId, session);
      if ((existing?.version ?? 0) !== values.version) {
        throw new ActionError(RECORD_CHANGED_ELSEWHERE);
      }

      const parts: SectionComparison[] = [];
      for (const section of OWN_SECTION_PARTS[ownSection]) {
        parts.push(await compareSection(section, existing, formValuesOf(section, values)));
      }
      const changing = parts.filter((part) => part.kind !== 'nothing');
      if (changing.length === 0) throw new ActionError(CHANGE_REQUEST_NOTHING_CHANGED);
      const today = businessToday();
      for (const part of changing) {
        if (await hasOpenChangeRequest(ownId, part.section, session)) {
          throw new ActionError(CHANGE_REQUEST_ALREADY_OPEN);
        }
        checkSectionValues(part, existing, today);
      }

      // The blanks filled straight away.
      const direct = changing.filter((part) => part.kind === 'save');
      let savedVersion: number | null = null;
      const saved: ChangeRequestField[] = [];
      if (direct.length > 0) {
        const changes: Record<string, unknown> = {};
        for (const part of direct) {
          Object.assign(changes, await recordChangesOf(part.fields, part.values));
          // The employee's own entry clears the group's verification (decision 266).
          if (isVerificationGroup(part.section)) changes[`${part.section}Verification`] = null;
          saved.push(...part.fields);
        }
        const written = await writeEmployeeRecord({
          actor: current,
          employeeId: ownId,
          label: `${identity.employeeNumber} · ${identity.firstName} ${identity.lastName}`,
          existing,
          changes,
          session,
        });
        savedVersion = written.version;
        for (const part of direct) {
          if (isVerificationGroup(part.section)) {
            await notifyVerifiers(identity, part.section, written.recordId, current.id, session);
          }
        }
      }

      // The changes to filled-in values, one change request per section.
      const sent: OwnSaveResult['sent'] = [];
      for (const part of changing.filter((entry) => entry.kind === 'sendForApproval')) {
        const id = await sendChangeRequestInSession({
          current,
          identity,
          section: part.section,
          fields: part.fields,
          values: part.values,
          note: values.note ?? null,
          session,
        });
        sent.push({ id, section: part.section });
      }
      return { savedVersion, saved, sent };
    });
  } catch (error) {
    if (isOpenRequestConflict(error)) throw new ActionError(CHANGE_REQUEST_ALREADY_OPEN);
    // Two first saves at once: the unique `employeeId` index refused the second insert.
    if (isDuplicateKey(error)) throw new ActionError(RECORD_CHANGED_ELSEWHERE);
    throw error;
  }
}

/**
 * The own Personal sheet (Contact details and Personal details, the date of birth and civil status
 * included): blanks saved straight away, changes to filled-in values sent as one change request
 * per section. Self-service, no employee id.
 */
export function saveOwnPersonal(
  actor: TalentActor,
  input: OwnPersonalSectionInput,
): Promise<OwnSaveResult> {
  return saveOwnSection(actor, 'personal', input);
}

/** The own Government IDs sheet (see {@link saveOwnPersonal}). An empty ID keeps the stored one. */
export function saveOwnGovernmentIds(
  actor: TalentActor,
  input: OwnGovernmentIdsSectionInput,
): Promise<OwnSaveResult> {
  return saveOwnSection(actor, 'governmentIds', input);
}

/** The own Payroll bank account sheet (see {@link saveOwnPersonal}). */
export function saveOwnBankAccount(
  actor: TalentActor,
  input: OwnBankAccountSectionInput,
): Promise<OwnSaveResult> {
  return saveOwnSection(actor, 'bankAccount', input);
}

/** The own Skills sheet (see {@link saveOwnPersonal}). */
export function saveOwnSkills(
  actor: TalentActor,
  input: OwnSkillsSectionInput,
): Promise<OwnSaveResult> {
  return saveOwnSection(actor, 'skills', input);
}
