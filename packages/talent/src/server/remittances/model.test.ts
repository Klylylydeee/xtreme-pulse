import { beforeAll, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { decryptSensitive, encryptSensitive, isEncryptedValue } from '@pulse/core/server';
import { database } from '../testing/fixtures';
import {
  ONE_FIRST_PAYMENT_PER_REPORT_INDEX,
  ONE_PAYMENT_PER_SUPERSEDED_INDEX,
  ONE_REPORT_PER_AGENCY_MONTH_INDEX,
  REMITTANCE_PAYMENT_AMOUNT_SELECT,
  REMITTANCE_REPORT_SNAPSHOT_SELECT,
  RemittancePaymentModel,
  RemittanceReportModel,
} from './model';

// The remittance models (build step 2.11, docs/DATA_MODEL.md#collection-ownership; decisions 385,
// 391 and 395 in docs/BUILD_PLAN.md): a report per agency and month whose snapshot is encrypted
// and which changes only by the guard's five shapes; payments insert-only, one chain per report.
// Made-up figures and IDs only.

const day = (date: string) => new Date(`${date}T00:00:00+08:00`);

let year = 2400;
async function snapshot(rowsJson = '{"rowsVersion":1,"rows":[{"idNumber":"0498765432"}]}') {
  return {
    generatedAt: new Date(),
    generatedBy: null,
    sourceRuns: [
      {
        runId: new Types.ObjectId(),
        number: 'PAY-2026-0001',
        periodStart: day('2026-09-26'),
        periodEnd: day('2026-10-10'),
      },
    ],
    goLiveNote: null,
    employeeCount: 1,
    flagCounts: { differsFromSchedule: 0, missingId: 0, unverifiedId: 0 },
    employer: {
      registeredName: 'Made-up Inc.',
      businessAddress: 'Made-up City',
      tin: '000-000-000-000',
      rdoCode: '000',
      employerNumber: '[SSS employer number]',
      placeholder: true,
    },
    settingVersions: [{ key: 'talent.remittanceSettings', effectiveFrom: '2000-01-01' }],
    dueDate: day('2026-11-30'),
    formatId: 'sss.r3.assumed-2026-10',
    rows: await encryptSensitive(rowsJson),
    totals: await encryptSensitive('{"amountDueCentavos":718500}'),
  };
}

async function report(status: 'generated' | 'paid' = 'generated') {
  year += 1;
  return RemittanceReportModel.create({
    agency: 'sss',
    month: `${year}-10`,
    status,
    ...(await snapshot()),
  });
}

const resetFiles = { pdf: null, xlsx: null, upload: null };

beforeAll(async () => {
  await connectDb();
  await Promise.all([RemittanceReportModel.init(), RemittancePaymentModel.init()]);
});

describe('remittanceReports', () => {
  it('stores the rows and totals encrypted and the rest plain', async () => {
    const created = await report();
    const raw = await database().collection('remittanceReports').findOne({ _id: created._id });
    expect(raw).toMatchObject({ agency: 'sss', status: 'generated', version: 1, employeeCount: 1 });
    expect(raw?.files).toEqual(resetFiles);
    expect(isEncryptedValue(raw?.rows)).toBe(true);
    expect(isEncryptedValue(raw?.totals)).toBe(true);
    expect(JSON.stringify(raw)).not.toContain('0498765432');
    expect(JSON.stringify(raw)).not.toContain('718500');
    const lean = await RemittanceReportModel.findById(created._id).lean();
    expect(lean?.rows).toBeUndefined();
    const selected = await RemittanceReportModel.findById(created._id)
      .select(REMITTANCE_REPORT_SNAPSHOT_SELECT)
      .lean();
    expect(String(await decryptSensitive(selected?.rows))).toContain('0498765432');
  });

  it('refuses plain rows in the model and in the collection validator', async () => {
    await expect(
      RemittanceReportModel.create({
        agency: 'philhealth',
        month: '2399-10',
        ...(await snapshot()),
        rows: '{"rows":[]}',
      }),
    ).rejects.toThrow();
    await expect(
      database()
        .collection('remittanceReports')
        .insertOne({ agency: 'pagibig', month: '2399-10', rows: 'plain', totals: 'plain' }),
    ).rejects.toMatchObject({ code: 121 });
  });

  it('keeps one report per agency and month', async () => {
    const first = await report();
    await expect(
      RemittanceReportModel.create({ agency: 'sss', month: first.month, ...(await snapshot()) }),
    ).rejects.toMatchObject({ code: 11000 });
    const indexes = await database().collection('remittanceReports').indexes();
    expect(indexes.map((index) => index.name)).toContain(ONE_REPORT_PER_AGENCY_MONTH_INDEX);
  });

  it('lets a generated report be regenerated, its files set once, paid, corrected and voided', async () => {
    const created = await report();
    const id = created._id;
    // A regenerate: the whole snapshot, the files reset, the version raised.
    const regenerated = await RemittanceReportModel.updateOne(
      { _id: id, status: 'generated', version: 1 },
      { $set: { ...(await snapshot()), files: resetFiles }, $inc: { version: 1 } },
    );
    expect(regenerated.modifiedCount).toBe(1);
    // One export file for the current version, once.
    const fileId = new Types.ObjectId();
    expect(
      (
        await RemittanceReportModel.updateOne(
          { _id: id, version: 2, 'files.pdf': null },
          { $set: { 'files.pdf': fileId } },
        )
      ).modifiedCount,
    ).toBe(1);
    expect(
      (
        await RemittanceReportModel.updateOne(
          { _id: id, version: 2, 'files.pdf': null },
          { $set: { 'files.pdf': new Types.ObjectId() } },
        )
      ).modifiedCount,
    ).toBe(0);
    // Marked paid, corrected, voided.
    const paymentId = new Types.ObjectId();
    await RemittanceReportModel.updateOne(
      { _id: id, status: 'generated', version: 2 },
      { $set: { status: 'paid', paymentId } },
    );
    await RemittanceReportModel.updateOne(
      { _id: id, status: 'paid' },
      { $set: { paymentId: new Types.ObjectId() } },
    );
    await RemittanceReportModel.updateOne(
      { _id: id, status: 'paid' },
      { $set: { status: 'generated', paymentId: null } },
    );
    const stored = await RemittanceReportModel.findById(id).lean();
    expect(stored).toMatchObject({ status: 'generated', version: 2, paymentId: null });
    expect(stored?.files.pdf?.toHexString()).toBe(fileId.toHexString());
  });

  it('refuses every other write', async () => {
    const created = await report('paid');
    const id = created._id;
    const attempts: (() => Promise<unknown>)[] = [
      // A regenerate of a paid report, or one without the whole snapshot or the files reset.
      async () =>
        RemittanceReportModel.updateOne(
          { _id: id, status: 'paid' },
          { $set: { ...(await snapshot()), files: resetFiles }, $inc: { version: 1 } },
        ),
      async () =>
        RemittanceReportModel.updateOne(
          { _id: id, status: 'generated' },
          { $set: { employeeCount: 2 }, $inc: { version: 1 } },
        ),
      async () =>
        RemittanceReportModel.updateOne(
          { _id: id, status: 'generated' },
          { $set: await snapshot(), $inc: { version: 1 } },
        ),
      // A file without the null filter or the version, or two at once.
      () =>
        RemittanceReportModel.updateOne(
          { _id: id, version: 1 },
          { $set: { 'files.pdf': new Types.ObjectId() } },
        ),
      () =>
        RemittanceReportModel.updateOne(
          { _id: id, 'files.pdf': null },
          { $set: { 'files.pdf': new Types.ObjectId() } },
        ),
      () =>
        RemittanceReportModel.updateOne(
          { _id: id, version: 1, 'files.pdf': null },
          { $set: { 'files.pdf': new Types.ObjectId(), 'files.xlsx': new Types.ObjectId() } },
        ),
      // Marking paid without the version or from paid; a status of something else.
      () =>
        RemittanceReportModel.updateOne(
          { _id: id, status: 'generated' },
          { $set: { status: 'paid', paymentId: new Types.ObjectId() } },
        ),
      () =>
        RemittanceReportModel.updateOne(
          { _id: id, status: 'paid' },
          { $set: { status: 'archived' } },
        ),
      // A void that keeps the payment; a correction of a generated report.
      () =>
        RemittanceReportModel.updateOne(
          { _id: id, status: 'paid' },
          { $set: { status: 'generated', paymentId: new Types.ObjectId() } },
        ),
      () =>
        RemittanceReportModel.updateOne(
          { _id: id, status: 'generated' },
          { $set: { paymentId: new Types.ObjectId() } },
        ),
      // Anything else.
      () => RemittanceReportModel.updateOne({ _id: id }, { $set: { month: '2000-01' } }),
      () => RemittanceReportModel.updateMany({}, { $set: { status: 'generated' } }),
      () => RemittanceReportModel.deleteOne({ _id: id }),
      () => RemittanceReportModel.replaceOne({ _id: id }, {}),
      () =>
        RemittanceReportModel.updateOne(
          { _id: id, status: 'paid' },
          { $set: { paymentId: new Types.ObjectId() } },
          { upsert: true },
        ),
      async () => {
        const doc = await RemittanceReportModel.findById(id);
        if (!doc) throw new Error('Missing.');
        doc.employeeCount = 5;
        return doc.save();
      },
    ];
    for (const attempt of attempts) await expect(attempt()).rejects.toThrow();
    const stored = await RemittanceReportModel.findById(id).lean();
    expect(stored).toMatchObject({ status: 'paid', version: 1, employeeCount: 1 });
  });
});

describe('remittancePayments', () => {
  async function payment(reportId: Types.ObjectId, change: Record<string, unknown> = {}) {
    return {
      reportId,
      agency: 'sss' as const,
      month: '2026-10',
      reportVersion: 1,
      paidOn: day('2026-11-27'),
      referenceNumber: 'PRN 1234567890123',
      amountCentavos: await encryptSensitive(718500),
      note: null,
      ...change,
    };
  }

  it('stores the amount encrypted, the Fiscal placeholder, and the rest plain', async () => {
    const reportId = new Types.ObjectId();
    const created = await RemittancePaymentModel.create(await payment(reportId));
    const raw = await database().collection('remittancePayments').findOne({ _id: created._id });
    expect(raw).toMatchObject({
      referenceNumber: 'PRN 1234567890123',
      supersedesId: null,
      voided: false,
      reason: null,
      fiscalDisbursement: { status: 'notRecorded' },
    });
    expect(isEncryptedValue(raw?.amountCentavos)).toBe(true);
    expect(JSON.stringify(raw)).not.toContain('718500');
    const selected = await RemittancePaymentModel.findById(created._id)
      .select(REMITTANCE_PAYMENT_AMOUNT_SELECT)
      .lean();
    expect(await decryptSensitive(selected?.amountCentavos)).toBe(718500);
  });

  it('refuses a plain amount, and the validator does too', async () => {
    await expect(
      RemittancePaymentModel.create(
        await payment(new Types.ObjectId(), { amountCentavos: 718500 }),
      ),
    ).rejects.toThrow();
    await expect(
      database()
        .collection('remittancePayments')
        .insertOne({ reportId: new Types.ObjectId(), amountCentavos: 718500 }),
    ).rejects.toMatchObject({ code: 121 });
  });

  it('keeps one chain per report: one first entry, one entry per superseded entry', async () => {
    const reportId = new Types.ObjectId();
    const first = await RemittancePaymentModel.create(await payment(reportId));
    await expect(RemittancePaymentModel.create(await payment(reportId))).rejects.toMatchObject({
      code: 11000,
    });
    const correction = await RemittancePaymentModel.create(
      await payment(reportId, { supersedesId: first._id, reason: 'Wrong reference' }),
    );
    await expect(
      RemittancePaymentModel.create(
        await payment(reportId, { supersedesId: first._id, reason: 'Again' }),
      ),
    ).rejects.toMatchObject({ code: 11000 });
    const voided = await RemittancePaymentModel.create({
      ...(await payment(reportId, { supersedesId: correction._id, reason: 'Paid twice' })),
      amountCentavos: undefined,
      voided: true,
    });
    expect(voided.voided).toBe(true);
    const indexes = await database().collection('remittancePayments').indexes();
    expect(indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining([
        ONE_FIRST_PAYMENT_PER_REPORT_INDEX,
        ONE_PAYMENT_PER_SUPERSEDED_INDEX,
      ]),
    );
  });

  it('needs a reason and a superseded entry for a void, and an amount for a payment', async () => {
    const reportId = new Types.ObjectId();
    await expect(
      RemittancePaymentModel.create({
        ...(await payment(reportId)),
        amountCentavos: undefined,
        voided: true,
        reason: 'No chain',
      }),
    ).rejects.toThrow();
    await expect(
      RemittancePaymentModel.create({
        ...(await payment(reportId, { supersedesId: new Types.ObjectId() })),
        voided: true,
      }),
    ).rejects.toThrow();
    await expect(
      RemittancePaymentModel.create({ ...(await payment(reportId)), amountCentavos: undefined }),
    ).rejects.toThrow();
  });

  it('is insert-only', async () => {
    const created = await RemittancePaymentModel.create(await payment(new Types.ObjectId()));
    const id = created._id;
    const attempts: (() => Promise<unknown>)[] = [
      () => RemittancePaymentModel.updateOne({ _id: id }, { $set: { referenceNumber: 'X' } }),
      () => RemittancePaymentModel.updateMany({}, { $set: { voided: true } }),
      () => RemittancePaymentModel.deleteOne({ _id: id }),
      () => RemittancePaymentModel.findOneAndDelete({ _id: id }),
      () => RemittancePaymentModel.replaceOne({ _id: id }, {}),
      async () => {
        const doc = await RemittancePaymentModel.findById(id);
        if (!doc) throw new Error('Missing.');
        doc.note = 'Changed';
        return doc.save();
      },
    ];
    for (const attempt of attempts) await expect(attempt()).rejects.toThrow();
    expect((await RemittancePaymentModel.findById(id).lean())?.referenceNumber).toBe(
      'PRN 1234567890123',
    );
  });
});
