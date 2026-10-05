import type { ClientSession } from 'mongoose';
import { ActionError } from '../../actions';
import {
  EMPLOYEE_SEQUENCE_MAX,
  type EmployeeNumberParts,
  formatEmployeeNumber,
  parseEmployeeNumber,
} from '../../employee-number';
import { EmployeeNumberCounterModel } from '../employee-number-counters/model';
import { EmployeeModel } from '../employees/model';
import { isDuplicateKeyError } from '../seed/duplicate-key';

// Spec: docs/modules/core.md#employee-number-company-id — `YYYY-NN`, one counter per hire year.
//
// Both functions run inside the transaction that creates the employee, so the number commits or
// rolls back with it: an aborted create leaves no gap. Two creates taking a number at once
// conflict on the year's counter; MongoDB aborts one with a TransientTransactionError and
// `withTransaction` retries it. Counter writes aren't audit-logged; the employee's create entry
// carries the number.

/** The create form's field the errors below belong to. */
export const EMPLOYEE_NUMBER_FIELD = 'employeeNumber';

export const EMPLOYEE_NUMBER_FORMAT_MESSAGE =
  'Enter the employee number as YYYY-NN, for example 2027-01.';
export const EMPLOYEE_NUMBER_IN_USE_MESSAGE = 'This employee number is already in use.';

/** The full-year message, with that year (docs/modules/core.md#employee-number-company-id). */
export function employeeNumbersRunOutMessage(year: number): string {
  return (
    `Employee numbers for ${year} have run out: ${formatEmployeeNumber(year, EMPLOYEE_SEQUENCE_MAX)} ` +
    `has been issued. Enter the person's existing company ID if they have one.`
  );
}

export interface EmployeeNumber extends EmployeeNumberParts {
  /** The formatted number, for example `2027-01`. */
  number: string;
}

function assertInTransaction(session: ClientSession, name: string): void {
  if (typeof session?.inTransaction !== 'function' || !session.inTransaction()) {
    throw new Error(
      `${name} must run inside withTransaction, in the transaction that creates the employee.`,
    );
  }
}

/**
 * Issues the next employee number for `year` (the Manila year of the date hired), for example
 * `2027-01`. Call it inside `withTransaction`, in the transaction that inserts the employee, and
 * pass that session. It always takes the number after the counter and never fills gaps.
 *
 * Throws an {@link ActionError} on `employeeNumber` once the year's 99 numbers are used. That
 * failure writes nothing; the caller's transaction aborts with it.
 */
export async function issueEmployeeNumber(
  year: number,
  session: ClientSession,
): Promise<EmployeeNumber> {
  assertInTransaction(session, 'issueEmployeeNumber');
  // Checks the year before anything is written.
  formatEmployeeNumber(year, 1);

  // The filter only matches a counter below 99, so a full year's counter doesn't match and the
  // upsert's insert of a second counter for that year fails on the unique `year` index.
  let counter: { lastSequence: number } | null;
  try {
    counter = await EmployeeNumberCounterModel.findOneAndUpdate(
      { year, lastSequence: { $lt: EMPLOYEE_SEQUENCE_MAX } },
      { $inc: { lastSequence: 1 }, $setOnInsert: { createdBy: null, updatedBy: null } },
      { session, upsert: true, returnDocument: 'after' },
    ).lean();
  } catch (error) {
    // A conflict with a transaction creating the same counter is retried by `withTransaction`;
    // only a duplicate key that isn't transient means the year is full.
    if (isDuplicateKeyError(error, 'year') && !isTransient(error)) {
      throw new ActionError(employeeNumbersRunOutMessage(year), { field: EMPLOYEE_NUMBER_FIELD });
    }
    throw error;
  }
  if (!counter) throw new Error(`The ${year} employee number counter is missing.`);

  const sequence = counter.lastSequence;
  return { number: formatEmployeeNumber(year, sequence), year, sequence };
}

/**
 * Checks an entered company ID and claims it, inside the transaction that inserts the employee.
 * It must be `YYYY-NN`, carry `dateHiredYear` (the Manila year of the date hired) and be unused;
 * each failure is an {@link ActionError} on `employeeNumber`. The year's counter is raised to at
 * least its sequence (`$max`), so generation never issues it; a lower free number is accepted and
 * never lowers the counter.
 *
 * The unique `employeeNumber` index on employees is the final guard: two creates entering the
 * same number at once can both pass the check here, and the second insert fails with E11000.
 * Show that as {@link EMPLOYEE_NUMBER_IN_USE_MESSAGE} too.
 */
export async function claimManualEmployeeNumber(
  value: string,
  dateHiredYear: number,
  session: ClientSession,
): Promise<EmployeeNumber> {
  assertInTransaction(session, 'claimManualEmployeeNumber');
  const parts = parseEmployeeNumber(value);
  if (!parts) {
    throw new ActionError(EMPLOYEE_NUMBER_FORMAT_MESSAGE, { field: EMPLOYEE_NUMBER_FIELD });
  }
  const { year, sequence } = parts;
  if (year !== dateHiredYear) {
    throw new ActionError(
      `The employee number must start with ${dateHiredYear}, the year of the date hired.`,
      { field: EMPLOYEE_NUMBER_FIELD },
    );
  }
  const number = formatEmployeeNumber(year, sequence);

  const taken = await EmployeeModel.exists({ employeeNumber: number }).session(session);
  if (taken)
    throw new ActionError(EMPLOYEE_NUMBER_IN_USE_MESSAGE, { field: EMPLOYEE_NUMBER_FIELD });

  await EmployeeNumberCounterModel.updateOne(
    { year },
    { $max: { lastSequence: sequence }, $setOnInsert: { createdBy: null, updatedBy: null } },
    { session, upsert: true },
  );
  return { number, year, sequence };
}

function isTransient(error: unknown): boolean {
  const { hasErrorLabel } = error as { hasErrorLabel?: unknown };
  return (
    typeof hasErrorLabel === 'function' &&
    (hasErrorLabel as (label: string) => boolean).call(error, 'TransientTransactionError')
  );
}
