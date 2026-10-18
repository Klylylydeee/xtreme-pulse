import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { AccessDeniedError, ActionError } from '@pulse/core';
import { isEncryptedValue, revealSensitiveField } from '@pulse/core/server';
import { leaveOpeningInputSchema, offsetOpeningInputSchema } from '../../time-off/schemas';
import { GO_LIVE_DATE_MISSING_MESSAGE, SEED_LEAVE_SETTINGS } from '../../time-off/settings';
import { LeaveEntryModel } from '../leave/model';
import { leaveBalanceOf } from '../leave/service';
import { OffsetEntryModel } from '../offset/model';
import { offsetBalanceOf } from '../offset/service';
import { addLeaveSettingsVersion } from '../payroll-settings/service';
import { registerTalentSensitiveReveals } from '../sensitive/reveals';
import {
  auditEntries,
  database,
  type Department,
  department,
  type Person,
  person,
  rawAuditJson,
  seedPayrollSettings,
  setLeaveSettings,
  withoutIdsAndDates,
} from '../testing/fixtures';
import { PAYROLL_OPENING_ENTRY_TYPE, PayrollOpeningEntryModel } from './model';
import {
  addLeaveCorrection,
  addOffsetCorrection,
  enterLeaveOpening,
  enterOffsetOpening,
  enterPayrollOpening,
  getOpeningBalances,
  getPayrollOpeningSection,
  OPENING_BALANCES_DENIED,
  OWN_OPENING_BALANCES_DENIED,
  PAYROLL_OPENING_STALE,
} from './service';

// Opening entries, corrections and year-to-date pay at go-live (docs/TESTING.md#leave-and-time-
// off-tests: "Opening entries and year-to-date pay"; decisions 306–308 in docs/BUILD_PLAN.md).
// Made-up people and amounts only. "Today" is Monday 2026-10-19, 10:00 Manila; the go-live date
// is 2026-11-01 once set.

const TODAY = new Date('2026-10-19T10:00:00+08:00');
const GO_LIVE = '2026-11-01';

let NET: Department;
let HRD: Department;
let hr: Person;
let hrOwner: Person;
let hrReader: Person;
let netWriter: Person;
let admin: Person;
let employee: Person;
let colleague: Person;
let hrStaff: Person;
let newHire: Person;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(TODAY);
});

afterEach(() => {
  vi.useRealTimers();
});

beforeAll(async () => {
  await connectDb();
  await Promise.all([
    LeaveEntryModel.init(),
    OffsetEntryModel.init(),
    PayrollOpeningEntryModel.init(),
  ]);
  await seedPayrollSettings();
  registerTalentSensitiveReveals();
  NET = await department('Network', 'NET');
  HRD = await department('Human Resource', 'HR');
  hr = await person('Hana', 'Reyes', HRD, { talent: 'write' });
  hrOwner = await person('Hector', 'Ramos', HRD, { talent: 'owner' });
  hrReader = await person('Hilda', 'Uy', HRD, { talent: 'read' });
  netWriter = await person('Nora', 'Tan', NET, { talent: 'write' });
  admin = await person('Ada', 'Admin', NET, { admin: true });
  employee = await person('Emil', 'Cruz', NET, { dateHired: '2024-03-01' });
  colleague = await person('Cora', 'Diaz', NET, { dateHired: '2025-02-01' });
  hrStaff = await person('Hugo', 'Sy', HRD, { dateHired: '2024-03-01' });
  newHire = await person('Nina', 'Go', NET, { dateHired: GO_LIVE });
});

const opening = (who: Person, typeKey: string, halfDays: string) =>
  enterLeaveOpening(who.actor, { employeeId: employee.employeeId, typeKey, halfDays });

describe('before the go-live date is set', () => {
  it('lists nothing and refuses every opening entry', async () => {
    expect(await getOpeningBalances(hr.actor)).toMatchObject({
      goLiveDate: null,
      notice: GO_LIVE_DATE_MISSING_MESSAGE,
      rows: [],
    });
    await expect(opening(hr, 'vacation', '5')).rejects.toThrow(GO_LIVE_DATE_MISSING_MESSAGE);
    await expect(
      enterOffsetOpening(hr.actor, { employeeId: employee.employeeId, minutes: '2' }),
    ).rejects.toThrow(GO_LIVE_DATE_MISSING_MESSAGE);
  });
});

describe('leave and offset openings', () => {
  beforeAll(async () => {
    await setLeaveSettings({ goLiveDate: GO_LIVE }, '2026-10-01');
  });

  it('enters one VL, SL and offset opening, dated the go-live date, and refuses a second', async () => {
    await opening(hr, 'vacation', '5.5');
    await opening(hr, 'sick', '0');
    await expect(opening(hr, 'vacation', '1')).rejects.toThrow(
      'The VL opening balance was already entered. Add a correction instead.',
    );
    await enterOffsetOpening(hr.actor, {
      employeeId: employee.employeeId,
      minutes: '12.5',
    });
    await expect(
      enterOffsetOpening(hr.actor, { employeeId: employee.employeeId, minutes: '1' }),
    ).rejects.toBeInstanceOf(ActionError);

    const rows = await database()
      .collection('leaveEntries')
      .find({ employeeId: new Types.ObjectId(employee.employeeId) })
      .sort({ _id: 1 })
      .toArray();
    expect(rows.map((row) => [row.typeKey, row.kind, row.halfDays])).toEqual([
      ['vacation', 'opening', 11],
      ['sick', 'opening', 0],
    ]);
    expect((rows[0]?.effectiveOn as Date).toISOString()).toBe('2026-10-31T16:00:00.000Z');
    expect(await offsetBalanceOf(employee.employeeId)).toBe(750);
    const [audit] = await auditEntries('talent.leaveEntry');
    expect(audit).toMatchObject({
      action: 'create',
      actorId: new Types.ObjectId(hr.userId),
      record: { label: `${employee.employeeNumber} · VL · ${GO_LIVE}` },
    });
  });

  it('lets exactly one of two openings at once through', async () => {
    const results = await Promise.allSettled([
      enterLeaveOpening(admin.actor, {
        employeeId: colleague.employeeId,
        typeKey: 'vacation',
        halfDays: '2',
      }),
      enterLeaveOpening(hr.actor, {
        employeeId: colleague.employeeId,
        typeKey: 'vacation',
        halfDays: '3',
      }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const [refused] = results.filter((r) => r.status === 'rejected');
    expect((refused as PromiseRejectedResult).reason).toBeInstanceOf(ActionError);
  });

  it('turns the days and hours typed into half days and minutes once, on the action-to-service path', async () => {
    // As the Server Action does: check the typed fields with the schema, then send them on as
    // typed. The service is the one place they are parsed; parsing the output again would read
    // 5 half days as 5 days and 480 minutes as 480 hours.
    const leaveForm = { employeeId: colleague.employeeId, typeKey: 'sick', halfDays: '2.5' };
    const offsetForm = { employeeId: colleague.employeeId, minutes: '8' };
    const leaveParsed = leaveOpeningInputSchema.parse(leaveForm);
    expect(leaveParsed.halfDays).toBe(5);
    expect(leaveOpeningInputSchema.parse(leaveParsed).halfDays).toBe(10);
    expect(offsetOpeningInputSchema.parse(offsetForm).minutes).toBe(480);

    await enterLeaveOpening(hr.actor, leaveForm);
    await enterOffsetOpening(hr.actor, offsetForm);
    await addLeaveCorrection(hr.actor, {
      employeeId: colleague.employeeId,
      typeKey: 'sick',
      halfDays: '-1.5',
      reason: 'Sick leave taken before go-live',
    });
    await addOffsetCorrection(hr.actor, {
      employeeId: colleague.employeeId,
      minutes: '1.25',
      reason: 'Overtime not yet counted',
    });

    const rows = await database()
      .collection('leaveEntries')
      .find({ employeeId: new Types.ObjectId(colleague.employeeId), typeKey: 'sick' })
      .sort({ _id: 1 })
      .toArray();
    expect(rows.map((row) => [row.kind, row.halfDays])).toEqual([
      ['opening', 5],
      ['adjustment', -3],
    ]);
    const offsets = await database()
      .collection('offsetEntries')
      .find({ employeeId: new Types.ObjectId(colleague.employeeId) })
      .sort({ _id: 1 })
      .toArray();
    expect(offsets.map((row) => [row.kind, row.minutes])).toEqual([
      ['opening', 480],
      ['adjustment', 75],
    ]);
    expect(await leaveBalanceOf(colleague.employeeId, 'sick')).toBe(2);
    expect(await offsetBalanceOf(colleague.employeeId)).toBe(555);
  });

  it('refuses an employee hired on or after the go-live date, a type that isn’t credited, and bad days', async () => {
    await expect(
      enterLeaveOpening(hr.actor, {
        employeeId: newHire.employeeId,
        typeKey: 'vacation',
        halfDays: '1',
      }),
    ).rejects.toThrow(/hired before the go-live date/);
    await expect(opening(hr, 'maternity', '1')).rejects.toBeInstanceOf(ActionError);
    await expect(opening(hr, 'sick', '1.3')).rejects.toBeInstanceOf(ActionError);
    await expect(opening(hr, 'sick', '366')).rejects.toBeInstanceOf(ActionError);
  });

  it('allows only HR or the System Administrator with Talent Write, never on one’s own record', async () => {
    await expect(opening(netWriter, 'sick', '1')).rejects.toThrow(OPENING_BALANCES_DENIED);
    await expect(opening(hrReader, 'sick', '1')).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(
      enterLeaveOpening(hr.actor, {
        employeeId: hr.employeeId,
        typeKey: 'vacation',
        halfDays: '1',
      }),
    ).rejects.toThrow(OWN_OPENING_BALANCES_DENIED);
    await expect(getOpeningBalances(netWriter.actor)).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it('corrects with a reason: signed half days or hours, dated today', async () => {
    await expect(
      addLeaveCorrection(hr.actor, {
        employeeId: employee.employeeId,
        typeKey: 'vacation',
        halfDays: '-1',
        reason: '',
      }),
    ).rejects.toBeInstanceOf(ActionError);
    await addLeaveCorrection(hr.actor, {
      employeeId: employee.employeeId,
      typeKey: 'vacation',
      halfDays: '-1',
      reason: 'Leave taken in October, before go-live',
    });
    await addOffsetCorrection(admin.actor, {
      employeeId: employee.employeeId,
      minutes: '-0.5',
      reason: 'Counted twice',
    });
    expect(await leaveBalanceOf(employee.employeeId, 'vacation')).toBe(9);
    expect(await offsetBalanceOf(employee.employeeId)).toBe(720);
    await expect(
      addOffsetCorrection(hr.actor, {
        employeeId: hr.employeeId,
        minutes: '1',
        reason: 'x',
      }),
    ).rejects.toThrow(OWN_OPENING_BALANCES_DENIED);
  });

  it('lists the employees hired before the go-live date with their openings, never an amount of pay', async () => {
    const view = await getOpeningBalances(hr.actor);
    expect(view.goLiveDate).toBe(GO_LIVE);
    expect(view.leaveTypes.map((type) => type.shortName)).toEqual(['VL', 'SL']);
    const ids = view.rows.map((row) => row.employeeId);
    expect(ids).toContain(employee.employeeId);
    expect(ids).not.toContain(newHire.employeeId);
    const row = view.rows.find((r) => r.employeeId === employee.employeeId);
    expect(row).toMatchObject({
      leave: [
        { typeKey: 'vacation', openingHalfDays: 11, balanceHalfDays: 9 },
        { typeKey: 'sick', openingHalfDays: 0, balanceHalfDays: 0 },
      ],
      offset: { openingMinutes: 750, balanceMinutes: 720 },
      payrollOpening: 'notEntered',
      canEnter: true,
      canEnterPayrollOpening: true,
    });
    expect(view.rows.find((r) => r.employeeId === hr.employeeId)?.canEnter).toBe(false);
    expect(view.rows.find((r) => r.employeeId === hrStaff.employeeId)).toMatchObject({
      canEnter: true,
      canEnterPayrollOpening: false,
    });
  });

  it('locks the go-live date once an opening exists', async () => {
    const value = { ...structuredClone(SEED_LEAVE_SETTINGS), goLiveDate: '2026-12-01' };
    await expect(
      addLeaveSettingsVersion(hrOwner.actor, {
        effectiveFrom: '2026-10-20',
        source: 'Made-up change',
        value,
      }),
    ).rejects.toThrow(/go-live date can’t change/);
    await addLeaveSettingsVersion(hrOwner.actor, {
      effectiveFrom: '2026-10-20',
      source: 'Made-up change',
      value: { ...value, goLiveDate: GO_LIVE },
    });
  });
});

describe('year-to-date pay', () => {
  const amounts = {
    grossCentavos: 31415926,
    basicSalaryEarnedCentavos: 27182818,
    taxableCompensationCentavos: 16180339,
    taxWithheldCentavos: 1414213,
    sssEmployeeCentavos: 1732050,
    philhealthEmployeeCentavos: 2236067,
    pagibigEmployeeCentavos: 1000000,
  };

  it('stores the figures encrypted, audits without them, and shows them masked', async () => {
    const { id } = await enterPayrollOpening(hr.actor, {
      employeeId: employee.employeeId,
      ...amounts,
    });
    const raw = await database()
      .collection('payrollOpeningEntries')
      .findOne({ _id: new Types.ObjectId(id) });
    expect(raw).toMatchObject({ year: 2026, supersedesId: null, reason: null });
    for (const path of Object.keys(amounts)) expect(isEncryptedValue(raw?.[path])).toBe(true);
    const audit = withoutIdsAndDates(await rawAuditJson());
    for (const value of Object.values(amounts)) expect(audit).not.toContain(String(value));
    const [entry] = await auditEntries(PAYROLL_OPENING_ENTRY_TYPE);
    expect(entry?.record.label).toBe(`${employee.employeeNumber} · 2026`);

    const section = await getPayrollOpeningSection(hr.actor, employee.employeeId);
    expect(section).toMatchObject({ year: 2026, status: 'entered', history: [], canEnter: true });
    expect(section?.current?.figures.gross).toEqual({
      mask: '••••',
      ownerType: PAYROLL_OPENING_ENTRY_TYPE,
      ownerId: id,
      field: 'gross',
    });
    expect(JSON.stringify(section)).not.toContain('31415926');
    expect(
      (await getOpeningBalances(hr.actor)).rows.find((r) => r.employeeId === employee.employeeId)
        ?.payrollOpening,
    ).toBe('entered');
  });

  it('reveals a figure only to whoever may reveal salary, audit-logged', async () => {
    const section = await getPayrollOpeningSection(hr.actor, employee.employeeId);
    const ownerId = section?.current?.id ?? '';
    expect(
      await revealSensitiveField({
        actor: hr.actor,
        ownerType: PAYROLL_OPENING_ENTRY_TYPE,
        ownerId,
        field: 'taxWithheld',
      }),
    ).toBe('1414213');
    const reveals = await database()
      .collection('auditLogs')
      .find({ action: 'reveal', 'record.id': new Types.ObjectId(ownerId) })
      .toArray();
    expect(reveals.map((row) => row.field ?? row.reason ?? row.record.label)).toHaveLength(1);
    await expect(
      revealSensitiveField({
        actor: netWriter.actor,
        ownerType: PAYROLL_OPENING_ENTRY_TYPE,
        ownerId,
        field: 'gross',
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    expect(await getPayrollOpeningSection(netWriter.actor, employee.employeeId)).toBeNull();
  });

  it('corrects by superseding the latest entry with a reason; the latest wins', async () => {
    const first = (await getPayrollOpeningSection(hr.actor, employee.employeeId))?.current?.id;
    await expect(
      enterPayrollOpening(hr.actor, { employeeId: employee.employeeId, ...amounts }),
    ).rejects.toThrow(PAYROLL_OPENING_STALE);
    await expect(
      enterPayrollOpening(hr.actor, {
        employeeId: employee.employeeId,
        ...amounts,
        supersedesId: first,
      }),
    ).rejects.toThrow('Enter the reason for the correction.');
    const { id } = await enterPayrollOpening(hr.actor, {
      employeeId: employee.employeeId,
      ...amounts,
      grossCentavos: 31415927,
      supersedesId: first,
      reason: 'Typo in gross pay',
    });
    const section = await getPayrollOpeningSection(hr.actor, employee.employeeId);
    expect(section?.current).toMatchObject({
      id,
      supersedesId: first,
      reason: 'Typo in gross pay',
    });
    expect(section?.history.map((entry) => entry.id)).toEqual([first]);
    // Correcting the old entry again is stale.
    await expect(
      enterPayrollOpening(hr.actor, {
        employeeId: employee.employeeId,
        ...amounts,
        supersedesId: first,
        reason: 'Again',
      }),
    ).rejects.toThrow(PAYROLL_OPENING_STALE);
  });

  it('follows the salary rule: HR can’t enter an HR employee’s, the System Administrator can', async () => {
    await expect(
      enterPayrollOpening(hr.actor, { employeeId: hrStaff.employeeId, ...amounts }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(
      enterPayrollOpening(netWriter.actor, { employeeId: colleague.employeeId, ...amounts }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(
      enterPayrollOpening(hr.actor, { employeeId: hr.employeeId, ...amounts }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await enterPayrollOpening(admin.actor, { employeeId: hrStaff.employeeId, ...amounts });
    await expect(
      enterPayrollOpening(admin.actor, { employeeId: newHire.employeeId, ...amounts }),
    ).rejects.toThrow(/hired before the go-live date/);
  });

  it('never changes or deletes an entry', async () => {
    await expect(PayrollOpeningEntryModel.deleteMany({})).rejects.toThrow();
  });
});
