import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { connectDb, withTransaction } from '@pulse/db';
import { AccessDeniedError, formatDate } from '@pulse/core';
import type { CreateReimbursementInput } from '../../reimbursements/inputs';
import {
  ownReceiptClaimMessage,
  PETTY_CASH_VOUCHER_CLAIM_TYPE,
  RECEIPT_ALREADY_CLAIMED,
  REIMBURSEMENT_TYPE,
} from '../../reimbursements/views';
import { ReimbursementModel } from '../reimbursements/model';
import {
  addReimbursement,
  deleteReimbursement,
  updateReimbursement,
} from '../reimbursements/service';
import {
  database,
  type Department,
  department,
  type Person,
  person,
  pngFile,
  seedPayrollSettings,
} from '../testing/fixtures';
import { getOwnTimesheetView } from '../timesheets/service';
import { TimeEntryModel, TimesheetModel } from '../timesheets/model';
import { ReceiptClaimModel } from './model';
import { checkReceipt, claimReceipt, releaseReceiptClaim } from './service';

// The register tests (docs/TESTING.md#reimbursement-tests, "The register and the Done when" and
// "Check a receipt"; build step 2.5, decisions 241–245 in docs/BUILD_PLAN.md): a receipt is
// claimed once across employees and claim types, the refusal never names the other claimant,
// deleting or re-keying a line releases its claim, two saves at once leave exactly one, and the
// register's write guard. Made-up people, merchants and receipts only. "Today" is Monday
// 2026-09-14, 10:00 Manila, in the cut-off 2026-09-11 to 2026-09-25.

let NET: Department;
let alice: Person;
let bruno: Person;
let reader: Person;
let boss: Person;
let storageDir: string;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-14T10:00:00+08:00'));
});

afterEach(() => {
  vi.useRealTimers();
});

beforeAll(async () => {
  storageDir = await mkdtemp(path.join(tmpdir(), 'pulse-test-storage-'));
  process.env.FILE_STORAGE_DIR = storageDir;
  await connectDb();
  await TimesheetModel.init();
  await TimeEntryModel.init();
  await ReimbursementModel.init();
  await ReceiptClaimModel.init();
  await seedPayrollSettings();
  NET = await department('Network', 'NET');
  alice = await person('Alma', 'Cruz', NET, { dateHired: '2025-01-01' });
  bruno = await person('Bruno', 'Diaz', NET, { dateHired: '2025-01-01' });
  reader = await person('Rita', 'Lopez', NET, { talent: 'read' });
  boss = await person('Bea', 'Tan', NET);
});

afterAll(async () => {
  await rm(storageDir, { recursive: true, force: true });
});

let receiptCount = 0;
/** A receipt nobody has claimed yet: a made-up TIN and number. */
function freshReceipt(): { merchantTin: string; receiptNumber: string } {
  receiptCount += 1;
  return {
    merchantTin: `${String(100_000_000 + receiptCount).slice(0, 9)}`,
    receiptNumber: `OR-${String(receiptCount).padStart(6, '0')}`,
  };
}

async function timesheetOf(p: Person): Promise<string> {
  const view = await getOwnTimesheetView(p.actor);
  if (!view?.timesheet.id) throw new Error('No timesheet.');
  return view.timesheet.id;
}

async function add(
  p: Person,
  values: Partial<Omit<CreateReimbursementInput, 'timesheetId'>> = {},
): Promise<{ id: string; version: number }> {
  return addReimbursement(
    p.actor,
    {
      timesheetId: await timesheetOf(p),
      typeKey: 'meal',
      receiptDate: '2026-09-12',
      merchant: 'Made-up Diner',
      amountCentavos: 25_000,
      clientId: null,
      pickUp: null,
      dropOff: null,
      description: null,
      ...freshReceipt(),
      ...values,
    },
    pngFile('receipt.png'),
  );
}

const liveClaims = () => database().collection('receiptClaims').countDocuments({ deletedAt: null });

describe('the register and the Done when', () => {
  it('rejects another employee’s claim of the same receipt, typed differently, without naming anyone', async () => {
    const receipt = { merchantTin: '123456789', receiptNumber: 'or-000123' };
    await add(alice, receipt);
    const claims = await liveClaims();

    for (const typed of [
      { merchantTin: '123-456-789', receiptNumber: 'OR 123' },
      { merchantTin: '123-456-789-00000', receiptNumber: 'Or123' },
      { merchantTin: '123 456 789 000', receiptNumber: 'OR-0123' },
    ]) {
      const refused = add(bruno, typed);
      await expect(refused).rejects.toThrow(RECEIPT_ALREADY_CLAIMED);
      await refused.catch((error: Error) => {
        expect(error.message).not.toContain(alice.firstName);
        expect(error.message).not.toContain(alice.lastName);
        expect(error.message).not.toContain(alice.employeeNumber);
      });
    }
    expect(await liveClaims()).toBe(claims);
  });

  it('tells the employee when they already claimed the receipt themselves', async () => {
    const receipt = freshReceipt();
    await add(alice, { ...receipt, receiptDate: '2026-09-11' });
    await expect(add(alice, receipt)).rejects.toThrow(
      ownReceiptClaimMessage(formatDate('2026-09-11'), 'Meal'),
    );
  });

  it('treats different branches of one TIN as different receipts', async () => {
    const { receiptNumber } = freshReceipt();
    await add(alice, { merchantTin: '222-333-444-001', receiptNumber });
    // 12 digits with branch 001 is the 14-digit form with 00001.
    await expect(add(bruno, { merchantTin: '22233344400001', receiptNumber })).rejects.toThrow(
      RECEIPT_ALREADY_CLAIMED,
    );
    await expect(
      add(bruno, { merchantTin: '222-333-444-002', receiptNumber }),
    ).resolves.toBeTruthy();
  });

  it('frees the receipt when the line is deleted, so another employee can claim it', async () => {
    const receipt = freshReceipt();
    const line = await add(alice, receipt);
    await expect(add(bruno, receipt)).rejects.toThrow(RECEIPT_ALREADY_CLAIMED);
    await deleteReimbursement(alice.actor, { reimbursementId: line.id, version: line.version });
    const claimed = await add(bruno, receipt);
    expect(claimed.id).toBeTruthy();
    const released = await database()
      .collection('receiptClaims')
      .findOne({ claimId: new Types.ObjectId(line.id) });
    expect(released?.deletedAt).toBeInstanceOf(Date);
  });

  it('re-claims on an edit that changes the TIN or number, and keeps the claim otherwise', async () => {
    const first = freshReceipt();
    const line = await add(alice, first);
    const stored = await ReimbursementModel.findById(line.id).lean();
    const values = {
      typeKey: 'meal',
      receiptDate: '2026-09-12',
      merchant: 'Made-up Diner, renamed',
      amountCentavos: 26_000,
      clientId: null,
      pickUp: null,
      dropOff: null,
      description: null,
    };

    // Same TIN and number (typed differently): the claim is kept.
    const kept = await updateReimbursement(alice.actor, {
      reimbursementId: line.id,
      version: line.version,
      ...values,
      merchantTin: first.merchantTin,
      receiptNumber: first.receiptNumber.toLowerCase(),
    });
    const afterKeep = await ReimbursementModel.findById(line.id).lean();
    expect(afterKeep?.receiptClaimId.toHexString()).toBe(stored?.receiptClaimId.toHexString());

    // A new number: the old receipt is free again, the new one is claimed.
    const second = freshReceipt();
    await updateReimbursement(alice.actor, {
      reimbursementId: line.id,
      version: kept.version,
      ...values,
      ...second,
    });
    const afterChange = await ReimbursementModel.findById(line.id).lean();
    expect(afterChange?.receiptClaimId.toHexString()).not.toBe(
      stored?.receiptClaimId.toHexString(),
    );
    await expect(add(bruno, second)).rejects.toThrow(RECEIPT_ALREADY_CLAIMED);
    await expect(add(bruno, first)).resolves.toBeTruthy();
  });

  it('refuses an edit onto a receipt someone else claimed, and keeps the line’s own claim', async () => {
    const taken = freshReceipt();
    await add(bruno, taken);
    const own = freshReceipt();
    const line = await add(alice, own);
    await expect(
      updateReimbursement(alice.actor, {
        reimbursementId: line.id,
        version: line.version,
        typeKey: 'meal',
        receiptDate: '2026-09-12',
        merchant: 'Made-up Diner',
        amountCentavos: 25_000,
        clientId: null,
        pickUp: null,
        dropOff: null,
        description: null,
        ...taken,
      }),
    ).rejects.toThrow(RECEIPT_ALREADY_CLAIMED);
    // Still claimed by Alma: Bruno can't take it.
    await expect(add(bruno, own)).rejects.toThrow(RECEIPT_ALREADY_CLAIMED);
  });

  it('blocks a reimbursement with a voucher’s claim, and the other way round', async () => {
    const voucherReceipt = freshReceipt();
    const voucherId = new Types.ObjectId();
    await withTransaction((session) =>
      claimReceipt(
        {
          ...voucherReceipt,
          claimType: PETTY_CASH_VOUCHER_CLAIM_TYPE,
          claimId: voucherId,
          employeeId: null,
        },
        { session, actorId: null },
      ),
    );
    await expect(add(alice, voucherReceipt)).rejects.toThrow(RECEIPT_ALREADY_CLAIMED);

    const lineReceipt = freshReceipt();
    await add(alice, lineReceipt);
    await expect(
      withTransaction((session) =>
        claimReceipt(
          {
            ...lineReceipt,
            claimType: PETTY_CASH_VOUCHER_CLAIM_TYPE,
            claimId: new Types.ObjectId(),
            employeeId: null,
          },
          { session, actorId: null },
        ),
      ),
    ).rejects.toThrow(RECEIPT_ALREADY_CLAIMED);

    // Releasing the voucher's claim frees its receipt.
    const released = await withTransaction((session) =>
      releaseReceiptClaim(
        { claimType: PETTY_CASH_VOUCHER_CLAIM_TYPE, claimId: voucherId },
        { session, actorId: null },
      ),
    );
    expect(released).toBe(true);
    await expect(add(alice, voucherReceipt)).resolves.toBeTruthy();
  });

  it('saves exactly one of two claims of one receipt at once, by two employees, three times running', async () => {
    for (let run = 0; run < 3; run += 1) {
      const receipt = freshReceipt();
      const results = await Promise.allSettled([add(alice, receipt), add(bruno, receipt)]);
      const saved = results.filter((result) => result.status === 'fulfilled');
      const refused = results.filter((result) => result.status === 'rejected');
      expect(saved).toHaveLength(1);
      expect(refused).toHaveLength(1);
      const reason = (refused[0] as PromiseRejectedResult).reason as Error;
      expect(reason.message).toBe(RECEIPT_ALREADY_CLAIMED);
      const parts = { merchantTin: `${receipt.merchantTin}00000` };
      expect(
        await database()
          .collection('receiptClaims')
          .countDocuments({ ...parts, deletedAt: null }),
      ).toBe(1);
    }
  });

  it('runs only in the caller’s transaction', async () => {
    await expect(
      claimReceipt(
        {
          ...freshReceipt(),
          claimType: PETTY_CASH_VOUCHER_CLAIM_TYPE,
          claimId: new Types.ObjectId(),
          employeeId: null,
        },
        // @ts-expect-error a session is required
        { actorId: null },
      ),
    ).rejects.toThrow(/transaction/);
  });

  it('refuses any change to a claim but the release', async () => {
    const claim = await ReceiptClaimModel.findOne({ deletedAt: null }).lean();
    if (!claim) throw new Error('No claim.');
    await expect(
      ReceiptClaimModel.updateOne({ _id: claim._id }, { $set: { receiptKey: 'OR999999' } }),
    ).rejects.toThrow(/never changed/);
    await expect(
      ReceiptClaimModel.updateOne(
        { _id: claim._id },
        { $set: { deletedAt: new Date(), merchantTin: '99999999900000' } },
      ),
    ).rejects.toThrow(/never changed/);
    await expect(ReceiptClaimModel.deleteOne({ _id: claim._id })).rejects.toThrow(/never changed/);
    await expect(
      ReceiptClaimModel.updateMany({}, { $set: { deletedAt: new Date() } }),
    ).rejects.toThrow(/never changed/);
  });
});

describe('Check a receipt', () => {
  it('gives Talent Read the claimant, the receipt date, type, amount and timesheet link', async () => {
    const receipt = freshReceipt();
    await add(alice, { ...receipt, receiptDate: '2026-09-11', amountCentavos: 12_345 });
    const found = await checkReceipt(reader.actor, {
      merchantTin: receipt.merchantTin.replace(/(\d{3})(\d{3})(\d{3})/, '$1-$2-$3'),
      receiptNumber: receipt.receiptNumber.replace('-', ' '),
    });
    expect(found).toMatchObject({
      kind: 'reimbursement',
      claimant: {
        employeeId: alice.employeeId,
        name: 'Alma Cruz',
        employeeNumber: alice.employeeNumber,
      },
      receiptDate: '2026-09-11',
      typeKey: 'meal',
      typeName: 'Meal',
      amountCentavos: 12_345,
      timesheetHref: `/talent/timesheets/${alice.employeeId}?cutOff=2026-09-11`,
    });
  });

  it('answers null for a receipt nobody claimed, and shows a voucher as a voucher', async () => {
    expect(await checkReceipt(reader.actor, freshReceipt())).toBeNull();
    const receipt = freshReceipt();
    await withTransaction((session) =>
      claimReceipt(
        {
          ...receipt,
          claimType: PETTY_CASH_VOUCHER_CLAIM_TYPE,
          claimId: new Types.ObjectId(),
          employeeId: null,
        },
        { session, actorId: null },
      ),
    );
    expect(await checkReceipt(reader.actor, receipt)).toMatchObject({ kind: 'pettyCashVoucher' });
  });

  it('refuses anyone without Talent Read, the claimant and a supervisor included', async () => {
    const receipt = freshReceipt();
    await add(alice, receipt);
    for (const who of [alice, boss, bruno]) {
      await expect(checkReceipt(who.actor, receipt)).rejects.toThrow(AccessDeniedError);
    }
  });

  it('records the claim type of a reimbursement', async () => {
    const receipt = freshReceipt();
    const line = await add(alice, receipt);
    const claim = await database()
      .collection('receiptClaims')
      .findOne({ claimId: new Types.ObjectId(line.id), deletedAt: null });
    expect(claim).toMatchObject({
      claimType: REIMBURSEMENT_TYPE,
      employeeId: new Types.ObjectId(alice.employeeId),
      receiptKey: receipt.receiptNumber.replace('-', '').replace(/^OR0+/, 'OR'),
    });
  });
});
