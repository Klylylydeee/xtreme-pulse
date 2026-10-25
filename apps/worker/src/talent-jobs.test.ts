import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEDULE_TIME_ZONE } from '@pulse/core/server';
import type { JobContext } from '@pulse/core/server/worker';
import {
  EXPIRY_ALERTS_JOB,
  LEAVE_CREDITS_JOB,
  OPEN_TIMESHEETS_JOB,
  PAYROLL_DRAFTS_JOB,
  PAYSLIP_PDFS_JOB,
  registerTalentHolidaysChangedListener,
  REMITTANCE_REMINDERS_JOB,
  runExpiryAlerts,
  runLeaveCredits,
  runOpenTimesheets,
  runPayrollDrafts,
  runPayslipPdfs,
  runRemittanceReminders,
  runTimesheetReminders,
  TIMESHEET_REMINDERS_JOB,
} from '@pulse/talent/server';
import { jobHandlers, jobSchedules } from './jobs';
import { registerTalentListeners, talentJobHandlers, talentJobSchedules } from './talent-jobs';

// The worker's Talent job wiring (docs/ARCHITECTURE.md#background-jobs): the expiry alert job
// (build step 2.2), the timesheet opening job (build step 2.4), the timesheet reminders (build
// step 2.7), the leave credits (build step 2.8), the draft payroll runs (build step 2.9) and the
// payslip PDFs (build step 2.10) and the remittance reminders (build step 2.11) each have one
// handler and one schedule on Manila time (`0 8 * * *`, `5 0 * * *`, `0 8 * * *`, `30 0 * * *`,
// `0 5 * * *`, `*/10 * * * *` and `0 8 * * *`), and each
// handler calls Talent's service. The worker also registers the
// `talent.recomputeDtr` holidays-changed listener at start-up (build step 2.7). The services and
// the listener themselves are tested in packages/talent; here they are stubs.

vi.mock('@pulse/talent/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pulse/talent/server')>();
  return {
    ...actual,
    runExpiryAlerts: vi.fn(async () => ({ stub: 'expiryAlerts' })),
    runOpenTimesheets: vi.fn(async () => ({ stub: 'openTimesheets' })),
    runTimesheetReminders: vi.fn(async () => ({ stub: 'timesheetReminders' })),
    runLeaveCredits: vi.fn(async () => ({ stub: 'leaveCredits' })),
    runPayrollDrafts: vi.fn(async () => ({ stub: 'payrollDrafts' })),
    runPayslipPdfs: vi.fn(async () => ({ stub: 'payslipPdfs' })),
    runRemittanceReminders: vi.fn(async () => ({ stub: 'remittanceReminders' })),
    registerTalentHolidaysChangedListener: vi.fn(),
  };
});

const context: JobContext = { jobId: 'test-1', attempt: 1, attempts: 5 };

beforeEach(() => {
  vi.mocked(runExpiryAlerts).mockClear();
  vi.mocked(runOpenTimesheets).mockClear();
  vi.mocked(runTimesheetReminders).mockClear();
  vi.mocked(runLeaveCredits).mockClear();
  vi.mocked(runPayrollDrafts).mockClear();
  vi.mocked(runPayslipPdfs).mockClear();
  vi.mocked(runRemittanceReminders).mockClear();
  vi.mocked(registerTalentHolidaysChangedListener).mockClear();
});

describe('Talent job registration', () => {
  it('registers the expiry alert handler and schedule in production and development', () => {
    for (const production of [true, false]) {
      const names = jobHandlers({ production }).map((handler) => handler.job.name);
      expect(names.filter((name) => name === 'talent.expiryAlerts')).toHaveLength(1);
      const ids = jobSchedules({ production }).map((schedule) => schedule.id);
      expect(ids).toContain('talent.expiryAlerts');
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('runs daily at 8:00 AM Manila', () => {
    expect(SCHEDULE_TIME_ZONE).toBe('Asia/Manila');
    const schedule = talentJobSchedules.find((s) => s.id === 'talent.expiryAlerts');
    expect(schedule?.job).toBe(EXPIRY_ALERTS_JOB);
    expect(schedule?.pattern).toBe('0 8 * * *');
    expect(schedule?.data).toEqual({});
  });

  it('runs the expiry alerts', async () => {
    const handler = talentJobHandlers.find((h) => h.job.name === 'talent.expiryAlerts');
    await expect(handler?.run({}, context)).resolves.toEqual({ stub: 'expiryAlerts' });
    expect(runExpiryAlerts).toHaveBeenCalledTimes(1);
    expect(runExpiryAlerts).toHaveBeenCalledWith();
  });
});

describe('Timesheet opening job registration (build step 2.4)', () => {
  it('registers the handler and schedule once, in production and development', () => {
    for (const production of [true, false]) {
      const names = jobHandlers({ production }).map((handler) => handler.job.name);
      expect(names.filter((name) => name === 'talent.openTimesheets')).toHaveLength(1);
      const ids = jobSchedules({ production }).map((schedule) => schedule.id);
      expect(ids.filter((id) => id === 'talent.openTimesheets')).toHaveLength(1);
    }
  });

  it('runs daily at 00:05 Manila', () => {
    expect(SCHEDULE_TIME_ZONE).toBe('Asia/Manila');
    const schedule = talentJobSchedules.find((s) => s.id === 'talent.openTimesheets');
    expect(schedule?.job).toBe(OPEN_TIMESHEETS_JOB);
    expect(schedule?.pattern).toBe('5 0 * * *');
    expect(schedule?.data).toEqual({});
  });

  it('opens the timesheets through Talent’s service', async () => {
    const handler = talentJobHandlers.find((h) => h.job.name === 'talent.openTimesheets');
    await expect(handler?.run({}, context)).resolves.toEqual({ stub: 'openTimesheets' });
    expect(runOpenTimesheets).toHaveBeenCalledTimes(1);
    expect(runOpenTimesheets).toHaveBeenCalledWith();
    expect(runExpiryAlerts).not.toHaveBeenCalled();
  });
});

describe('Timesheet reminder job registration (build step 2.7)', () => {
  it('registers the handler and schedule once, in production and development', () => {
    for (const production of [true, false]) {
      const names = jobHandlers({ production }).map((handler) => handler.job.name);
      expect(names.filter((name) => name === 'talent.timesheetReminders')).toHaveLength(1);
      const ids = jobSchedules({ production }).map((schedule) => schedule.id);
      expect(ids.filter((id) => id === 'talent.timesheetReminders')).toHaveLength(1);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('runs daily at 8:00 AM Manila', () => {
    expect(SCHEDULE_TIME_ZONE).toBe('Asia/Manila');
    const schedule = talentJobSchedules.find((s) => s.id === 'talent.timesheetReminders');
    expect(schedule?.job).toBe(TIMESHEET_REMINDERS_JOB);
    expect(schedule?.pattern).toBe('0 8 * * *');
    expect(schedule?.data).toEqual({});
  });

  it('sends the reminders through Talent’s service', async () => {
    const handler = talentJobHandlers.find((h) => h.job.name === 'talent.timesheetReminders');
    await expect(handler?.run({}, context)).resolves.toEqual({ stub: 'timesheetReminders' });
    expect(runTimesheetReminders).toHaveBeenCalledTimes(1);
    expect(runTimesheetReminders).toHaveBeenCalledWith();
    expect(runExpiryAlerts).not.toHaveBeenCalled();
    expect(runOpenTimesheets).not.toHaveBeenCalled();
  });
});

describe('Leave credits job registration (build step 2.8)', () => {
  it('registers the handler and schedule once, in production and development', () => {
    for (const production of [true, false]) {
      const names = jobHandlers({ production }).map((handler) => handler.job.name);
      expect(names.filter((name) => name === 'talent.leaveCredits')).toHaveLength(1);
      const ids = jobSchedules({ production }).map((schedule) => schedule.id);
      expect(ids.filter((id) => id === 'talent.leaveCredits')).toHaveLength(1);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('runs daily at 00:30 Manila', () => {
    expect(SCHEDULE_TIME_ZONE).toBe('Asia/Manila');
    const schedule = talentJobSchedules.find((s) => s.id === 'talent.leaveCredits');
    expect(schedule?.job).toBe(LEAVE_CREDITS_JOB);
    expect(schedule?.pattern).toBe('30 0 * * *');
    expect(schedule?.data).toEqual({});
  });

  it('writes the credits through Talent’s service', async () => {
    const handler = talentJobHandlers.find((h) => h.job.name === 'talent.leaveCredits');
    await expect(handler?.run({}, context)).resolves.toEqual({ stub: 'leaveCredits' });
    expect(runLeaveCredits).toHaveBeenCalledTimes(1);
    expect(runLeaveCredits).toHaveBeenCalledWith();
    expect(runExpiryAlerts).not.toHaveBeenCalled();
    expect(runOpenTimesheets).not.toHaveBeenCalled();
    expect(runTimesheetReminders).not.toHaveBeenCalled();
  });
});

describe('Draft payroll runs job registration (build step 2.9)', () => {
  it('registers the handler and schedule once, in production and development', () => {
    for (const production of [true, false]) {
      const names = jobHandlers({ production }).map((handler) => handler.job.name);
      expect(names.filter((name) => name === 'talent.payrollDraftRuns')).toHaveLength(1);
      const ids = jobSchedules({ production }).map((schedule) => schedule.id);
      expect(ids.filter((id) => id === 'talent.payrollDraftRuns')).toHaveLength(1);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('runs daily at 05:00 Manila', () => {
    expect(SCHEDULE_TIME_ZONE).toBe('Asia/Manila');
    const schedule = talentJobSchedules.find((s) => s.id === 'talent.payrollDraftRuns');
    expect(schedule?.job).toBe(PAYROLL_DRAFTS_JOB);
    expect(schedule?.pattern).toBe('0 5 * * *');
    expect(schedule?.data).toEqual({});
  });

  it('creates and recomputes the drafts through Talent’s service', async () => {
    const handler = talentJobHandlers.find((h) => h.job.name === 'talent.payrollDraftRuns');
    await expect(handler?.run({}, context)).resolves.toEqual({ stub: 'payrollDrafts' });
    expect(runPayrollDrafts).toHaveBeenCalledTimes(1);
    expect(runPayrollDrafts).toHaveBeenCalledWith();
    expect(runExpiryAlerts).not.toHaveBeenCalled();
    expect(runOpenTimesheets).not.toHaveBeenCalled();
    expect(runTimesheetReminders).not.toHaveBeenCalled();
    expect(runLeaveCredits).not.toHaveBeenCalled();
  });
});

describe('Payslip PDFs job registration (build step 2.10)', () => {
  it('registers the handler and schedule once, in production and development', () => {
    for (const production of [true, false]) {
      const names = jobHandlers({ production }).map((handler) => handler.job.name);
      expect(names.filter((name) => name === 'talent.payslipPdfs')).toHaveLength(1);
      const ids = jobSchedules({ production }).map((schedule) => schedule.id);
      expect(ids.filter((id) => id === 'talent.payslipPdfs')).toHaveLength(1);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('runs every 10 minutes, on Manila time', () => {
    expect(SCHEDULE_TIME_ZONE).toBe('Asia/Manila');
    const schedule = talentJobSchedules.find((s) => s.id === 'talent.payslipPdfs');
    expect(schedule?.job).toBe(PAYSLIP_PDFS_JOB);
    expect(schedule?.pattern).toBe('*/10 * * * *');
    expect(schedule?.data).toEqual({});
  });

  it('renders the payslips through Talent’s service', async () => {
    const handler = talentJobHandlers.find((h) => h.job.name === 'talent.payslipPdfs');
    await expect(handler?.run({}, context)).resolves.toEqual({ stub: 'payslipPdfs' });
    expect(runPayslipPdfs).toHaveBeenCalledTimes(1);
    expect(runPayslipPdfs).toHaveBeenCalledWith();
    expect(runPayrollDrafts).not.toHaveBeenCalled();
    expect(runExpiryAlerts).not.toHaveBeenCalled();
    expect(runOpenTimesheets).not.toHaveBeenCalled();
    expect(runTimesheetReminders).not.toHaveBeenCalled();
    expect(runLeaveCredits).not.toHaveBeenCalled();
  });

  it('lets a failed render throw, so BullMQ retries the job', async () => {
    vi.mocked(runPayslipPdfs).mockRejectedValueOnce(
      new Error('1 payslip PDF(s) failed to render (0 rendered, 0 run(s) cleared).'),
    );
    const handler = talentJobHandlers.find((h) => h.job.name === 'talent.payslipPdfs');
    await expect(handler?.run({}, context)).rejects.toThrow(/failed to render/);
  });
});

describe('Remittance reminders job registration (build step 2.11)', () => {
  it('registers the handler and schedule once, in production and development', () => {
    for (const production of [true, false]) {
      const names = jobHandlers({ production }).map((handler) => handler.job.name);
      expect(names.filter((name) => name === 'talent.remittanceReminders')).toHaveLength(1);
      const ids = jobSchedules({ production }).map((schedule) => schedule.id);
      expect(ids.filter((id) => id === 'talent.remittanceReminders')).toHaveLength(1);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('runs daily at 8:00 AM Manila', () => {
    expect(SCHEDULE_TIME_ZONE).toBe('Asia/Manila');
    const schedule = talentJobSchedules.find((s) => s.id === 'talent.remittanceReminders');
    expect(schedule?.job).toBe(REMITTANCE_REMINDERS_JOB);
    expect(schedule?.pattern).toBe('0 8 * * *');
    expect(schedule?.data).toEqual({});
  });

  it('sends the reminders through Talent’s service', async () => {
    const handler = talentJobHandlers.find((h) => h.job.name === 'talent.remittanceReminders');
    await expect(handler?.run({}, context)).resolves.toEqual({ stub: 'remittanceReminders' });
    expect(runRemittanceReminders).toHaveBeenCalledTimes(1);
    expect(runRemittanceReminders).toHaveBeenCalledWith();
    expect(runTimesheetReminders).not.toHaveBeenCalled();
    expect(runPayslipPdfs).not.toHaveBeenCalled();
  });
});

describe('The holidays-changed listener at start-up (build step 2.7)', () => {
  it('registers talent.recomputeDtr through Talent', () => {
    registerTalentListeners();
    expect(registerTalentHolidaysChangedListener).toHaveBeenCalledTimes(1);
    expect(registerTalentHolidaysChangedListener).toHaveBeenCalledWith();
  });

  it('is not registered as a job or a schedule: Core’s core.holidaysChanged handler runs it', () => {
    for (const production of [true, false]) {
      const names = jobHandlers({ production }).map((handler) => handler.job.name);
      expect(names).not.toContain('talent.recomputeDtr');
      expect(names.filter((name) => name === 'core.holidaysChanged')).toHaveLength(1);
    }
  });
});
