import { describe, expect, it } from 'vitest';
import { Error as MongooseError, Types } from 'mongoose';
import type { EmploymentStatus } from '../../account';
import { SEPARATION_BEFORE_HIRE } from '../../user-accounts';
import { EmployeeModel } from './model';

// The separation date's shape on the employee schema (SECURITY.md#account-status,
// docs/TESTING.md#user-account-tests): required for a separated status, null for an active one,
// at 00:00 Manila, and not before the date hired. "Today or earlier" is the user service's rule.
// Validation only: nothing is written.

const HIRED = new Date('2025-03-03T00:00:00+08:00');

function employee(employmentStatus: EmploymentStatus, separationDate: Date | null) {
  return new EmployeeModel({
    employeeNumber: '2025-01',
    firstName: 'Sample',
    lastName: 'Person',
    departmentId: new Types.ObjectId(),
    positionId: new Types.ObjectId(),
    employmentStatus,
    dateHired: HIRED,
    separationDate,
  });
}

/** The separationDate message from validating, or null when it passes. */
async function separationError(
  status: EmploymentStatus,
  separationDate: Date | null,
): Promise<string | null> {
  try {
    await employee(status, separationDate).validate();
    return null;
  } catch (error) {
    if (!(error instanceof MongooseError.ValidationError)) throw error;
    return error.errors.separationDate?.message ?? null;
  }
}

describe('employees.separationDate', () => {
  it('defaults to null', () => {
    expect(new EmployeeModel({}).separationDate).toBeNull();
  });

  it.each<EmploymentStatus>(['Probationary', 'Regular', 'Contractual'])(
    'is null for %s',
    async (status) => {
      expect(await separationError(status, null)).toBeNull();
      expect(await separationError(status, new Date('2026-01-05T00:00:00+08:00'))).toBe(
        'Only a separated employee has a separation date.',
      );
    },
  );

  it.each<EmploymentStatus>(['Resigned', 'Retired', 'Terminated'])(
    'is required for %s',
    async (status) => {
      expect(await separationError(status, null)).toBe('Enter the separation date.');
      expect(await separationError(status, new Date('2026-01-05T00:00:00+08:00'))).toBeNull();
    },
  );

  it('is on or after the date hired', async () => {
    expect(await separationError('Resigned', HIRED)).toBeNull();
    expect(await separationError('Resigned', new Date('2025-03-02T00:00:00+08:00'))).toBe(
      SEPARATION_BEFORE_HIRE,
    );
  });

  it('is 00:00 Manila on its day', async () => {
    // 00:00 UTC is 08:00 in Manila.
    expect(await separationError('Retired', new Date('2026-01-05T00:00:00Z'))).toBe(
      'Enter the separation date as a calendar day.',
    );
  });
});
