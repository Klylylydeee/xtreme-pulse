import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import type { Centavos } from '@pulse/core';
import { registerTalentApprovalTypes } from '../change-requests/service';
import { addCompensationEntry } from '../compensation/service';
import { registerTalentApprovalSigner, uploadESignature } from '../e-signatures/service';
import { setBankAccount } from '../employee-records/service';
import { PayrollRunEmployeeModel, PayrollRunModel } from '../payroll-runs/model';
import { createPayrollDraftRun } from '../payroll-runs/service';
import {
  decide,
  department,
  notifications,
  type Person,
  person,
  pngFile,
  seedPayrollSettings,
  setLeaveSettings,
} from '../testing/fixtures';
import { acknowledgeAllPayrollFlag } from './acknowledgements';
import { PAYSLIP_READY_EVENT } from './finalize';
import { PayrollFlagAcknowledgementModel, PayrollManualEntryModel } from './model';
import { getPayslip } from './payslip';
import { submitPayrollRun } from './submit';

// The approve hook's load (HANDOFF "2.10 notes", Risks: "The approve hook is heavy"): finalizing
// a run of 50 employees in the Board member's decision transaction (MongoDB's default transaction
// limit is 60 seconds) freezes 50 payslip snapshots (each bank account decrypted and re-encrypted,
// year-to-date summed over the year's finalized lines) and sends 50 notifications. The second run
// sums two lines per employee. Prints counts and durations only; made-up data only.

const EMPLOYEES = 50;
const pesos = (amount: number): Centavos => Math.round(amount * 100);

let hr: Person;
let ben: Person;
const people: Person[] = [];

function setNow(iso: string) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
}

beforeAll(async () => {
  await connectDb();
  await Promise.all([
    PayrollRunModel.init(),
    PayrollRunEmployeeModel.init(),
    PayrollManualEntryModel.init(),
    PayrollFlagAcknowledgementModel.init(),
  ]);
  await seedPayrollSettings();
  const NET = await department('Network', 'NET');
  const HRD = await department('Human Resource', 'HR');
  const BOD = await department('Board of Directors', 'BOD');
  hr = await person('Ana', 'Reyes', HRD, { talent: 'write' });
  ben = await person('Ben', 'Lim', BOD);
  await person('Carla', 'Go', BOD);
  await uploadESignature(ben.actor, pngFile());
  registerTalentApprovalSigner();
  registerTalentApprovalTypes();
  setNow('2026-10-19T10:00:00+08:00');
  await setLeaveSettings({ goLiveDate: '2026-09-26' });
  for (let index = 0; index < EMPLOYEES; index += 1) {
    const p = await person('Load', `Employee${index}`, NET, { dateHired: '2025-01-01' });
    const saved = await addCompensationEntry(hr.actor, {
      employeeId: p.employeeId,
      effectiveDate: '2025-01-01',
      basicSalaryCentavos: pesos(20000 + index * 100),
      rateType: 'monthly',
      minimumWageEarner: false,
      reason: 'Made-up test salary',
    });
    if (saved.status === 'belowMinimumWage') throw new Error('Salary not saved.');
    await setBankAccount(hr.actor, {
      employeeId: p.employeeId,
      version: 0,
      bank: index % 2 === 0 ? 'unionbank' : 'rcbc',
      accountNumber: `00012345${String(index).padStart(4, '0')}`,
      accountName: `${p.firstName} ${p.lastName}`,
    });
    people.push(p);
  }
  vi.useRealTimers();
}, 600_000);

afterAll(() => {
  vi.useRealTimers();
});

/** Computes, acknowledges, submits and approves the run starting on `periodStart`; returns ms. */
async function finalizeRun(
  periodStart: string,
  today: string,
): Promise<{ ms: number; id: string }> {
  setNow(today);
  const { id } = await createPayrollDraftRun(hr.actor, { periodStart });
  for (const flag of ['onboardingIncomplete', 'timesheetNotApproved'] as const) {
    await acknowledgeAllPayrollFlag(hr.actor, { runId: id, flag, reason: 'Load test' }).catch(
      () => undefined,
    );
  }
  const version = (await PayrollRunModel.findById(id).lean())?.version ?? 0;
  const { approvalRequestId } = await submitPayrollRun(hr.actor, { runId: id, version });
  const started = performance.now();
  await decide(ben.actor, approvalRequestId, 'approve');
  const ms = Math.round(performance.now() - started);
  vi.useRealTimers();
  return { ms, id };
}

describe('the approve hook with 50 employees', () => {
  it('finalizes two runs in turn well inside the transaction limit', async () => {
    const first = await finalizeRun('2026-09-26', '2026-10-19T10:00:00+08:00');
    const second = await finalizeRun('2026-10-11', '2026-10-27T10:00:00+08:00');
    // Counts and durations only.
    console.info(
      `Approve hook with ${EMPLOYEES} employees: first run ${first.ms} ms, second run ${second.ms} ms`,
    );
    for (const { id, ms } of [first, second]) {
      expect(ms).toBeLessThan(30_000);
      const run = await PayrollRunModel.findById(id).lean();
      expect(run?.status).toBe('finalized');
      expect(
        await PayrollRunEmployeeModel.countDocuments({
          runId: new Types.ObjectId(id),
          payslip: { $type: 'object' },
        }),
      ).toBe(EMPLOYEES);
    }
    expect(await notifications({ event: PAYSLIP_READY_EVENT })).toHaveLength(EMPLOYEES * 2);
    // The second payslip's year-to-date sums both runs.
    const [one, two] = await Promise.all([
      getPayslip({ runId: first.id, employeeId: people[0]?.employeeId ?? '' }),
      getPayslip({ runId: second.id, employeeId: people[0]?.employeeId ?? '' }),
    ]);
    expect(two?.yearToDate.grossCentavos).toBe(
      (one?.view.grossCentavos ?? 0) + (two?.view.grossCentavos ?? 0),
    );
  }, 600_000);
});
