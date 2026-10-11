import { beforeAll, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { ActionError, addDays, businessToday } from '@pulse/core';
import { decryptSensitive, HIDDEN_SENSITIVE } from '@pulse/core/server';
import {
  compensationStatuses,
  currentCompensationEntry,
  latestEffectiveDate,
} from '../../compensation';
import { compensationEntryFormSchema } from '../../validation';
import { COMPENSATION_ENTRY_TYPE } from '../../views';
import { getEmployeeRecordView } from '../employee-records/service';
import { registerTalentSensitiveReveals } from '../sensitive/reveals';
import { revealSensitiveField } from '@pulse/core/server';
import {
  auditEntries,
  type Department,
  department,
  type Person,
  person,
  rawAuditJson,
  withoutIdsAndDates,
} from '../testing/fixtures';
import { CompensationEntryModel } from './model';
import { addCompensationEntry } from './service';

// Compensation history (docs/modules/talent.md#the-employee-record-build-step-21,
// docs/DATA_MODEL.md#locked-and-append-only-records, docs/TESTING.md#employee-record-tests).
// Made-up data only.

let NET: Department;
let HRD: Department;
let hr: Person;

beforeAll(async () => {
  await connectDb();
  await CompensationEntryModel.init();
  NET = await department('Network', 'NET');
  HRD = await department('Human Resource', 'HR');
  hr = await person('Hana', 'Reyes', HRD, { talent: 'write' });
  registerTalentSensitiveReveals();
});

function entry(
  subject: Person,
  effectiveDate: string,
  basicSalaryCentavos: number,
  reason = 'Raise',
) {
  return {
    employeeId: subject.employeeId,
    effectiveDate,
    basicSalaryCentavos,
    rateType: 'monthly' as const,
    minimumWageEarner: false,
    reason,
  };
}

describe('insert-only entries', () => {
  it('refuses every update, replacement and delete', async () => {
    const subject = await person('Ana', 'Bello', NET);
    const { id } = await addCompensationEntry(hr.actor, entry(subject, '2024-02-01', 2500000));
    const filter = { _id: new Types.ObjectId(id) };
    const refused = /never changed or deleted/;
    await expect(
      CompensationEntryModel.updateOne(filter, { $set: { reason: 'Edited' } }),
    ).rejects.toThrow(refused);
    await expect(
      CompensationEntryModel.updateMany(filter, { $set: { reason: 'Edited' } }),
    ).rejects.toThrow(refused);
    await expect(
      CompensationEntryModel.findOneAndUpdate(filter, { $set: { rateType: 'daily' } }),
    ).rejects.toThrow(refused);
    await expect(
      CompensationEntryModel.replaceOne(filter, { employeeId: new Types.ObjectId() }),
    ).rejects.toThrow(refused);
    await expect(CompensationEntryModel.deleteOne(filter)).rejects.toThrow(refused);
    await expect(CompensationEntryModel.deleteMany(filter)).rejects.toThrow(refused);
    await expect(CompensationEntryModel.findOneAndDelete(filter)).rejects.toThrow(refused);
    await expect(
      CompensationEntryModel.findOneAndReplace(filter, { employeeId: new Types.ObjectId() }),
    ).rejects.toThrow(refused);
    await expect(
      CompensationEntryModel.findByIdAndUpdate(id, { reason: 'Edited' }),
    ).rejects.toThrow(refused);
    await expect(
      CompensationEntryModel.aggregate([
        { $match: filter },
        { $set: { reason: 'Edited' } },
        { $merge: { into: 'compensationEntries' } },
      ]),
    ).rejects.toThrow(refused);
    await expect(CompensationEntryModel.bulkWrite([{ deleteOne: { filter } }])).rejects.toThrow(
      refused,
    );
    await expect(
      CompensationEntryModel.bulkWrite([
        { updateOne: { filter, update: { $set: { reason: 'Edited' } } } },
      ]),
    ).rejects.toThrow(refused);
    const loaded = await CompensationEntryModel.findById(id).orFail();
    loaded.set('minimumWageEarner', true);
    await expect(loaded.save()).rejects.toThrow(refused);
    await expect(loaded.deleteOne()).rejects.toThrow(refused);
    const stored = await CompensationEntryModel.findById(id).lean();
    expect(stored?.reason).toBe('Raise');
    expect(stored?.minimumWageEarner).toBe(false);
  });

  it('writes one create entry per entry, with the salary hidden', async () => {
    const subject = await person('Berto', 'Cosme', NET);
    await addCompensationEntry(hr.actor, entry(subject, '2024-01-01', 2000000, 'Starting salary'));
    await addCompensationEntry(hr.actor, entry(subject, '2024-03-01', 2200000, 'Raise'));
    const entries = (await auditEntries(COMPENSATION_ENTRY_TYPE)).filter((e) =>
      String(e.record.label).startsWith(subject.employeeNumber),
    );
    expect(entries.map((e) => [e.action, e.record.label, e.module])).toEqual([
      ['create', `${subject.employeeNumber} · 2024-01-01`, 'talent'],
      ['create', `${subject.employeeNumber} · 2024-03-01`, 'talent'],
    ]);
    expect(entries[0]?.after?.basicSalaryCentavos).toEqual(HIDDEN_SENSITIVE);
    const json = withoutIdsAndDates(await rawAuditJson());
    expect(json).not.toContain('2000000');
    expect(json).not.toContain('2200000');
  });
});

describe('the current entry', () => {
  it('is the latest effective date on or before today; a correction wins; a future one is scheduled', async () => {
    const subject = await person('Cita', 'Dumlao', NET);
    const today = businessToday();
    const first = await addCompensationEntry(hr.actor, entry(subject, '2024-01-01', 2000000));
    const second = await addCompensationEntry(hr.actor, entry(subject, '2024-06-01', 2300000));
    const correction = await addCompensationEntry(
      hr.actor,
      entry(subject, '2024-06-01', 2350000, 'Correction: wrong amount'),
    );
    const scheduled = await addCompensationEntry(
      hr.actor,
      entry(subject, addDays(today, 30), 2600000),
    );

    const view = await getEmployeeRecordView(hr.actor, subject.employeeId);
    const statusOf = (id: string) =>
      view?.compensation?.entries.find((candidate) => candidate.id === id)?.status;
    expect(view?.compensation?.current?.id).toBe(correction.id);
    expect(statusOf(correction.id)).toBe('current');
    expect(statusOf(second.id)).toBe('superseded');
    expect(statusOf(first.id)).toBe('previous');
    expect(statusOf(scheduled.id)).toBe('scheduled');
    expect(view?.compensation?.entries.map((e) => e.id)).toEqual([
      scheduled.id,
      correction.id,
      second.id,
      first.id,
    ]);
  });

  it('resolves statuses as a pure rule, ties by creation time', () => {
    const at = (ms: number) => new Date(Date.UTC(2024, 0, 1) + ms);
    const entries = [
      { id: 'a', effectiveDate: '2024-01-01', createdAt: at(0) },
      { id: 'b', effectiveDate: '2024-05-01', createdAt: at(1) },
      { id: 'c', effectiveDate: '2024-05-01', createdAt: at(2) },
      { id: 'd', effectiveDate: '2024-09-01', createdAt: at(3) },
    ];
    const statuses = compensationStatuses(entries, '2024-08-31');
    expect(Object.fromEntries(statuses)).toEqual({
      a: 'previous',
      b: 'superseded',
      c: 'current',
      d: 'scheduled',
    });
    expect(currentCompensationEntry(entries, '2024-09-01')?.id).toBe('d');
    expect(currentCompensationEntry(entries, '2023-12-31')).toBeNull();
    expect(latestEffectiveDate('2024-02-29')).toBe('2025-02-28');
    expect(latestEffectiveDate('2026-10-12')).toBe('2027-10-12');
  });
});

describe('amounts and dates', () => {
  it('round-trips centavos exactly, from the peso input to the reveal', async () => {
    const subject = await person('Dado', 'Esguerra', NET);
    const parsed = compensationEntryFormSchema.parse({
      employeeId: subject.employeeId,
      effectiveDate: '2024-04-01',
      basicSalary: '₱1,234,567.89',
      rateType: 'daily',
      minimumWageEarner: 'on',
      reason: 'Made-up amount',
    });
    expect(parsed.basicSalaryCentavos).toBe(123456789);
    expect(parsed.minimumWageEarner).toBe(true);
    const { id } = await addCompensationEntry(hr.actor, parsed);
    const stored = await CompensationEntryModel.findById(id).select('+basicSalaryCentavos').lean();
    expect(await decryptSensitive(stored?.basicSalaryCentavos)).toBe(123456789);
    const revealed = await revealSensitiveField({
      actor: hr.actor,
      ownerType: COMPENSATION_ENTRY_TYPE,
      ownerId: id,
      field: 'basicSalary',
    });
    expect(revealed).toBe('123456789');

    for (const [typed, centavos] of [
      ['0.01', 1],
      ['0.1', 10],
      ['19,999.99', 1999999],
      ['90071992547409.91', 9007199254740991],
    ] as const) {
      const result = compensationEntryFormSchema.parse({
        employeeId: subject.employeeId,
        effectiveDate: '2024-04-01',
        basicSalary: typed,
        rateType: 'monthly',
        reason: 'x',
      });
      expect(result.basicSalaryCentavos).toBe(centavos);
    }
  });

  it('refuses an amount of zero, more than 2 decimals, or a date outside the allowed range', async () => {
    const subject = await person('Ely', 'Fajardo', NET, { dateHired: '2024-03-15' });
    const form = (basicSalary: string) =>
      compensationEntryFormSchema.safeParse({
        employeeId: subject.employeeId,
        effectiveDate: '2024-04-01',
        basicSalary,
        rateType: 'monthly',
        reason: 'x',
      });
    expect(form('0').success).toBe(false);
    expect(form('100.123').success).toBe(false);
    expect(form('-5').success).toBe(false);
    expect(form('').success).toBe(false);

    await expect(
      addCompensationEntry(hr.actor, entry(subject, '2024-03-14', 2000000)),
    ).rejects.toMatchObject({ field: 'effectiveDate' });
    const tooLate = addDays(latestEffectiveDate(businessToday()), 1);
    await expect(
      addCompensationEntry(hr.actor, entry(subject, tooLate, 2000000)),
    ).rejects.toBeInstanceOf(ActionError);
    await addCompensationEntry(hr.actor, entry(subject, '2024-03-15', 2000000));
    await addCompensationEntry(
      hr.actor,
      entry(subject, latestEffectiveDate(businessToday()), 2100000),
    );
    expect(
      await CompensationEntryModel.countDocuments({
        employeeId: new Types.ObjectId(subject.employeeId),
      }),
    ).toBe(2);
  });
});
