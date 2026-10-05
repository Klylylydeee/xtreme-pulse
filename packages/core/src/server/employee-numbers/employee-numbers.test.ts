import { beforeAll, describe, expect, it } from 'vitest';
import { type ClientSession, Types } from 'mongoose';
import { connectDb, withTransaction } from '@pulse/db';
import { ActionError } from '../../actions';
import { formatEmployeeNumber, parseEmployeeNumber } from '../../employee-number';
import { EmployeeNumberCounterModel } from '../employee-number-counters/model';
import { EmployeeModel } from '../employees/model';
import {
  claimManualEmployeeNumber,
  EMPLOYEE_NUMBER_FORMAT_MESSAGE,
  EMPLOYEE_NUMBER_IN_USE_MESSAGE,
  issueEmployeeNumber,
} from './service';

// Employee numbers (docs/modules/core.md#employee-number-company-id,
// docs/TESTING.md#user-account-tests). Each test uses its own hire year, so the counters don't
// interfere. Made-up data only.

/** Inserts a made-up employee carrying `employeeNumber`, in `session`. */
async function insertEmployee(employeeNumber: string, session: ClientSession) {
  await EmployeeModel.create(
    [
      {
        employeeNumber,
        firstName: 'Made',
        lastName: 'Up',
        departmentId: new Types.ObjectId(),
        positionId: new Types.ObjectId(),
        employmentStatus: 'Regular',
        dateHired: new Date(`${employeeNumber.slice(0, 4)}-01-01T00:00:00+08:00`),
      },
    ],
    { session },
  );
}

/** Generates a number and creates the employee in one transaction, as the user service will. */
function hire(year: number): Promise<string> {
  return withTransaction(async (session) => {
    const { number } = await issueEmployeeNumber(year, session);
    await insertEmployee(number, session);
    return number;
  });
}

/** Claims an entered number and creates the employee in one transaction. */
function hireWithNumber(value: string, dateHiredYear: number): Promise<string> {
  return withTransaction(async (session) => {
    const { number } = await claimManualEmployeeNumber(value, dateHiredYear, session);
    await insertEmployee(number, session);
    return number;
  });
}

async function counterFor(year: number): Promise<number | null> {
  const counter = await EmployeeNumberCounterModel.findOne({ year }).lean();
  return counter?.lastSequence ?? null;
}

/** The ActionError `promise` rejects with. */
async function rejection(promise: Promise<unknown>): Promise<ActionError> {
  const error: unknown = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ActionError);
  return error as ActionError;
}

beforeAll(async () => {
  await connectDb();
  // Collections must exist before a transaction writes to them.
  await Promise.all([EmployeeNumberCounterModel.init(), EmployeeModel.init()]);
});

describe('helpers', () => {
  it('formats a year and sequence', () => {
    expect(formatEmployeeNumber(2027, 1)).toBe('2027-01');
    expect(formatEmployeeNumber(2027, 10)).toBe('2027-10');
    expect(formatEmployeeNumber(2027, 99)).toBe('2027-99');
  });

  it.each([
    [2027, 0],
    [2027, 100],
    [2027, 1.5],
    [2027, -1],
    [999, 1],
    [10000, 1],
    [2027.5, 1],
  ])('refuses to format %s, %s', (year, sequence) => {
    expect(() => formatEmployeeNumber(year, sequence)).toThrow(RangeError);
  });

  it('parses a number', () => {
    expect(parseEmployeeNumber('2027-01')).toEqual({ year: 2027, sequence: 1 });
    expect(parseEmployeeNumber('2027-99')).toEqual({ year: 2027, sequence: 99 });
    expect(parseEmployeeNumber(' 2027-42 ')).toEqual({ year: 2027, sequence: 42 });
  });

  it.each([
    '',
    '2027',
    '2027-1',
    '2027-00',
    '2027-100',
    '27-01',
    '2027/01',
    '2027-0a',
    'abcd-01',
    '0999-01',
    '2027-01x',
  ])('refuses to parse %j', (value) => {
    expect(parseEmployeeNumber(value)).toBeNull();
  });

  it('round-trips', () => {
    for (const sequence of [1, 9, 10, 55, 99]) {
      expect(parseEmployeeNumber(formatEmployeeNumber(2031, sequence))).toEqual({
        year: 2031,
        sequence,
      });
    }
  });
});

describe('generate', () => {
  it('starts each year at 01 and counts up', async () => {
    expect(await hire(2027)).toBe('2027-01');
    expect(await hire(2027)).toBe('2027-02');
    expect(await counterFor(2027)).toBe(2);
  });

  it('gives 30 concurrent creates unique numbers with no gaps', async () => {
    const numbers = await Promise.all(Array.from({ length: 30 }, () => hire(2028)));
    const expected = Array.from({ length: 30 }, (_, index) =>
      formatEmployeeNumber(2028, index + 1),
    );
    expect([...numbers].sort()).toEqual(expected);
    expect(await counterFor(2028)).toBe(30);
  });

  it('leaves no gap when the create aborts', async () => {
    expect(await hire(2029)).toBe('2029-01');
    await expect(
      withTransaction(async (session) => {
        const { number } = await issueEmployeeNumber(2029, session);
        expect(number).toBe('2029-02');
        throw new Error('Made-up failure after the number was taken.');
      }),
    ).rejects.toThrow('Made-up failure');
    expect(await counterFor(2029)).toBe(1);
    expect(await hire(2029)).toBe('2029-02');
  });

  it('refuses outside a transaction', async () => {
    const conn = await connectDb();
    const session = await conn.startSession();
    try {
      await expect(issueEmployeeNumber(2030, session)).rejects.toThrow(/withTransaction/);
      await expect(claimManualEmployeeNumber('2030-01', 2030, session)).rejects.toThrow(
        /withTransaction/,
      );
    } finally {
      await session.endSession();
    }
    expect(await counterFor(2030)).toBeNull();
  });
});

describe('enter existing', () => {
  it('raises the counter, so generation continues after it', async () => {
    expect(await hireWithNumber('2032-10', 2032)).toBe('2032-10');
    expect(await counterFor(2032)).toBe(10);
    expect(await hire(2032)).toBe('2032-11');
  });

  it('accepts a lower free number without lowering the counter, and never fills gaps', async () => {
    expect(await hireWithNumber('2033-20', 2033)).toBe('2033-20');
    expect(await hireWithNumber('2033-05', 2033)).toBe('2033-05');
    expect(await counterFor(2033)).toBe(20);
    expect(await hire(2033)).toBe('2033-21');
  });

  it('stores the canonical number when the entry has spaces around it', async () => {
    expect(await hireWithNumber(' 2034-07 ', 2034)).toBe('2034-07');
    expect(await EmployeeModel.exists({ employeeNumber: '2034-07' })).not.toBeNull();
  });

  it('after 2035-99, generating another 2035 number fails and writes nothing', async () => {
    expect(await hireWithNumber('2035-99', 2035)).toBe('2035-99');
    const employeesBefore = await EmployeeModel.countDocuments();

    const error = await rejection(
      withTransaction(async (session) => {
        // Written first, so the test shows the failure takes the whole create with it.
        await insertEmployee('2035-50', session);
        await issueEmployeeNumber(2035, session);
      }),
    );
    expect(error.message).toBe(
      "Employee numbers for 2035 have run out: 2035-99 has been issued. Enter the person's existing company ID if they have one.",
    );
    expect(error.field).toBe('employeeNumber');

    expect(await counterFor(2035)).toBe(99);
    expect(await EmployeeNumberCounterModel.countDocuments({ year: 2035 })).toBe(1);
    expect(await EmployeeModel.countDocuments()).toBe(employeesBefore);
    expect(await EmployeeModel.exists({ employeeNumber: '2035-50' })).toBeNull();
  });

  it('refuses a number already in use and leaves the counter alone', async () => {
    expect(await hire(2036)).toBe('2036-01');
    expect(await hire(2036)).toBe('2036-02');
    const error = await rejection(hireWithNumber('2036-01', 2036));
    expect(error.message).toBe(EMPLOYEE_NUMBER_IN_USE_MESSAGE);
    expect(error.field).toBe('employeeNumber');
    expect(await counterFor(2036)).toBe(2);
  });

  it('keeps a duplicate out at insert even if the check is skipped', async () => {
    expect(await hire(2037)).toBe('2037-01');
    await expect(
      withTransaction((session) => insertEmployee('2037-01', session)),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it.each(['2038-1', '2038-00', '2038-100', '38-01', '2038_01', '', 'not a number'])(
    'refuses the malformed number %j and writes nothing',
    async (value) => {
      const error = await rejection(hireWithNumber(value, 2038));
      expect(error.message).toBe(EMPLOYEE_NUMBER_FORMAT_MESSAGE);
      expect(error.field).toBe('employeeNumber');
      expect(await counterFor(2038)).toBeNull();
    },
  );

  it('refuses a number whose year isn’t the year of the date hired', async () => {
    const error = await rejection(hireWithNumber('2040-01', 2039));
    expect(error.message).toBe(
      'The employee number must start with 2039, the year of the date hired.',
    );
    expect(error.field).toBe('employeeNumber');
    expect(await counterFor(2039)).toBeNull();
    expect(await counterFor(2040)).toBeNull();
  });
});
