import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { AccessDeniedError, lastFourOf } from '@pulse/core';
import { revealSensitiveField } from '@pulse/core/server';
import { COMPENSATION_ENTRY_TYPE, EMPLOYEE_RECORD_TYPE } from '../../views';
import { addCompensationEntry } from '../compensation/service';
import { getEmployeeRecordView } from '../employee-records/service';
import { setBankAccount, setGovernmentIds } from '../employee-records/service';
import {
  countAudit,
  database,
  type Department,
  department,
  type Person,
  person,
  rawAuditJson,
  savedId,
  withoutIdsAndDates,
} from '../testing/fixtures';
import { registerTalentSensitiveReveals } from './reveals';

// The Talent reveals (SECURITY.md#sensitive-data, docs/TESTING.md#employee-record-tests). Made-up
// data only.

const TIN = '900246813579';
const ACCOUNT_NUMBER = '1112223334';
const SALARY_CENTAVOS = 3456789;

let NET: Department;
let HRD: Department;
let BOD: Department;
let admin: Person;
let hr: Person;
let board: Person;
let writer: Person;

interface Filled {
  subject: Person;
  recordId: string;
  entryId: string;
}

async function filled(dept: Department, name: string): Promise<Filled> {
  const subject = await person(name, 'Ilagan', dept);
  const { version } = await setGovernmentIds(admin.actor, {
    employeeId: subject.employeeId,
    version: 0,
    tin: TIN,
    rdoCode: null,
  });
  await setBankAccount(admin.actor, {
    employeeId: subject.employeeId,
    version,
    bank: 'rcbc',
    accountNumber: ACCOUNT_NUMBER,
    accountName: `${name} Ilagan`,
  });
  const { id: entryId } = savedId(
    await addCompensationEntry(admin.actor, {
      employeeId: subject.employeeId,
      effectiveDate: '2024-01-01',
      basicSalaryCentavos: SALARY_CENTAVOS,
      rateType: 'monthly',
      minimumWageEarner: false,
      reason: 'Starting salary',
    }),
  );
  const view = await getEmployeeRecordView(admin.actor, subject.employeeId);
  if (!view?.recordId) throw new Error('No record.');
  return { subject, recordId: view.recordId, entryId };
}

let staff: Filled;
let hrStaff: Filled;

beforeAll(async () => {
  await connectDb();
  NET = await department('Network', 'NET');
  HRD = await department('Human Resource', 'HR');
  BOD = await department('Board of Directors', 'BOD');
  admin = await person('Ada', 'Admin', NET, { admin: true });
  hr = await person('Hana', 'Reyes', HRD, { talent: 'read' });
  board = await person('Bert', 'Lim', BOD, { talent: 'read' });
  writer = await person('Wena', 'Cruz', NET, { talent: 'write' });
  registerTalentSensitiveReveals();
  staff = await filled(NET, 'Gina');
  hrStaff = await filled(HRD, 'Hilda');
});

afterEach(async () => {
  await database().command({ collMod: 'auditLogs', validator: {} });
});

function reveal(who: Person, ownerType: string, ownerId: string, field: string) {
  return revealSensitiveField({ actor: who.actor, ownerType, ownerId, field });
}

async function revealEntries(ownerId: string) {
  return database()
    .collection('auditLogs')
    .find({ action: 'reveal', 'record.id': new Types.ObjectId(ownerId) })
    .toArray();
}

describe('the Talent reveals', () => {
  it('lets HR reveal a TIN, after one reveal entry with module talent and fields ["tin"]', async () => {
    const before = (await revealEntries(staff.recordId)).length;
    expect(await reveal(hr, EMPLOYEE_RECORD_TYPE, staff.recordId, 'tin')).toBe(TIN);
    const entries = await revealEntries(staff.recordId);
    expect(entries).toHaveLength(before + 1);
    const entry = entries.at(-1);
    expect(entry).toMatchObject({
      module: 'talent',
      action: 'reveal',
      fields: ['tin'],
      record: {
        type: EMPLOYEE_RECORD_TYPE,
        label: `${staff.subject.employeeNumber} · Gina Ilagan`,
      },
      before: null,
      after: null,
    });
    expect(entry?.actorId?.toHexString()).toBe(hr.userId);
    const json = withoutIdsAndDates(await rawAuditJson());
    expect(json).not.toContain(TIN);
    expect(json).not.toContain(lastFourOf(TIN));
  });

  it('writes the entry before the value returns: no entry, no value', async () => {
    await database().command({
      collMod: 'auditLogs',
      validator: { $jsonSchema: { required: ['aFieldNoEntryHas'] } },
      validationLevel: 'strict',
      validationAction: 'error',
    });
    await expect(reveal(hr, EMPLOYEE_RECORD_TYPE, staff.recordId, 'tin')).rejects.toThrow();
  });

  it('refuses a Talent Write user with no role, and writes nothing', async () => {
    const entries = await countAudit();
    for (const field of ['tin', 'sss', 'philhealth', 'pagibig', 'bankAccountNumber']) {
      await expect(
        reveal(writer, EMPLOYEE_RECORD_TYPE, staff.recordId, field),
      ).rejects.toBeInstanceOf(AccessDeniedError);
    }
    await expect(
      reveal(writer, COMPENSATION_ENTRY_TYPE, staff.entryId, 'basicSalary'),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    expect(await countAudit()).toBe(entries);
  });

  it('lets the Board reveal on an HR-department record, never on another', async () => {
    expect(await reveal(board, EMPLOYEE_RECORD_TYPE, hrStaff.recordId, 'bankAccountNumber')).toBe(
      ACCOUNT_NUMBER,
    );
    expect(await reveal(board, COMPENSATION_ENTRY_TYPE, hrStaff.entryId, 'basicSalary')).toBe(
      String(SALARY_CENTAVOS),
    );
    await expect(reveal(board, EMPLOYEE_RECORD_TYPE, staff.recordId, 'tin')).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    await expect(
      reveal(board, COMPENSATION_ENTRY_TYPE, staff.entryId, 'basicSalary'),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it('lets the employee reveal their own values, labelled per record type', async () => {
    expect(await reveal(staff.subject, EMPLOYEE_RECORD_TYPE, staff.recordId, 'tin')).toBe(TIN);
    expect(await reveal(staff.subject, COMPENSATION_ENTRY_TYPE, staff.entryId, 'basicSalary')).toBe(
      String(SALARY_CENTAVOS),
    );
    const [entry] = await revealEntries(staff.entryId);
    expect(entry).toMatchObject({
      module: 'talent',
      fields: ['basicSalary'],
      record: {
        type: COMPENSATION_ENTRY_TYPE,
        label: `${staff.subject.employeeNumber} · 2024-01-01`,
      },
    });
    await expect(
      reveal(staff.subject, EMPLOYEE_RECORD_TYPE, hrStaff.recordId, 'tin'),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it('refuses an unregistered field or record type', async () => {
    const entries = await countAudit();
    for (const field of ['rdoCode', 'governmentIds.tin', 'accountNumber', 'basicSalaryCentavos']) {
      await expect(
        reveal(admin, EMPLOYEE_RECORD_TYPE, staff.recordId, field),
      ).rejects.toBeInstanceOf(AccessDeniedError);
    }
    await expect(
      reveal(admin, COMPENSATION_ENTRY_TYPE, staff.entryId, 'basicSalaryCentavos'),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(reveal(admin, 'talent.unknown', staff.recordId, 'tin')).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    expect(await countAudit()).toBe(entries);
  });
});
