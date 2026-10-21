import { beforeAll, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { connectDb, withTransaction } from '@pulse/db';
import { decryptSensitive, encryptSensitive, isEncryptedValue } from '@pulse/core/server';
import { database } from '../testing/fixtures';
import {
  ONE_RUN_PER_CUT_OFF_INDEX,
  PAYROLL_RUN_TOTAL_PATHS,
  PAYSLIP_SNAPSHOT_SELECT,
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
    await expect(recompute({ _id: run._id })).rejects.toThrow(/changes only through/);
    await expect(
      PayrollRunModel.updateOne(
        { _id: run._id, status: 'draft' },
        { $set: { number: 'PAY-1-0001' } },
      ),
    ).rejects.toThrow(/changes only through/);
    await expect(
      PayrollRunModel.updateOne(
        { _id: run._id, status: 'draft' },
        { $set: { status: 'finalized' } },
      ),
    ).rejects.toThrow(/changes only through/);
    await expect(
      PayrollRunModel.updateMany({ status: 'draft' }, { $inc: { version: 1 } }),
    ).rejects.toThrow(/changes only through/);
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

// ---------------------------------------------------------------------------------------------
// Step 2.10 (decisions 351 and 371–372): the review fields, the status moves, the payslip snapshot.

const REMARKS = 'Check the cash advance';
const GUARD = /changes only through/;
const LINE_GUARD = /never edited/;

type Status = 'draft' | 'pendingApproval' | 'returned' | 'finalized';

/** A run created straight in a status (a fixture; the moves below are what the services do). */
async function runIn(status: Status) {
  return createRun({ status });
}

const submitUpdate = () => ({
  $set: {
    status: 'pendingApproval',
    submittedAt: new Date(),
    submittedBy: new Types.ObjectId(),
    approvalRequestId: new Types.ObjectId(),
  } as Record<string, unknown>,
  $inc: { version: 1 },
});
const returnUpdate = (remarks: unknown = REMARKS) => ({
  $set: {
    status: 'returned',
    returnedAt: new Date(),
    returnedBy: new Types.ObjectId(),
    returnRemarks: remarks,
  },
  $inc: { version: 1 },
});
const finalizeUpdate = (overrides: Record<string, unknown> = {}) => ({
  $set: {
    status: 'finalized',
    finalizedAt: new Date(),
    finalizedBy: new Types.ObjectId(),
    fiscalPosting: { status: 'notPosted' },
    payslipsPending: true,
    ...overrides,
  },
  $inc: { version: 1 },
});
const recomputeUpdate = () => ({
  $set: {
    computedAt: new Date(),
    employeeCount: 3,
    flagCounts: { onboardingIncomplete: 1, timesheetNotApproved: 2 },
  },
  $inc: { version: 1 },
});

describe('payrollRuns (step 2.10)', () => {
  it('defaults the review fields on a new run, and validates them', async () => {
    const run = await createRun();
    expect(run.toObject()).toMatchObject({
      flagCounts: {
        onboardingIncomplete: 0,
        timesheetNotApproved: 0,
        belowMinimumWage: 0,
        netPayBelowZero: 0,
        manualEntryStale: 0,
      },
      submittedAt: null,
      submittedBy: null,
      approvalRequestId: null,
      returnedAt: null,
      returnedBy: null,
      returnRemarks: null,
      finalizedAt: null,
      finalizedBy: null,
      fiscalPosting: null,
      payslipsPending: false,
    });
    await expect(createRun({ fiscalPosting: { status: 'posted' } })).rejects.toThrow();
    await expect(createRun({ flagCounts: { netPayBelowZero: -1 } })).rejects.toThrow();
    await expect(createRun({ returnRemarks: 'x'.repeat(1001) })).rejects.toThrow();
  });

  it('recomputes a draft or a returned run, with flagCounts, and nothing else', async () => {
    for (const status of ['draft', 'returned'] as const) {
      const run = await runIn(status);
      const result = await PayrollRunModel.updateOne({ _id: run._id, status }, recomputeUpdate());
      expect(result.modifiedCount, status).toBe(1);
      const after = await PayrollRunModel.findById(run._id).lean();
      expect(after?.flagCounts).toMatchObject({ onboardingIncomplete: 1, timesheetNotApproved: 2 });
      expect(after?.version).toBe(2);
    }
    const draft = await runIn('draft');
    const both = await PayrollRunModel.updateOne(
      { _id: draft._id, status: { $in: ['draft', 'returned'] } },
      recomputeUpdate(),
    );
    expect(both.modifiedCount).toBe(1);
    // A pending or finalized run is never recomputed.
    for (const status of ['pendingApproval', 'finalized'] as const) {
      const run = await runIn(status);
      await expect(
        PayrollRunModel.updateOne({ _id: run._id, status }, recomputeUpdate()),
      ).rejects.toThrow(GUARD);
    }
    await expect(
      PayrollRunModel.updateOne(
        { _id: draft._id, status: { $in: ['draft', 'pendingApproval'] } },
        recomputeUpdate(),
      ),
    ).rejects.toThrow(GUARD);
    // Without raising the version by exactly 1.
    await expect(
      PayrollRunModel.updateOne(
        { _id: draft._id, status: 'draft' },
        { $set: { employeeCount: 4 } },
      ),
    ).rejects.toThrow(GUARD);
    await expect(
      PayrollRunModel.updateOne(
        { _id: draft._id, status: 'draft' },
        { $set: { employeeCount: 4 }, $inc: { version: 2 } },
      ),
    ).rejects.toThrow(GUARD);
    // A recompute can't touch the review fields.
    for (const field of ['submittedAt', 'finalizedBy', 'payslipsPending', 'returnRemarks']) {
      await expect(
        PayrollRunModel.updateOne(
          { _id: draft._id, status: 'draft' },
          { $set: { [field]: null }, $inc: { version: 1 } },
        ),
        field,
      ).rejects.toThrow(GUARD);
    }
  });

  it('submits a draft or a returned run, and nothing else', async () => {
    for (const status of ['draft', 'returned'] as const) {
      const run = await runIn(status);
      const update = submitUpdate();
      const result = await PayrollRunModel.findOneAndUpdate(
        { _id: run._id, status, version: 1 },
        update,
        { returnDocument: 'after' },
      ).lean();
      expect(result, status).toMatchObject({
        status: 'pendingApproval',
        version: 2,
        approvalRequestId: update.$set.approvalRequestId,
      });
    }
    for (const status of ['pendingApproval', 'finalized'] as const) {
      const run = await runIn(status);
      await expect(
        PayrollRunModel.updateOne({ _id: run._id, status }, submitUpdate()),
      ).rejects.toThrow(GUARD);
    }
    const draft = await runIn('draft');
    // Not filtered on its status.
    await expect(PayrollRunModel.updateOne({ _id: draft._id }, submitUpdate())).rejects.toThrow(
      GUARD,
    );
    // Missing a submit field.
    for (const field of ['submittedAt', 'submittedBy', 'approvalRequestId']) {
      const update = submitUpdate();
      update.$set = Object.fromEntries(
        Object.entries(update.$set).filter(([key]) => key !== field),
      );
      await expect(
        PayrollRunModel.updateOne({ _id: draft._id, status: 'draft' }, update),
        field,
      ).rejects.toThrow(GUARD);
    }
    // Another field, or no version raise.
    const extra = submitUpdate();
    extra.$set.employeeCount = 9;
    await expect(
      PayrollRunModel.updateOne({ _id: draft._id, status: 'draft' }, extra),
    ).rejects.toThrow(GUARD);
    await expect(
      PayrollRunModel.updateOne({ _id: draft._id, status: 'draft' }, { $set: submitUpdate().$set }),
    ).rejects.toThrow(GUARD);
    // Straight to finalized or returned from a draft.
    await expect(
      PayrollRunModel.updateOne({ _id: draft._id, status: 'draft' }, finalizeUpdate()),
    ).rejects.toThrow(GUARD);
    await expect(
      PayrollRunModel.updateOne({ _id: draft._id, status: 'draft' }, returnUpdate()),
    ).rejects.toThrow(GUARD);
    // An unknown status.
    await expect(
      PayrollRunModel.updateOne(
        { _id: draft._id, status: 'draft' },
        { $set: { status: 'approved' }, $inc: { version: 1 } },
      ),
    ).rejects.toThrow(GUARD);
    expect((await PayrollRunModel.findById(draft._id).lean())?.status).toBe('draft');
  });

  it('returns a pending run with remarks, and nothing else', async () => {
    const run = await runIn('pendingApproval');
    const result = await PayrollRunModel.updateOne(
      { _id: run._id, status: 'pendingApproval' },
      returnUpdate(),
    );
    expect(result.modifiedCount).toBe(1);
    expect(await PayrollRunModel.findById(run._id).lean()).toMatchObject({
      status: 'returned',
      returnRemarks: REMARKS,
      version: 2,
    });
    const pending = await runIn('pendingApproval');
    for (const remarks of ['', '   ', 'x'.repeat(1001), null, 5]) {
      await expect(
        PayrollRunModel.updateOne(
          { _id: pending._id, status: 'pendingApproval' },
          returnUpdate(remarks),
        ),
        String(remarks),
      ).rejects.toThrow(GUARD);
    }
    for (const status of ['draft', 'returned', 'finalized'] as const) {
      const other = await runIn(status);
      await expect(
        PayrollRunModel.updateOne({ _id: other._id, status }, returnUpdate()),
      ).rejects.toThrow(GUARD);
    }
    await expect(
      PayrollRunModel.updateOne(
        { _id: pending._id, status: { $in: ['pendingApproval', 'draft'] } },
        returnUpdate(),
      ),
    ).rejects.toThrow(GUARD);
    // A pending run is frozen.
    await expect(
      PayrollRunModel.updateOne(
        { _id: pending._id, status: 'pendingApproval' },
        { $set: { employeeCount: 2 }, $inc: { version: 1 } },
      ),
    ).rejects.toThrow(GUARD);
    await expect(
      PayrollRunModel.updateOne({ _id: pending._id, status: 'pendingApproval' }, submitUpdate()),
    ).rejects.toThrow(GUARD);
  });

  it('finalizes a pending run with the Fiscal placeholder, and nothing else', async () => {
    const run = await runIn('pendingApproval');
    const result = await PayrollRunModel.updateOne(
      { _id: run._id, status: 'pendingApproval', version: 1 },
      finalizeUpdate(),
    );
    expect(result.modifiedCount).toBe(1);
    expect(await PayrollRunModel.findById(run._id).lean()).toMatchObject({
      status: 'finalized',
      fiscalPosting: { status: 'notPosted' },
      payslipsPending: true,
      version: 2,
    });
    const pending = await runIn('pendingApproval');
    for (const overrides of [
      { fiscalPosting: { status: 'posted' } },
      { fiscalPosting: null },
      { fiscalPosting: { status: 'notPosted', journalId: 'x' } },
      { payslipsPending: false },
      { finalizedBy: null },
      { finalizedAt: undefined },
      { employeeCount: 3 },
    ]) {
      await expect(
        PayrollRunModel.updateOne(
          { _id: pending._id, status: 'pendingApproval' },
          finalizeUpdate(overrides),
        ),
        JSON.stringify(overrides),
      ).rejects.toThrow(GUARD);
    }
    for (const status of ['draft', 'returned', 'finalized'] as const) {
      const other = await runIn(status);
      await expect(
        PayrollRunModel.updateOne({ _id: other._id, status }, finalizeUpdate()),
      ).rejects.toThrow(GUARD);
    }
  });

  it('on a finalized run, allows only clearing payslipsPending', async () => {
    const run = await runIn('pendingApproval');
    await PayrollRunModel.updateOne({ _id: run._id, status: 'pendingApproval' }, finalizeUpdate());
    const clear = { $set: { payslipsPending: false } };
    const cleared = await PayrollRunModel.updateOne({ _id: run._id, status: 'finalized' }, clear);
    expect(cleared.modifiedCount).toBe(1);
    expect(await PayrollRunModel.findById(run._id).lean()).toMatchObject({
      payslipsPending: false,
      version: 2,
    });
    const refused: [Record<string, unknown>, Record<string, unknown>][] = [
      [{ _id: run._id }, clear],
      [{ _id: run._id, status: 'finalized' }, { $set: { payslipsPending: true } }],
      [
        { _id: run._id, status: 'finalized' },
        { ...clear, $inc: { version: 1 } },
      ],
      [
        { _id: run._id, status: 'finalized' },
        { $set: { payslipsPending: false, employeeCount: 1 } },
      ],
      [{ _id: run._id, status: 'finalized' }, { $set: { fiscalPosting: null } }],
      [
        { _id: run._id, status: 'finalized' },
        { $set: { status: 'draft' }, $inc: { version: 1 } },
      ],
      [{ _id: run._id, status: 'finalized' }, returnUpdate()],
      [{ _id: run._id, status: 'finalized' }, recomputeUpdate()],
      [{ _id: run._id, status: 'draft' }, clear],
    ];
    for (const [filter, update] of refused) {
      await expect(
        PayrollRunModel.updateOne(filter, update),
        JSON.stringify(update),
      ).rejects.toThrow(GUARD);
    }
    await expect(
      PayrollRunModel.updateOne({ _id: run._id, status: 'finalized' }, clear, { upsert: true }),
    ).rejects.toThrow(GUARD);
    await expect(PayrollRunModel.updateMany({ status: 'finalized' }, clear)).rejects.toThrow(GUARD);
  });
});

describe('payrollRunEmployees (step 2.10)', () => {
  async function snapshot(overrides: Record<string, unknown> = {}) {
    return {
      employeeName: 'Ana Cruz',
      employeeNumber: 'XW-0001',
      departmentName: 'Engineering',
      positionTitle: 'Engineer',
      bank: {
        bank: 'unionbank' as const,
        accountName: 'Ana Cruz',
        accountNumber: await encryptSensitive('109876543210'),
      },
      ytd: await encryptSensitive(JSON.stringify({ grossCentavos: 1363750 })),
      fileId: null,
      generatedAt: null,
      ...overrides,
    };
  }

  /** A run with one line, moved to `status` through the guard's own moves. */
  async function runWithLine(status: Status) {
    const run = await createRun();
    const line = await PayrollRunEmployeeModel.create(
      await lineFields(run._id, {
        flags: [
          { kind: 'onboardingIncomplete', items: ['payroll bank account not verified'] },
          { kind: 'timesheetNotApproved' },
        ],
        manualEntryCount: 2,
        breakdownVersion: 2,
      }),
    );
    if (status === 'draft') return { run, line };
    await PayrollRunModel.updateOne({ _id: run._id, status: 'draft' }, submitUpdate());
    if (status === 'returned') {
      await PayrollRunModel.updateOne({ _id: run._id, status: 'pendingApproval' }, returnUpdate());
    }
    if (status === 'finalized') {
      await PayrollRunModel.updateOne(
        { _id: run._id, status: 'pendingApproval' },
        finalizeUpdate(),
      );
    }
    return { run, line };
  }

  it('stores flags and the manual entry count plain, with defaults on a step 2.9 line', async () => {
    const { line } = await runWithLine('draft');
    const raw = await database().collection('payrollRunEmployees').findOne({ _id: line._id });
    expect(raw).toMatchObject({
      flags: [
        { kind: 'onboardingIncomplete', items: ['payroll bank account not verified'] },
        { kind: 'timesheetNotApproved', items: [] },
      ],
      manualEntryCount: 2,
      payslip: null,
      breakdownVersion: 2,
    });
    const run = await createRun();
    const plain = await PayrollRunEmployeeModel.create(await lineFields(run._id));
    expect(plain.toObject()).toMatchObject({ flags: [], manualEntryCount: 0, payslip: null });
    await expect(
      PayrollRunEmployeeModel.create(await lineFields(run._id, { flags: [{ kind: 'other' }] })),
    ).rejects.toThrow();
    await expect(
      PayrollRunEmployeeModel.create(await lineFields(run._id, { manualEntryCount: -1 })),
    ).rejects.toThrow();
  });

  it('inserts and replaces lines for a returned run, never for a pending one', async () => {
    const { run } = await runWithLine('returned');
    const replacement = await lineFields(run._id);
    await withTransaction(async (session) => {
      await PayrollRunEmployeeModel.deleteMany({ runId: run._id }, { session });
      await PayrollRunEmployeeModel.bulkWrite([{ insertOne: { document: replacement } }], {
        session,
      });
    });
    expect(await PayrollRunEmployeeModel.countDocuments({ runId: run._id })).toBe(1);
    const { run: pending } = await runWithLine('pendingApproval');
    await expect(PayrollRunEmployeeModel.deleteMany({ runId: pending._id })).rejects.toThrow(
      LINE_GUARD,
    );
    await expect(PayrollRunEmployeeModel.create(await lineFields(pending._id))).rejects.toThrow(
      LINE_GUARD,
    );
    await expect(
      PayrollRunEmployeeModel.bulkWrite([
        { insertOne: { document: await lineFields(pending._id) } },
      ]),
    ).rejects.toThrow(LINE_GUARD);
    expect(await PayrollRunEmployeeModel.countDocuments({ runId: pending._id })).toBe(1);
  });

  it('sets the payslip snapshot once, encrypted, while the run is pending', async () => {
    const { run, line } = await runWithLine('pendingApproval');
    const payslip = await snapshot();
    await withTransaction(async (session) => {
      const result = await PayrollRunEmployeeModel.updateOne(
        { _id: line._id, runId: run._id, payslip: null },
        { $set: { payslip } },
        { session },
      );
      expect(result.modifiedCount).toBe(1);
    });
    const raw = await database().collection('payrollRunEmployees').findOne({ _id: line._id });
    expect(raw?.payslip).toMatchObject({
      employeeName: 'Ana Cruz',
      employeeNumber: 'XW-0001',
      bank: { bank: 'unionbank', accountName: 'Ana Cruz' },
      fileId: null,
      generatedAt: null,
    });
    expect(isEncryptedValue(raw?.payslip?.bank?.accountNumber)).toBe(true);
    expect(isEncryptedValue(raw?.payslip?.ytd)).toBe(true);
    expect(JSON.stringify(raw)).not.toContain('109876543210');
    // Left out unless selected.
    const unselected = await PayrollRunEmployeeModel.findById(line._id).lean();
    expect(unselected?.payslip?.ytd).toBeUndefined();
    expect(unselected?.payslip?.bank?.accountNumber).toBeUndefined();
    const selected = await PayrollRunEmployeeModel.findById(line._id)
      .select(PAYSLIP_SNAPSHOT_SELECT)
      .lean();
    expect(await decryptSensitive(selected?.payslip?.bank?.accountNumber)).toBe('109876543210');
    expect(JSON.parse(String(await decryptSensitive(selected?.payslip?.ytd)))).toEqual({
      grossCentavos: 1363750,
    });

    // Once only: a second set matches nothing.
    const again = await PayrollRunEmployeeModel.updateOne(
      { _id: line._id, runId: run._id, payslip: null },
      { $set: { payslip: await snapshot({ employeeName: 'Changed' }) } },
    );
    expect(again.matchedCount).toBe(0);
  });

  it('sets every line’s snapshot in one bulkWrite, with no bank account too', async () => {
    const run = await createRun();
    const lines = await PayrollRunEmployeeModel.create(
      [await lineFields(run._id), await lineFields(run._id)],
      { ordered: true },
    );
    await PayrollRunModel.updateOne({ _id: run._id, status: 'draft' }, submitUpdate());
    const ops = await Promise.all(
      lines.map(async (line, index) => ({
        updateOne: {
          filter: { _id: line._id, runId: run._id, payslip: null },
          update: { $set: { payslip: await snapshot(index === 1 ? { bank: null } : {}) } },
        },
      })),
    );
    await withTransaction(async (session) => {
      await PayrollRunEmployeeModel.bulkWrite(
        ops as Parameters<typeof PayrollRunEmployeeModel.bulkWrite>[0],
        {
          session,
        },
      );
    });
    const stored = await PayrollRunEmployeeModel.find({ runId: run._id }).lean();
    expect(stored.every((line) => line.payslip !== null)).toBe(true);
    expect(stored.some((line) => line.payslip?.bank === null)).toBe(true);
  });

  it('refuses the snapshot outside its rule', async () => {
    const { run: draft, line: draftLine } = await runWithLine('draft');
    const { run: finalized, line: finalLine } = await runWithLine('finalized');
    const { run: pending, line } = await runWithLine('pendingApproval');
    const set = (filter: Record<string, unknown>, update: Record<string, unknown>) =>
      PayrollRunEmployeeModel.updateOne(filter, update);
    const payslip = await snapshot();
    // Not pending.
    await expect(
      set({ _id: draftLine._id, runId: draft._id, payslip: null }, { $set: { payslip } }),
    ).rejects.toThrow(LINE_GUARD);
    await expect(
      set({ _id: finalLine._id, runId: finalized._id, payslip: null }, { $set: { payslip } }),
    ).rejects.toThrow(LINE_GUARD);
    // No runId, no `payslip: null`, a file already, another field, a null payslip.
    await expect(set({ _id: line._id, payslip: null }, { $set: { payslip } })).rejects.toThrow(
      LINE_GUARD,
    );
    await expect(set({ _id: line._id, runId: pending._id }, { $set: { payslip } })).rejects.toThrow(
      LINE_GUARD,
    );
    const filter = { _id: line._id, runId: pending._id, payslip: null };
    await expect(
      set(filter, { $set: { payslip: { ...payslip, fileId: new Types.ObjectId() } } }),
    ).rejects.toThrow(LINE_GUARD);
    await expect(set(filter, { $set: { payslip, negativeNet: true } })).rejects.toThrow(LINE_GUARD);
    await expect(set(filter, { $set: { payslip: null } })).rejects.toThrow(LINE_GUARD);
    await expect(set(filter, { $unset: { payslip: 1 } })).rejects.toThrow(LINE_GUARD);
    // A plain account number never reaches the database.
    await expect(
      set(filter, {
        $set: {
          payslip: {
            ...payslip,
            bank: { bank: 'rcbc', accountName: 'A', accountNumber: '109876543210' },
          },
        },
      }),
    ).rejects.toThrow();
    // bulkWrite: an upsert, or a mix of inserts and snapshots.
    await expect(
      PayrollRunEmployeeModel.bulkWrite([
        { updateOne: { filter, update: { $set: { payslip: payslip as never } }, upsert: true } },
      ]),
    ).rejects.toThrow(LINE_GUARD);
    await expect(
      PayrollRunEmployeeModel.bulkWrite([
        { insertOne: { document: await lineFields(pending._id) } },
        { updateOne: { filter, update: { $set: { payslip: payslip as never } } } },
      ]),
    ).rejects.toThrow(LINE_GUARD);
    await expect(
      PayrollRunEmployeeModel.bulkWrite([
        { updateOne: { filter, update: { $set: { negativeNet: true } } } },
      ]),
    ).rejects.toThrow(LINE_GUARD);
    const raw = await database().collection('payrollRunEmployees').findOne({ _id: line._id });
    expect(raw?.payslip).toBeNull();
    expect(JSON.stringify(raw)).not.toContain('109876543210');
  });

  it('sets the payslip file once on a finalized run, never on a line with no snapshot', async () => {
    const run = await createRun();
    const [withSnapshot, without] = await PayrollRunEmployeeModel.create(
      [await lineFields(run._id), await lineFields(run._id)],
      { ordered: true },
    );
    if (!withSnapshot || !without) throw new Error('missing');
    await PayrollRunModel.updateOne({ _id: run._id, status: 'draft' }, submitUpdate());
    await PayrollRunEmployeeModel.updateOne(
      { _id: withSnapshot._id, runId: run._id, payslip: null },
      { $set: { payslip: await snapshot() } },
    );
    const fileUpdate = () => ({
      $set: {
        'payslip.fileId': new Types.ObjectId(),
        'payslip.generatedAt': new Date(),
      } as Record<string, unknown>,
    });
    const fileFilter = (id: Types.ObjectId) => ({
      _id: id,
      runId: run._id,
      'payslip.fileId': null,
    });
    // Not yet finalized.
    await expect(
      PayrollRunEmployeeModel.updateOne(fileFilter(withSnapshot._id), fileUpdate()),
    ).rejects.toThrow(LINE_GUARD);
    await PayrollRunModel.updateOne({ _id: run._id, status: 'pendingApproval' }, finalizeUpdate());

    const first = fileUpdate();
    const result = await PayrollRunEmployeeModel.updateOne(fileFilter(withSnapshot._id), first);
    expect(result.modifiedCount).toBe(1);
    const stored = await PayrollRunEmployeeModel.findById(withSnapshot._id).lean();
    expect(stored?.payslip?.fileId).toEqual(first.$set['payslip.fileId']);
    expect(stored?.payslip?.employeeName).toBe('Ana Cruz');
    // Once only.
    const again = await PayrollRunEmployeeModel.updateOne(
      fileFilter(withSnapshot._id),
      fileUpdate(),
    );
    expect(again.matchedCount).toBe(0);
    // A line with no snapshot is never given a partial payslip.
    const partial = await PayrollRunEmployeeModel.updateOne(fileFilter(without._id), fileUpdate());
    expect(partial.matchedCount).toBe(0);
    expect((await PayrollRunEmployeeModel.findById(without._id).lean())?.payslip).toBeNull();
    // Only both file fields, filtered on runId and `payslip.fileId: null`.
    const refused: [Record<string, unknown>, Record<string, unknown>][] = [
      [{ _id: without._id, runId: run._id }, fileUpdate()],
      [{ _id: without._id, 'payslip.fileId': null }, fileUpdate()],
      [fileFilter(without._id), { $set: { 'payslip.fileId': new Types.ObjectId() } }],
      [fileFilter(without._id), { $set: { ...fileUpdate().$set, 'payslip.employeeName': 'X' } }],
      [fileFilter(without._id), { $set: { 'payslip.fileId': null, 'payslip.generatedAt': null } }],
    ];
    for (const [filter, update] of refused) {
      await expect(
        PayrollRunEmployeeModel.updateOne(filter, update),
        JSON.stringify(update),
      ).rejects.toThrow(LINE_GUARD);
    }
    // A finalized run's lines are never deleted.
    await expect(PayrollRunEmployeeModel.deleteMany({ runId: run._id })).rejects.toThrow(
      LINE_GUARD,
    );
  });
});
