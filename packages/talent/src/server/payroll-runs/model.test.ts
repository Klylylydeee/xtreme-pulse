import { beforeAll, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { connectDb, withTransaction } from '@pulse/db';
import { decryptSensitive, encryptSensitive, isEncryptedValue } from '@pulse/core/server';
import { database } from '../testing/fixtures';
import {
  ONE_RUN_PER_CUT_OFF_INDEX,
  PAYROLL_RUN_TOTAL_PATHS,
  PayrollRunEmployeeModel,
  PayrollRunModel,
} from './model';

// The payroll run models (build step 2.9, docs/DATA_MODEL.md#collection-ownership; decisions 327,
// 340, 341 and 343 in docs/BUILD_PLAN.md): the fields and indexes, the encrypted amounts with the
// `$jsonSchema` backstop, and the write guards (a draft changes only through a recompute; a
// draft's lines are replaced as a set; nothing else changes). Made-up figures only.

const day = (date: string) => new Date(`${date}T00:00:00+08:00`);

let year = 2100;
/** A run's fixed fields, for a cut-off of its own (so the unique index never clashes). */
function runFields(overrides: Record<string, unknown> = {}) {
  year += 1;
  return {
    number: `PAY-${year}-0001`,
    kind: 'regular' as const,
    cutOffKey: 'midMonth' as const,
    periodStart: day(`${year - 1}-12-26`),
    periodEnd: day(`${year}-01-10`),
    payDate: day(`${year}-01-15`),
    contributionMonth: `${year}-01`,
    computedAt: new Date(),
    computedBy: null,
    settingVersions: [
      { key: 'talent.payrollSettings', effectiveFrom: '2000-01-01' },
      { key: 'talent.payrollRunSettings', effectiveFrom: '2000-01-01' },
    ],
    employeeCount: 1,
    leftOut: [{ employeeId: new Types.ObjectId(), reason: 'noSalary' as const }],
    ...overrides,
  };
}

async function encryptedTotals(amount = 1234567) {
  return Object.fromEntries(
    await Promise.all(
      PAYROLL_RUN_TOTAL_PATHS.map(async (path) => [path, await encryptSensitive(amount)] as const),
    ),
  );
}

async function createRun(overrides: Record<string, unknown> = {}) {
  return PayrollRunModel.create({ ...runFields(overrides), totals: await encryptedTotals() });
}

async function lineFields(runId: Types.ObjectId, overrides: Record<string, unknown> = {}) {
  return {
    runId,
    employeeId: new Types.ObjectId(),
    periodStart: day('2026-09-26'),
    timesheetId: new Types.ObjectId(),
    timesheetStatus: 'approved' as const,
    timesheetApproved: true,
    settledPeriods: [day('2026-09-26')],
    negativeNet: false,
    grossCentavos: await encryptSensitive(1087500),
    deductionsCentavos: await encryptSensitive(120000),
    netPayCentavos: await encryptSensitive(967500),
    reimbursementsCentavos: await encryptSensitive(0),
    breakdown: await encryptSensitive(JSON.stringify({ breakdownVersion: 1, lines: [] })),
    breakdownVersion: 1,
    ...overrides,
  };
}

/** A run whose status is set past draft at insert (step 2.10 moves it there; here, a fixture). */
async function finalizedRun() {
  return createRun({ status: 'finalized' });
}

beforeAll(async () => {
  await connectDb();
});

describe('payrollRuns', () => {
  it('stores a draft with its totals encrypted and its plain fields plain', async () => {
    const run = await createRun();
    expect(run.status).toBe('draft');
    expect(run.version).toBe(1);
    const raw = await database().collection('payrollRuns').findOne({ _id: run._id });
    expect(raw).toMatchObject({ kind: 'regular', employeeCount: 1, status: 'draft' });
    for (const path of PAYROLL_RUN_TOTAL_PATHS) {
      expect(isEncryptedValue(raw?.totals?.[path]), path).toBe(true);
    }
    expect(JSON.stringify(raw)).not.toContain('1234567');
    // Left out of queries unless selected.
    const plain = await PayrollRunModel.findById(run._id).lean();
    expect(plain?.totals?.grossCentavos).toBeUndefined();
    const selected = await PayrollRunModel.findById(run._id)
      .select('+totals.netPayCentavos')
      .lean();
    expect(await decryptSensitive(selected?.totals.netPayCentavos)).toBe(1234567);
  });

  it('refuses plain totals in the model and in the collection validator', async () => {
    const fields = runFields();
    await expect(
      PayrollRunModel.create({
        ...fields,
        totals: Object.fromEntries(PAYROLL_RUN_TOTAL_PATHS.map((path) => [path, 100])),
      }),
    ).rejects.toThrow();
    await expect(
      database()
        .collection('payrollRuns')
        .insertOne({ ...fields, status: 'draft', version: 1, totals: { grossCentavos: 100 } }),
    ).rejects.toMatchObject({ code: 121 });
    expect(await PayrollRunModel.countDocuments({ number: fields.number })).toBe(0);
  });

  it('refuses a bad number, contribution month, kind, status or count', async () => {
    const totals = await encryptedTotals();
    for (const change of [
      { number: 'PR-2026-0001' },
      { contributionMonth: '2026-13' },
      { kind: 'bonus' },
      { status: 'approved' },
      { employeeCount: -1 },
      { employeeCount: 1.5 },
      { cutOffKey: 'weekly' },
      { leftOut: [{ employeeId: new Types.ObjectId(), reason: 'other' }] },
      { settingVersions: [{ key: 'talent.payrollSettings', effectiveFrom: '2026-9-1' }] },
    ]) {
      await expect(PayrollRunModel.create({ ...runFields(change), totals })).rejects.toThrow();
    }
  });

  it('keeps one run of a kind per cut-off, and one run per number', async () => {
    const run = await createRun();
    await expect(
      PayrollRunModel.create({
        ...runFields({ periodStart: run.periodStart }),
        totals: await encryptedTotals(),
      }),
    ).rejects.toMatchObject({
      code: 11000,
      message: expect.stringContaining(ONE_RUN_PER_CUT_OFF_INDEX),
    });
    await expect(
      PayrollRunModel.create({
        ...runFields({ number: run.number }),
        totals: await encryptedTotals(),
      }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('lets a recompute change a draft only, and refuses every other write', async () => {
    const run = await createRun();
    const recompute = async (filter: Record<string, unknown>) =>
      PayrollRunModel.updateOne(filter, {
        $set: { computedAt: new Date(), employeeCount: 2, totals: await encryptedTotals(99) },
        $inc: { version: 1 },
      });
    expect((await recompute({ _id: run._id, status: 'draft', version: 1 })).modifiedCount).toBe(1);
    const after = await PayrollRunModel.findById(run._id).select('+totals.grossCentavos').lean();
    expect(after).toMatchObject({ version: 2, employeeCount: 2 });
    expect(await decryptSensitive(after?.totals.grossCentavos)).toBe(99);

    // Not filtered on draft, a fixed field, the status, a replacement, a delete.
    await expect(recompute({ _id: run._id })).rejects.toThrow(/only a draft changes/);
    await expect(
      PayrollRunModel.updateOne(
        { _id: run._id, status: 'draft' },
        { $set: { number: 'PAY-1-0001' } },
      ),
    ).rejects.toThrow(/only a draft changes/);
    await expect(
      PayrollRunModel.updateOne(
        { _id: run._id, status: 'draft' },
        { $set: { status: 'finalized' } },
      ),
    ).rejects.toThrow(/only a draft changes/);
    await expect(
      PayrollRunModel.updateMany({ status: 'draft' }, { $inc: { version: 1 } }),
    ).rejects.toThrow(/only a draft changes/);
    await expect(PayrollRunModel.replaceOne({ _id: run._id }, {})).rejects.toThrow();
    await expect(PayrollRunModel.deleteOne({ _id: run._id })).rejects.toThrow(/never deleted/);
    await expect(PayrollRunModel.deleteMany({ _id: run._id })).rejects.toThrow(/never deleted/);
    const loaded = await PayrollRunModel.findById(run._id);
    if (!loaded) throw new Error('missing');
    loaded.employeeCount = 5;
    await expect(loaded.save()).rejects.toThrow(/never deleted/);
    await expect(
      PayrollRunModel.bulkWrite([
        { updateOne: { filter: { _id: run._id }, update: { $set: { employeeCount: 9 } } } },
      ]),
    ).rejects.toThrow();

    // A finalized run doesn't match a draft's filter, so a recompute leaves it alone.
    const finalized = await finalizedRun();
    expect((await recompute({ _id: finalized._id, status: 'draft' })).matchedCount).toBe(0);
  });
});

describe('payrollRunEmployees', () => {
  it('stores a line with its amounts and breakdown encrypted', async () => {
    const run = await createRun();
    const line = await PayrollRunEmployeeModel.create(await lineFields(run._id));
    const raw = await database().collection('payrollRunEmployees').findOne({ _id: line._id });
    expect(raw).toMatchObject({
      timesheetStatus: 'approved' as const,
      negativeNet: false,
      breakdownVersion: 1,
    });
    for (const path of [
      'grossCentavos',
      'deductionsCentavos',
      'netPayCentavos',
      'reimbursementsCentavos',
      'breakdown',
    ]) {
      expect(isEncryptedValue(raw?.[path]), path).toBe(true);
    }
    expect(JSON.stringify(raw)).not.toContain('1087500');
    const selected = await PayrollRunEmployeeModel.findById(line._id).select('+breakdown').lean();
    expect(JSON.parse(String(await decryptSensitive(selected?.breakdown)))).toEqual({
      breakdownVersion: 1,
      lines: [],
    });
  });

  it('refuses plain amounts in the model and in the collection validator, and a second line per employee', async () => {
    const run = await createRun();
    const fields = await lineFields(run._id);
    await expect(
      PayrollRunEmployeeModel.create({ ...fields, netPayCentavos: 967500 as never }),
    ).rejects.toThrow();
    await expect(
      database()
        .collection('payrollRunEmployees')
        .insertOne({ runId: run._id, employeeId: fields.employeeId, breakdown: '{"lines":[]}' }),
    ).rejects.toMatchObject({ code: 121 });
    await PayrollRunEmployeeModel.create(fields);
    await expect(
      PayrollRunEmployeeModel.create(await lineFields(run._id, { employeeId: fields.employeeId })),
    ).rejects.toMatchObject({ code: 11000 });
    await expect(
      PayrollRunEmployeeModel.create(await lineFields(run._id, { timesheetStatus: 'locked?' })),
    ).rejects.toThrow();
    await expect(
      PayrollRunEmployeeModel.create(await lineFields(run._id, { breakdownVersion: 0 })),
    ).rejects.toThrow();
  });

  it('replaces a draft run’s lines as a set in one transaction', async () => {
    const run = await createRun();
    await PayrollRunEmployeeModel.bulkWrite([
      { insertOne: { document: await lineFields(run._id) } },
      { insertOne: { document: await lineFields(run._id) } },
    ]);
    const replacements = [await lineFields(run._id)];
    await withTransaction(async (session) => {
      await PayrollRunEmployeeModel.deleteMany({ runId: run._id }, { session });
      await PayrollRunEmployeeModel.bulkWrite(
        replacements.map((document) => ({ insertOne: { document } })),
        { session },
      );
      await PayrollRunModel.updateOne(
        { _id: run._id, status: 'draft', version: 1 },
        { $set: { employeeCount: 1, computedAt: new Date() }, $inc: { version: 1 } },
        { session },
      );
    });
    expect(await PayrollRunEmployeeModel.countDocuments({ runId: run._id })).toBe(1);
  });

  it('creates a run and its lines in the same transaction', async () => {
    const fields = runFields();
    const totals = await encryptedTotals();
    const lines = await lineFields(new Types.ObjectId());
    await withTransaction(async (session) => {
      const [run] = await PayrollRunModel.create([{ ...fields, totals }], { session });
      if (!run) throw new Error('missing');
      await PayrollRunEmployeeModel.bulkWrite(
        [{ insertOne: { document: { ...lines, runId: run._id } } }],
        { session },
      );
      await PayrollRunEmployeeModel.create([await lineFields(run._id)], { session, ordered: true });
    });
    const run = await PayrollRunModel.findOne({ number: fields.number }).lean();
    expect(await PayrollRunEmployeeModel.countDocuments({ runId: run?._id })).toBe(2);
  });

  it('refuses lines for a run that is not a draft, for no run, and through insertMany', async () => {
    const finalized = await finalizedRun();
    await expect(PayrollRunEmployeeModel.create(await lineFields(finalized._id))).rejects.toThrow(
      /never edited/,
    );
    await expect(
      PayrollRunEmployeeModel.bulkWrite([
        { insertOne: { document: await lineFields(new Types.ObjectId()) } },
      ]),
    ).rejects.toThrow(/never edited/);
    // insertMany can't see the session, so it is refused outright, even for a draft.
    const draft = await createRun();
    await expect(PayrollRunEmployeeModel.insertMany([await lineFields(draft._id)])).rejects.toThrow(
      /bulkWrite insertOne/,
    );
    await expect(
      PayrollRunEmployeeModel.bulkWrite([
        { insertOne: { document: await lineFields(finalized._id) } },
      ]),
    ).rejects.toThrow(/never edited/);
    expect(await PayrollRunEmployeeModel.countDocuments({ runId: finalized._id })).toBe(0);
  });

  it('never deletes a finalized run’s lines, and refuses every edit', async () => {
    const run = await createRun();
    const line = await PayrollRunEmployeeModel.create(await lineFields(run._id));
    // Move the run past draft through the raw driver (step 2.10 will do it through the service).
    await database()
      .collection('payrollRuns')
      .updateOne({ _id: run._id }, { $set: { status: 'finalized' } });
    await expect(PayrollRunEmployeeModel.deleteMany({ runId: run._id })).rejects.toThrow(
      /never edited/,
    );
    await expect(
      PayrollRunEmployeeModel.deleteMany({ employeeId: line.employeeId }),
    ).rejects.toThrow(/never edited/);
    await expect(PayrollRunEmployeeModel.deleteOne({ _id: line._id })).rejects.toThrow(
      /never edited/,
    );
    await expect(
      PayrollRunEmployeeModel.updateOne({ _id: line._id }, { $set: { negativeNet: true } }),
    ).rejects.toThrow(/never edited/);
    await expect(
      PayrollRunEmployeeModel.updateMany({ runId: run._id }, { $set: { negativeNet: true } }),
    ).rejects.toThrow(/never edited/);
    const loaded = await PayrollRunEmployeeModel.findById(line._id);
    if (!loaded) throw new Error('missing');
    loaded.negativeNet = true;
    await expect(loaded.save()).rejects.toThrow(/never edited/);
    await expect(
      PayrollRunEmployeeModel.aggregate([{ $match: {} }, { $out: 'payrollRunEmployeesCopy' }]),
    ).rejects.toThrow();
    expect(await PayrollRunEmployeeModel.countDocuments({ runId: run._id })).toBe(1);
  });
});
