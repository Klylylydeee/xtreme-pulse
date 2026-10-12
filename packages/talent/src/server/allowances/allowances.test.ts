import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { AccessDeniedError, ActionError } from '@pulse/core';
import { HIDDEN_SENSITIVE, isEncryptedValue, revealSensitiveField } from '@pulse/core/server';
import { SALARY_MASK } from '../../formats';
import { ALLOWANCE_AMOUNT_FIELD, ALLOWANCE_ASSIGNMENT_TYPE } from '../../payroll/views';
import { getEmployeeRecordView } from '../employee-records/service';
import { addPayrollSettingsVersion } from '../payroll-settings/service';
import { SEED_ALLOWANCE_TYPES } from '../payroll-settings/seed-data';
import { registerTalentSensitiveReveals } from '../sensitive/reveals';
import {
  auditEntries,
  type Department,
  department,
  type Person,
  person,
  rawAuditJson,
  seedPayrollSettings,
  setDateHired,
  withoutIdsAndDates,
} from '../testing/fixtures';
import { AllowanceAssignmentModel } from './model';
import { allowancesInEffect, assignAllowance } from './service';

// The allowance tests (docs/TESTING.md#payroll-settings-tests, build step 2.3, decisions 202–204
// in docs/BUILD_PLAN.md; the step's "Done when": a new employee gets the internet allowance from
// the date hired). Made-up people and amounts.

let NET: Department;
let HRD: Department;
let ACCT: Department;
let BOD: Department;
let hr: Person;
let hrOwner: Person;
let admin: Person;
let writer: Person;
let accountant: Person;
let board: Person;
let reader: Person;

// A fixed "today" (only Date is faked), before the 2026-11-03 hire, so "upcoming" and the date
// limits don't depend on when the tests run.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T10:00:00+08:00'));
});

afterEach(() => {
  vi.useRealTimers();
});

beforeAll(async () => {
  await connectDb();
  await AllowanceAssignmentModel.init();
  await seedPayrollSettings();
  registerTalentSensitiveReveals();
  NET = await department('Network', 'NET');
  HRD = await department('Human Resource', 'HR');
  ACCT = await department('Accounting', 'ACCT');
  BOD = await department('Board', 'BOD');
  hr = await person('Hana', 'Reyes', HRD, { talent: 'write' });
  hrOwner = await person('Hilda', 'Ramos', HRD, { talent: 'owner' });
  admin = await person('Ada', 'Admin', NET, { admin: true });
  writer = await person('Wally', 'Cruz', NET, { talent: 'write' });
  accountant = await person('Alma', 'Santos', ACCT, { talent: 'write' });
  board = await person('Bert', 'Lim', BOD, { talent: 'write' });
  reader = await person('Rita', 'Lopez', NET, { talent: 'read' });
});

const assign = (
  actor: Person,
  subject: Person,
  effectiveDate: string,
  kind: 'set' | 'end',
  amountCentavos: number | null = null,
) =>
  assignAllowance(actor.actor, {
    employeeId: subject.employeeId,
    typeKey: 'internet',
    effectiveDate,
    kind,
    amountCentavos,
    reason: 'Made-up reason',
  });

const lines = async (subject: Person, day: string) =>
  (await allowancesInEffect(hr.actor, subject.employeeId, day))?.map((line) => ({
    typeKey: line.typeKey,
    origin: line.origin,
    amountCentavos: line.amountCentavos,
    since: line.since,
  }));

describe('automatic allowances (the step’s "Done when")', () => {
  it('gives a new employee hired 2026-11-03 the internet allowance from that day, not before', async () => {
    const hire = await person('Nina', 'Bautista', NET, { dateHired: '2026-11-03' });
    expect(await lines(hire, '2026-11-02')).toEqual([]);
    expect(await lines(hire, '2026-11-03')).toEqual([
      { typeKey: 'internet', origin: 'automatic', amountCentavos: 50000, since: '2026-11-03' },
    ]);
    expect(
      await AllowanceAssignmentModel.countDocuments({
        employeeId: new Types.ObjectId(hire.employeeId),
      }),
    ).toBe(0);

    const view = await getEmployeeRecordView(hr.actor, hire.employeeId);
    expect(view?.allowances?.lines).toEqual([
      {
        typeKey: 'internet',
        name: 'Internet allowance',
        basis: 'perCutOff',
        taxTreatment: 'nonTaxable',
        origin: 'automatic',
        defaultAmountCentavos: 50000,
        since: '2026-11-03',
        upcoming: true,
      },
    ]);
    expect(view?.allowances?.asOf).toBe('2026-11-03');

    // Once the date hired has come, the line is no longer upcoming.
    vi.setSystemTime(new Date('2026-11-03T10:00:00+08:00'));
    const later = await getEmployeeRecordView(hr.actor, hire.employeeId);
    expect(later?.allowances?.lines[0]).toMatchObject({ since: '2026-11-03', upcoming: false });
  });

  it('moves the start when the date hired is corrected in Core', async () => {
    const hire = await person('Olga', 'Castro', NET, { dateHired: '2026-11-03' });
    await setDateHired(hire, '2026-11-10');
    expect(await lines(hire, '2026-11-09')).toEqual([]);
    expect((await lines(hire, '2026-11-10'))?.[0]?.since).toBe('2026-11-10');
  });
});

describe('explicit assignments', () => {
  it('changes the amount with set, stops it with end, and lets the newest entry win a tie', async () => {
    const subject = await person('Pia', 'Diaz', NET, { dateHired: '2025-01-06' });
    await assign(hr, subject, '2026-03-01', 'set', 70000);
    await assign(hr, subject, '2026-03-01', 'set', 80000);
    await assign(hr, subject, '2026-06-01', 'end');
    expect(await lines(subject, '2026-02-28')).toEqual([
      { typeKey: 'internet', origin: 'automatic', amountCentavos: 50000, since: '2025-01-06' },
    ]);
    expect(await lines(subject, '2026-03-01')).toEqual([
      { typeKey: 'internet', origin: 'assigned', amountCentavos: 80000, since: '2026-03-01' },
    ]);
    expect(await lines(subject, '2026-06-01')).toEqual([]);

    const view = await getEmployeeRecordView(hr.actor, subject.employeeId);
    expect(view?.allowances?.lines).toEqual([]);
    expect(view?.allowances?.history.map((entry) => [entry.kind, entry.status])).toEqual([
      ['end', 'current'],
      ['set', 'previous'],
      ['set', 'superseded'],
    ]);
    expect(view?.allowances?.history[1]?.amount).toEqual({
      mask: SALARY_MASK,
      ownerType: ALLOWANCE_ASSIGNMENT_TYPE,
      ownerId: view?.allowances?.history[1]?.id,
      field: ALLOWANCE_AMOUNT_FIELD,
    });
    expect(JSON.stringify(view)).not.toContain('80000');
  });

  it('stores amounts encrypted, hides them in the audit entry and reveals them through the logged reveal', async () => {
    const subject = await person('Quino', 'Evangelista', NET);
    const { id } = await assign(hr, subject, '2026-04-01', 'set', 123457);
    const stored = await AllowanceAssignmentModel.findById(id).select('+amountCentavos').lean();
    expect(isEncryptedValue(stored?.amountCentavos)).toBe(true);
    const [entry] = (await auditEntries(ALLOWANCE_ASSIGNMENT_TYPE)).filter(
      (e) => e.record.id.toHexString() === id,
    );
    expect(entry).toMatchObject({
      action: 'create',
      module: 'talent',
      record: { label: `${subject.employeeNumber} · Internet allowance · 2026-04-01` },
    });
    expect(entry?.after?.amountCentavos).toEqual(HIDDEN_SENSITIVE);
    expect(withoutIdsAndDates(await rawAuditJson())).not.toContain('123457');

    const revealed = await revealSensitiveField({
      actor: hr.actor,
      ownerType: ALLOWANCE_ASSIGNMENT_TYPE,
      ownerId: id,
      field: ALLOWANCE_AMOUNT_FIELD,
    });
    expect(revealed).toBe('123457');
    const reveals = (await auditEntries(ALLOWANCE_ASSIGNMENT_TYPE)).filter(
      (e) => e.action === 'reveal',
    );
    expect(reveals.at(-1)?.record.label).toBe(
      `${subject.employeeNumber} · Internet allowance · 2026-04-01`,
    );
  });

  it('refuses a date before the date hired, more than a year ahead, an unknown type, and edits', async () => {
    const subject = await person('Rosa', 'Flores', NET, { dateHired: '2025-05-01' });
    await expect(assign(hr, subject, '2025-04-30', 'set', 100)).rejects.toMatchObject({
      field: 'effectiveDate',
    });
    await expect(assign(hr, subject, '2099-01-01', 'set', 100)).rejects.toBeInstanceOf(ActionError);
    await expect(
      assignAllowance(hr.actor, {
        employeeId: subject.employeeId,
        typeKey: 'rice',
        effectiveDate: '2026-01-01',
        kind: 'set',
        amountCentavos: 100,
        reason: 'x',
      }),
    ).rejects.toMatchObject({ field: 'typeKey' });
    await expect(assign(hr, subject, '2026-01-01', 'set', null)).rejects.toMatchObject({
      field: 'amountCentavos',
    });
    const { id } = await assign(hr, subject, '2026-01-01', 'set', 100);
    await expect(
      AllowanceAssignmentModel.updateOne(
        { _id: new Types.ObjectId(id) },
        { $set: { reason: 'Edited' } },
      ),
    ).rejects.toThrow(/never changed or deleted/);
    await expect(
      AllowanceAssignmentModel.deleteOne({ _id: new Types.ObjectId(id) }),
    ).rejects.toThrow(/never changed or deleted/);
  });
});

describe('who assigns', () => {
  it('lets HR assign; refuses Talent Write alone, Accounting and anyone on their own record', async () => {
    const subject = await person('Sara', 'Gomez', NET);
    await assign(hr, subject, '2026-02-01', 'set', 60000);
    await expect(assign(writer, subject, '2026-02-01', 'set', 1)).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    await expect(assign(accountant, subject, '2026-02-01', 'set', 1)).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    await expect(assign(hr, hr, '2026-02-01', 'set', 1)).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(assign(admin, admin, '2026-02-01', 'set', 1)).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
  });

  it('refuses HR for HR staff, and allows a Board member or the System Administrator', async () => {
    const hrStaff = await person('Tess', 'Herrera', HRD);
    await expect(assign(hr, hrStaff, '2026-02-01', 'set', 1)).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    await assign(board, hrStaff, '2026-02-01', 'set', 60000);
    await assign(admin, hrStaff, '2026-03-01', 'end');
  });

  it('sends the allowances part only to a viewer who may reveal allowances', async () => {
    const subject = await person('Uma', 'Ignacio', NET);
    expect((await getEmployeeRecordView(hr.actor, subject.employeeId))?.allowances).toBeDefined();
    const forReader = await getEmployeeRecordView(reader.actor, subject.employeeId);
    expect(forReader).not.toBeNull();
    expect(forReader && 'allowances' in forReader).toBe(false);
    await expect(
      allowancesInEffect(reader.actor, subject.employeeId, '2026-01-01'),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });
});

describe('a new talent.allowanceTypes default', () => {
  it('applies from its version’s date', async () => {
    const subject = await person('Vic', 'Javier', NET, { dateHired: '2025-01-06' });
    await addPayrollSettingsVersion(hrOwner.actor, {
      key: 'talent.allowanceTypes',
      effectiveFrom: '2026-12-11',
      source: 'Made-up policy change',
      value: {
        types: SEED_ALLOWANCE_TYPES.types.map((type) => ({
          ...type,
          defaultAmountCentavos: 60000,
        })),
      },
    });
    expect((await lines(subject, '2026-12-10'))?.[0]?.amountCentavos).toBe(50000);
    expect((await lines(subject, '2026-12-11'))?.[0]).toEqual({
      typeKey: 'internet',
      origin: 'automatic',
      amountCentavos: 60000,
      since: '2025-01-06',
    });
  });
});
