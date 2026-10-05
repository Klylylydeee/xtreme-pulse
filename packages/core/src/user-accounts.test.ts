import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dateHiredRange,
  EMPLOYMENT_STATUS_OPTIONS,
  employmentStatusChangeSchema,
  SEPARATION_IN_FUTURE,
  TERMINATED_UNAVAILABLE,
  userCreateSchema,
  userUpdateSchema,
} from './user-accounts';

// The user sheet's rules (docs/modules/core.md#managing-user-accounts, SECURITY.md#account-status).
// Pure parsing: the user service's database checks are tested with the service. Made-up data.

const ID = '5f0c8a1b2c3d4e5f6a7b8c9d';

// 2026-10-05 at 10:00 in Manila.
const NOW = new Date('2026-10-05T10:00:00+08:00');

const valid = {
  email: ' Ana.Cruz@Xtreme-Works.com ',
  firstName: ' Ana ',
  middleName: '',
  lastName: 'Cruz',
  dateHired: '2026-10-01',
  departmentId: ID,
  positionId: ID,
  reportingTo: [ID],
  employeeNumberMode: 'generate',
  employmentStatus: 'Regular',
};

function messages(result: { success: boolean; error?: { issues: { message: string }[] } }) {
  return result.error?.issues.map((issue) => issue.message) ?? [];
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('dateHiredRange', () => {
  it('runs from 1990-01-01 to today + 365 days in Manila', () => {
    expect(dateHiredRange()).toEqual({ earliest: '1990-01-01', latest: '2027-10-05' });
    // 23:30 UTC on Oct 4 is already Oct 5 in Manila.
    vi.setSystemTime(new Date('2026-10-04T23:30:00Z'));
    expect(dateHiredRange().latest).toBe('2027-10-05');
  });
});

describe('userCreateSchema', () => {
  it('normalizes the email and names, and generates the number by default', () => {
    const parsed = userCreateSchema.parse(valid);
    expect(parsed).toMatchObject({
      email: 'ana.cruz@xtreme-works.com',
      firstName: 'Ana',
      middleName: null,
      employeeNumber: null,
      reportingTo: [ID],
    });
  });

  it('accepts an empty reportingTo', () => {
    expect(userCreateSchema.parse({ ...valid, reportingTo: undefined }).reportingTo).toEqual([]);
  });

  it('needs a YYYY-NN number when entering an existing one', () => {
    const existing = { ...valid, employeeNumberMode: 'existing' };
    expect(messages(userCreateSchema.safeParse(existing))).toEqual(['Enter the employee number.']);
    expect(messages(userCreateSchema.safeParse({ ...existing, employeeNumber: '2026-1' }))).toEqual(
      ['Enter the employee number as YYYY-NN, for example 2027-01.'],
    );
    expect(
      userCreateSchema.parse({ ...existing, employeeNumber: ' 2026-07 ' }).employeeNumber,
    ).toBe('2026-07');
  });

  it('allows only Probationary, Regular or Contractual for a new user', () => {
    for (const status of ['Probationary', 'Regular', 'Contractual']) {
      expect(userCreateSchema.safeParse({ ...valid, employmentStatus: status }).success).toBe(true);
    }
    for (const status of ['Resigned', 'Terminated', 'Retired']) {
      expect(userCreateSchema.safeParse({ ...valid, employmentStatus: status }).success).toBe(
        false,
      );
    }
  });

  it('keeps the date hired from 1990-01-01 to a year ahead', () => {
    for (const date of ['1990-01-01', '2027-10-05']) {
      expect(userCreateSchema.safeParse({ ...valid, dateHired: date }).success).toBe(true);
    }
    for (const date of ['1989-12-31', '2027-10-06']) {
      expect(messages(userCreateSchema.safeParse({ ...valid, dateHired: date }))).toEqual([
        'Enter a date from Jan 1, 1990 to Oct 5, 2027.',
      ]);
    }
    expect(userCreateSchema.safeParse({ ...valid, dateHired: '2026-02-30' }).success).toBe(false);
  });

  it('refuses an email that isn’t one, and ids that aren’t ids', () => {
    expect(userCreateSchema.safeParse({ ...valid, email: 'ana' }).success).toBe(false);
    expect(userCreateSchema.safeParse({ ...valid, departmentId: 'x' }).success).toBe(false);
    expect(userCreateSchema.safeParse({ ...valid, reportingTo: ['x'] }).success).toBe(false);
  });
});

describe('userUpdateSchema', () => {
  it('holds no employee number or employment status', () => {
    const parsed = userUpdateSchema.parse({
      ...valid,
      employeeNumber: '2026-01',
      employmentStatus: 'Resigned',
    });
    expect(parsed).not.toHaveProperty('employeeNumber');
    expect(parsed).not.toHaveProperty('employmentStatus');
  });
});

describe('employmentStatusChangeSchema', () => {
  it('refuses Terminated with its hint, shown disabled in the options', () => {
    expect(
      messages(
        employmentStatusChangeSchema.safeParse({
          employmentStatus: 'Terminated',
          separationDate: '2026-10-01',
        }),
      ),
    ).toEqual([TERMINATED_UNAVAILABLE]);
    expect(EMPLOYMENT_STATUS_OPTIONS.find((option) => option.value === 'Terminated')).toEqual({
      value: 'Terminated',
      disabled: true,
      hint: TERMINATED_UNAVAILABLE,
      needsSeparationDate: true,
    });
    expect(EMPLOYMENT_STATUS_OPTIONS.filter((option) => option.disabled)).toHaveLength(1);
  });

  it('needs a separation date today or earlier for Resigned and Retired', () => {
    for (const employmentStatus of ['Resigned', 'Retired']) {
      expect(messages(employmentStatusChangeSchema.safeParse({ employmentStatus }))).toEqual([
        'Enter the separation date.',
      ]);
      expect(
        employmentStatusChangeSchema.parse({ employmentStatus, separationDate: '2026-10-05' }),
      ).toEqual({ employmentStatus, separationDate: '2026-10-05' });
      expect(
        messages(
          employmentStatusChangeSchema.safeParse({
            employmentStatus,
            separationDate: '2026-10-06',
          }),
        ),
      ).toEqual([SEPARATION_IN_FUTURE]);
    }
  });

  it('clears the separation date for an active status (a reversal)', () => {
    expect(
      employmentStatusChangeSchema.parse({
        employmentStatus: 'Regular',
        separationDate: '2026-10-01',
      }),
    ).toEqual({ employmentStatus: 'Regular', separationDate: null });
  });
});
