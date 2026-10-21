import { beforeAll, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { connectDb, withTransaction } from '@pulse/db';
import { decryptSensitive, encryptSensitive, isEncryptedValue } from '@pulse/core/server';
import { database } from '../testing/fixtures';
import { PAYROLL_RUN_TOTAL_PATHS, PayrollRunModel } from '../payroll-runs/model';
import {
  manualEntryShapeError,
  ONE_ACKNOWLEDGEMENT_PER_FLAG_INDEX,
  ONE_ENTRY_PER_SUPERSEDED_INDEX,
  PAYROLL_MANUAL_ENTRY_AMOUNT_SELECT,
  PayrollFlagAcknowledgementModel,
  PayrollManualEntryModel,
} from './model';

// The payroll review models (build step 2.10, docs/DATA_MODEL.md#collection-ownership; decisions
// 353, 355, 358 and 371–372 in docs/BUILD_PLAN.md): manual entries and flag acknowledgements are
// insert-only, inserted only for a draft or returned run (checked in the write's session), and a
// manual entry's amount is encrypted with the `$jsonSchema` backstop. Made-up figures only.

const day = (date: string) => new Date(`${date}T00:00:00+08:00`);

let year = 2300;
async function runIn(status: 'draft' | 'pendingApproval' | 'returned' | 'finalized') {
  year += 1;
  const totals = Object.fromEntries(
    await Promise.all(
      PAYROLL_RUN_TOTAL_PATHS.map(async (path) => [path, await encryptSensitive(0)] as const),
    ),
  );
  return PayrollRunModel.create({
    number: `PAY-${year}-0001`,
    kind: 'regular',
    cutOffKey: 'midMonth',
    periodStart: day(`${year - 1}-12-26`),
    periodEnd: day(`${year}-01-10`),
    payDate: day(`${year}-01-15`),
    contributionMonth: `${year}-01`,
    status,
    computedAt: new Date(),
    computedBy: null,
    employeeCount: 1,
    totals,
  });
}

async function earning(runId: Types.ObjectId, overrides: Record<string, unknown> = {}) {
  return {
    runId,
    employeeId: new Types.ObjectId(),
    kind: 'earning' as const,
    label: 'Back pay: salary increase from Sep 15',
    amountCentavos: await encryptSensitive(100000),
    taxable: true,
    countsAsBasicSalary: true,
    reason: 'Salary increase approved late',
    ...overrides,
  };
}

const deductionSwitches = {
  kind: 'deduction',
  label: 'Cash advance',
  taxable: null,
  reducesTaxablePay: false,
  authorizedInWriting: true,
  countsAsBasicSalary: false,
} as const;
const overrideSwitches = {
  kind: 'override',
  label: 'Withholding tax',
  targetLineKey: 'withholdingTax',
  taxable: null,
  countsAsBasicSalary: null,
} as const;

beforeAll(async () => {
  await connectDb();
});

describe('payrollManualEntries', () => {
  it('stores an entry with its amount encrypted and the rest plain', async () => {
    const run = await runIn('draft');
    const entry = await PayrollManualEntryModel.create(await earning(run._id));
    expect(entry.toObject()).toMatchObject({
      kind: 'earning',
      targetLineKey: null,
      reducesTaxablePay: null,
      authorizedInWriting: null,
      supersedesId: null,
      removed: false,
    });
    const raw = await database().collection('payrollManualEntries').findOne({ _id: entry._id });
    expect(raw).toMatchObject({ label: 'Back pay: salary increase from Sep 15', taxable: true });
    expect(isEncryptedValue(raw?.amountCentavos)).toBe(true);
    expect(JSON.stringify(raw)).not.toContain('100000');
    expect((await PayrollManualEntryModel.findById(entry._id).lean())?.amountCentavos).toBe(
      undefined,
    );
    const selected = await PayrollManualEntryModel.findById(entry._id)
      .select(PAYROLL_MANUAL_ENTRY_AMOUNT_SELECT)
      .lean();
    expect(await decryptSensitive(selected?.amountCentavos)).toBe(100000);
  });

  it('refuses a plain amount in the model and in the collection validator', async () => {
    const run = await runIn('draft');
    await expect(
      PayrollManualEntryModel.create(await earning(run._id, { amountCentavos: 100000 })),
    ).rejects.toThrow();
    await expect(
      database()
        .collection('payrollManualEntries')
        .insertOne({ runId: run._id, label: 'Plain', amountCentavos: 100000 }),
    ).rejects.toMatchObject({ code: 121 });
    expect(await PayrollManualEntryModel.countDocuments({ runId: run._id })).toBe(0);
  });

  it('checks the switches each kind needs', async () => {
    const run = await runIn('returned');
    // Each kind, as it should be.
    await PayrollManualEntryModel.create(await earning(run._id, { taxable: false }));
    await PayrollManualEntryModel.create(await earning(run._id, deductionSwitches));
    await PayrollManualEntryModel.create(
      await earning(run._id, {
        ...deductionSwitches,
        reducesTaxablePay: true,
        authorizedInWriting: false,
      }),
    );
    await PayrollManualEntryModel.create(
      await earning(run._id, { ...overrideSwitches, amountCentavos: await encryptSensitive(0) }),
    );
    for (const overrides of [
      // An after-tax deduction needs the written authorization (case A3).
      { ...deductionSwitches, authorizedInWriting: false },
      { ...deductionSwitches, reducesTaxablePay: null },
      { ...deductionSwitches, taxable: true },
      { taxable: null },
      { countsAsBasicSalary: null },
      { reducesTaxablePay: true },
      { targetLineKey: 'basicPay' },
      { ...overrideSwitches, targetLineKey: null },
      { ...overrideSwitches, taxable: true },
      { ...overrideSwitches, countsAsBasicSalary: false },
      { kind: 'bonus' },
      { label: '' },
      { label: 'x'.repeat(81) },
      { reason: '' },
      { reason: 'x'.repeat(501) },
      { amountCentavos: undefined },
      { removed: true },
    ]) {
      await expect(
        PayrollManualEntryModel.create(await earning(run._id, overrides)),
        JSON.stringify(overrides),
      ).rejects.toThrow();
    }
    expect(
      manualEntryShapeError({
        ...deductionSwitches,
        authorizedInWriting: false,
        amountCentavos: 1,
      }),
    ).toMatch(/authorized in writing/);
  });

  it('chains edits and removals: one entry per superseded entry', async () => {
    const run = await runIn('draft');
    const first = await PayrollManualEntryModel.create(await earning(run._id));
    const edit = await PayrollManualEntryModel.create(
      await earning(run._id, { employeeId: first.employeeId, supersedesId: first._id }),
    );
    // A second change of the same entry loses: it must supersede the latest.
    await expect(
      PayrollManualEntryModel.create(
        await earning(run._id, { employeeId: first.employeeId, supersedesId: first._id }),
      ),
    ).rejects.toMatchObject({
      code: 11000,
      message: expect.stringContaining(ONE_ENTRY_PER_SUPERSEDED_INDEX),
    });
    // A removal may leave the amount out.
    const removal = await PayrollManualEntryModel.create(
      await earning(run._id, {
        employeeId: first.employeeId,
        supersedesId: edit._id,
        removed: true,
        amountCentavos: undefined,
      }),
    );
    expect(removal.removed).toBe(true);
    expect(await PayrollManualEntryModel.countDocuments({ runId: run._id })).toBe(3);
  });

  it('is inserted only for a draft or returned run, checked in the session', async () => {
    for (const status of ['pendingApproval', 'finalized'] as const) {
      const run = await runIn(status);
      await expect(PayrollManualEntryModel.create(await earning(run._id)), status).rejects.toThrow(
        /only to a draft or returned/,
      );
      await expect(
        PayrollManualEntryModel.bulkWrite([{ insertOne: { document: await earning(run._id) } }]),
        status,
      ).rejects.toThrow(/only to a draft or returned/);
      expect(await PayrollManualEntryModel.countDocuments({ runId: run._id })).toBe(0);
    }
    await expect(
      PayrollManualEntryModel.create(await earning(new Types.ObjectId())),
    ).rejects.toThrow(/only to a draft or returned/);
    const draft = await runIn('draft');
    await expect(PayrollManualEntryModel.insertMany([await earning(draft._id)])).rejects.toThrow(
      /create\(\) or bulkWrite insertOne/,
    );
    // In a transaction: the run as the session sees it.
    const entry = await earning(draft._id);
    await withTransaction(async (session) => {
      await PayrollManualEntryModel.create([entry], { session, ordered: true });
      await PayrollManualEntryModel.bulkWrite(
        [{ insertOne: { document: await earning(draft._id) } }],
        { session },
      );
    });
    expect(await PayrollManualEntryModel.countDocuments({ runId: draft._id })).toBe(2);
  });

  it('is never changed or deleted', async () => {
    const run = await runIn('draft');
    const entry = await PayrollManualEntryModel.create(await earning(run._id));
    const never = /never changed or deleted/;
    await expect(
      PayrollManualEntryModel.updateOne({ _id: entry._id }, { $set: { label: 'Changed' } }),
    ).rejects.toThrow(never);
    await expect(
      PayrollManualEntryModel.updateMany({ runId: run._id }, { $set: { removed: true } }),
    ).rejects.toThrow(never);
    await expect(
      PayrollManualEntryModel.findOneAndUpdate({ _id: entry._id }, { $set: { reason: 'x' } }),
    ).rejects.toThrow(never);
    await expect(PayrollManualEntryModel.replaceOne({ _id: entry._id }, {})).rejects.toThrow(never);
    await expect(PayrollManualEntryModel.deleteOne({ _id: entry._id })).rejects.toThrow(never);
    await expect(PayrollManualEntryModel.deleteMany({ runId: run._id })).rejects.toThrow(never);
    await expect(PayrollManualEntryModel.findOneAndDelete({ _id: entry._id })).rejects.toThrow(
      never,
    );
    await expect(
      PayrollManualEntryModel.bulkWrite([
        { updateOne: { filter: { _id: entry._id }, update: { $set: { label: 'x' } } } },
      ]),
    ).rejects.toThrow(never);
    const loaded = await PayrollManualEntryModel.findById(entry._id);
    if (!loaded) throw new Error('missing');
    loaded.set('removed', true);
    await expect(loaded.save()).rejects.toThrow(never);
    await expect(loaded.deleteOne()).rejects.toThrow(never);
    await expect(
      PayrollManualEntryModel.aggregate([{ $match: {} }, { $out: 'payrollManualEntriesCopy' }]),
    ).rejects.toThrow(never);
    expect(await PayrollManualEntryModel.countDocuments({ runId: run._id })).toBe(1);
  });
});

describe('payrollFlagAcknowledgements', () => {
  const ack = (runId: Types.ObjectId, overrides: Record<string, unknown> = {}) => ({
    runId,
    employeeId: new Types.ObjectId(),
    flag: 'onboardingIncomplete' as const,
    reason: 'Paid by check; bank details to follow',
    ...overrides,
  });

  it('stores one acknowledgement per run, employee and flag', async () => {
    const run = await runIn('returned');
    const first = await PayrollFlagAcknowledgementModel.create(ack(run._id));
    await PayrollFlagAcknowledgementModel.create(
      ack(run._id, { employeeId: first.employeeId, flag: 'timesheetNotApproved' }),
    );
    await expect(
      PayrollFlagAcknowledgementModel.create(ack(run._id, { employeeId: first.employeeId })),
    ).rejects.toMatchObject({
      code: 11000,
      message: expect.stringContaining(ONE_ACKNOWLEDGEMENT_PER_FLAG_INDEX),
    });
  });

  it('refuses the flags that cannot be acknowledged, and a bad reason', async () => {
    const run = await runIn('draft');
    for (const overrides of [
      { flag: 'netPayBelowZero' },
      { flag: 'manualEntryStale' },
      { flag: 'other' },
      { reason: '' },
      { reason: 'x'.repeat(301) },
    ]) {
      await expect(
        PayrollFlagAcknowledgementModel.create(ack(run._id, overrides)),
        JSON.stringify(overrides),
      ).rejects.toThrow();
    }
    await PayrollFlagAcknowledgementModel.create(ack(run._id, { flag: 'belowMinimumWage' }));
  });

  it('is inserted only for a draft or returned run, and never changed or deleted', async () => {
    for (const status of ['pendingApproval', 'finalized'] as const) {
      const run = await runIn(status);
      await expect(PayrollFlagAcknowledgementModel.create(ack(run._id)), status).rejects.toThrow(
        /only on a draft or returned/,
      );
      await expect(
        PayrollFlagAcknowledgementModel.bulkWrite([{ insertOne: { document: ack(run._id) } }]),
      ).rejects.toThrow(/only on a draft or returned/);
    }
    const run = await runIn('draft');
    await expect(PayrollFlagAcknowledgementModel.insertMany([ack(run._id)])).rejects.toThrow(
      /create\(\) or bulkWrite insertOne/,
    );
    const entry = await PayrollFlagAcknowledgementModel.create(ack(run._id));
    const never = /never changed or deleted/;
    await expect(
      PayrollFlagAcknowledgementModel.updateOne({ _id: entry._id }, { $set: { reason: 'x' } }),
    ).rejects.toThrow(never);
    await expect(PayrollFlagAcknowledgementModel.deleteOne({ _id: entry._id })).rejects.toThrow(
      never,
    );
    await expect(PayrollFlagAcknowledgementModel.deleteMany({ runId: run._id })).rejects.toThrow(
      never,
    );
    await expect(
      PayrollFlagAcknowledgementModel.replaceOne({ _id: entry._id }, {}),
    ).rejects.toThrow(never);
    const loaded = await PayrollFlagAcknowledgementModel.findById(entry._id);
    if (!loaded) throw new Error('missing');
    loaded.reason = 'Changed';
    await expect(loaded.save()).rejects.toThrow(never);
    expect(await PayrollFlagAcknowledgementModel.countDocuments({ runId: run._id })).toBe(1);
  });
});
