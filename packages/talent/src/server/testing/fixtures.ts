import mongoose, { type Model, mongo, Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { EMPLOYMENT_STATUS, type EmploymentStatus, type ModuleAccess } from '@pulse/core';
import { departmentRolesFor, resolveModuleAccess } from '@pulse/core/server';
import type { TalentActor } from '../policy';

// Test data for the employee record tests (docs/TESTING.md#employee-record-tests). Made-up data
// only. Imported by `*.test.ts` files only, never by the services.
//
// Core's people (departments, positions, employees, users) are test fixtures here, so they are
// created through Core's registered Mongoose models by name: Talent's code never writes Core's
// collections, and these helpers never run outside the tests.

const PASSWORD_HASH = 'made-up-hash-that-must-never-leave';

function coreModel(name: 'Department' | 'Position' | 'Employee' | 'User'): Model<unknown> {
  return mongoose.model(name) as Model<unknown>;
}

export function database(): mongo.Db {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Not connected.');
  return db;
}

export interface Department {
  id: Types.ObjectId;
  code: string;
  positionId: Types.ObjectId;
}

export async function department(name: string, code: string): Promise<Department> {
  await connectDb();
  const created = (await coreModel('Department').create({ name, code })) as { _id: Types.ObjectId };
  const position = (await coreModel('Position').create({
    name: `${name} Specialist`,
    departmentId: created._id,
    timesheetType: 'overtime',
  })) as { _id: Types.ObjectId };
  return { id: created._id, code, positionId: position._id };
}

export interface Person {
  employeeId: string;
  userId: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  /** The signed-in user, as `loadSessionUser` would resolve them. */
  actor: TalentActor;
}

let counter = 0;

export async function person(
  firstName: string,
  lastName: string,
  dept: Department,
  {
    status = 'Regular',
    talent = 'none',
    admin = false,
    dateHired = '2024-01-01',
  }: {
    status?: EmploymentStatus;
    talent?: ModuleAccess['talent'];
    admin?: boolean;
    dateHired?: string;
  } = {},
): Promise<Person> {
  counter += 1;
  const employeeNumber = `2024-${String(counter).padStart(2, '0')}`;
  const employee = (await coreModel('Employee').create({
    employeeNumber,
    firstName,
    lastName,
    departmentId: dept.id,
    positionId: dept.positionId,
    employmentStatus: status,
    dateHired: new Date(`${dateHired}T00:00:00+08:00`),
    separationDate:
      EMPLOYMENT_STATUS[status] === 'active' ? null : new Date('2024-06-01T00:00:00+08:00'),
  })) as { _id: Types.ObjectId };
  const userId = new Types.ObjectId();
  const email = `talent${counter}@xtreme-works.com`;
  const moduleAccess = { talent };
  await coreModel('User').create({
    _id: userId,
    email,
    passwordHash: PASSWORD_HASH,
    employeeId: employee._id,
    isSystemAdministrator: admin,
    mustChangePassword: false,
    moduleAccess,
  });
  return {
    employeeId: employee._id.toHexString(),
    userId: userId.toHexString(),
    employeeNumber,
    firstName,
    lastName,
    actor: {
      id: userId.toHexString(),
      email,
      isSystemAdministrator: admin,
      roles: departmentRolesFor(dept.code),
      employee: { id: employee._id.toHexString() },
      moduleAccess: resolveModuleAccess({ isSystemAdministrator: admin, moduleAccess }),
    },
  };
}

/** Moves an employee to another department, as Core's user service would. */
export async function moveTo(employee: Person, dept: Department): Promise<void> {
  await coreModel('Employee').updateOne(
    { _id: new Types.ObjectId(employee.employeeId) },
    { $set: { departmentId: dept.id, positionId: dept.positionId } },
  );
}

/** Sets an account's stored Talent access, as Core's access service would. */
export async function setTalentAccess(
  employee: Person,
  talent: ModuleAccess['talent'],
): Promise<void> {
  await coreModel('User').updateOne(
    { _id: new Types.ObjectId(employee.userId) },
    { $set: { 'moduleAccess.talent': talent } },
  );
}

/** Every audit entry, as raw Extended JSON (what the database holds). */
export async function rawAuditJson(): Promise<string> {
  const entries = await database().collection('auditLogs').find({}).toArray();
  return mongo.BSON.EJSON.stringify(entries, { relaxed: false });
}

/**
 * `json` with ObjectIds, timestamps and calendar dates removed, so a search for 4 digits only
 * finds them in a value, never by chance in an id or a date.
 */
export function withoutIdsAndDates(json: string): string {
  return json
    .replace(/[a-f\d]{24}/gi, '<id>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?/g, '<time>')
    .replace(/\d{4}-\d{2}-\d{2}/g, '<date>')
    .replace(/"\$numberLong":\s*"\d+"/g, '"$numberLong":"<n>"')
    .replace(/\d{4}-\d{2}/g, '<number>');
}

/** The audit entries for one record type, oldest first. */
export async function auditEntries(recordType: string) {
  return database()
    .collection('auditLogs')
    .find({ 'record.type': recordType })
    .sort({ _id: 1 })
    .toArray();
}

export async function countAudit(): Promise<number> {
  return database().collection('auditLogs').countDocuments();
}
