import { crc32, deflateSync } from 'node:zlib';
import mongoose, { type Model, mongo, Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { EMPLOYMENT_STATUS, type EmploymentStatus, type ModuleAccess } from '@pulse/core';
import { type CurrentUser, departmentRolesFor, resolveModuleAccess } from '@pulse/core/server';
import type { TalentActor } from '../policy';

// Test data for the employee record tests (docs/TESTING.md#employee-record-tests). Made-up data
// only. Imported by `*.test.ts` files only, never by the services.
//
// Core's people (departments, positions, employees, users) are test fixtures here, so they are
// created through Core's registered Mongoose models by name: Talent's code never writes Core's
// collections, and these helpers never run outside the tests.

const PASSWORD_HASH = 'made-up-hash-that-must-never-leave';

function coreModel(
  name: 'Department' | 'Position' | 'Employee' | 'User' | 'Brand' | 'Client' | 'Holiday',
): Model<unknown> {
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

// ---------------------------------------------------------------------------------------------
// Step 2.2 helpers (docs/TESTING.md#document-e-signature-and-certification-tests).

/** The signed-in user as the file route sees them (a `CurrentUser`). */
export function currentUser(p: Person): CurrentUser {
  return {
    id: p.actor.id,
    email: p.actor.email,
    mustChangePassword: false,
    isSystemAdministrator: p.actor.isSystemAdministrator,
    isSystemAccount: false,
    employee: {
      id: p.employeeId,
      name: `${p.firstName} ${p.lastName}`,
      firstName: p.firstName,
      departmentCode: null,
    },
    roles: [...p.actor.roles],
    moduleAccess: p.actor.moduleAccess,
  };
}

/** The bootstrap system account (no employee), as the signed-in user. */
export async function systemAccount(): Promise<TalentActor & { isSystemAccount: true }> {
  // There is only one (a unique index): reuse it within a test file.
  const existing = (await coreModel('User').findOne({ isSystemAccount: true }).lean()) as {
    _id: Types.ObjectId;
    email: string;
  } | null;
  const userId = existing?._id ?? new Types.ObjectId();
  counter += 1;
  const email = existing?.email ?? `system${counter}@xtreme-works.com`;
  if (!existing)
    await coreModel('User').create({
      _id: userId,
      email,
      passwordHash: PASSWORD_HASH,
      employeeId: null,
      isSystemAdministrator: true,
      isSystemAccount: true,
      mustChangePassword: false,
    });
  return {
    id: userId.toHexString(),
    email,
    isSystemAdministrator: true,
    isSystemAccount: true,
    roles: [],
    employee: null,
    moduleAccess: resolveModuleAccess({ isSystemAdministrator: true, moduleAccess: {} }),
  };
}

/** Sets an employee's supervisors, as Core's reporting line service would. */
export async function setReportingTo(employee: Person, supervisors: Person[]): Promise<void> {
  await coreModel('Employee').updateOne(
    { _id: new Types.ObjectId(employee.employeeId) },
    { $set: { reportingTo: supervisors.map((s) => new Types.ObjectId(s.employeeId)) } },
  );
}

/** Separates an employee (Resigned), as Core's user service would. */
export async function separate(employee: Person): Promise<void> {
  await coreModel('Employee').updateOne(
    { _id: new Types.ObjectId(employee.employeeId) },
    {
      $set: {
        employmentStatus: 'Resigned',
        separationDate: new Date('2024-06-01T00:00:00+08:00'),
      },
    },
  );
}

/** A Core product (`brands`), as Core's brand service would create it. */
export async function brand(name: string): Promise<string> {
  const created = (await coreModel('Brand').create({ name })) as { _id: Types.ObjectId };
  return created._id.toHexString();
}

/** A tiny made-up PDF upload. */
export function pdfFile(name = 'document.pdf'): File {
  return new File([`%PDF-1.4\n% made-up test file ${name}\n%%EOF\n`], name, {
    type: 'application/pdf',
  });
}

/** A real 4 × 4 RGBA PNG, built here (with valid checksums) so sharp can read it. Made up. */
function pngBytes(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(4, 0);
  header.writeUInt32BE(4, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const rows = Buffer.concat(
    Array.from({ length: 4 }, () =>
      Buffer.from([0, ...Array.from({ length: 4 }, () => [20, 40, 160, 200]).flat()]),
    ),
  );
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A tiny made-up PNG image upload (a signature). */
export function pngFile(name = 'signature.png'): File {
  return new File([new Uint8Array(pngBytes())], name, { type: 'image/png' });
}

/** A stored notification, as the tests read it. */
export interface NotificationRow {
  recipientUserId: Types.ObjectId;
  module: string;
  event: string;
  title: string;
  body: string | null;
  href: string;
  dedupeKey: string | null;
}

/** Every notification, raw. */
export async function notifications(filter: Record<string, unknown> = {}) {
  return database()
    .collection<NotificationRow>('notifications')
    .find(filter)
    .sort({ _id: 1 })
    .toArray();
}

// ---------------------------------------------------------------------------------------------
// Step 2.3 helpers (docs/TESTING.md#payroll-settings-tests).

/** The id of a saved compensation entry; fails the test when it wasn't saved. */
export function savedId(
  result: { status: 'saved' | 'savedWithNote'; id: string } | { status: 'belowMinimumWage' },
): { id: string } {
  if (result.status === 'belowMinimumWage') throw new Error('The salary was not saved.');
  return { id: result.id };
}

/** Corrects an employee's date hired, as Core's user service would. */
export async function setDateHired(employee: Person, dateHired: string): Promise<void> {
  await coreModel('Employee').updateOne(
    { _id: new Types.ObjectId(employee.employeeId) },
    { $set: { dateHired: new Date(`${dateHired}T00:00:00+08:00`) } },
  );
}

/** Runs Pulse Talent's seed loaders (the payroll settings), as `pnpm seed:admin` would. */
export async function seedPayrollSettings(): Promise<void> {
  const { talentSeedLoaders } = await import('../seed');
  for (const loader of talentSeedLoaders) await loader.run();
}

// ---------------------------------------------------------------------------------------------
// Step 2.4 helpers (docs/TESTING.md#timesheet-and-work-schedule-tests).

/** Changes a department's position's timesheet type, as Core's position service would. */
export async function setPositionType(
  dept: Department,
  timesheetType: 'overtime' | 'standard',
): Promise<void> {
  await coreModel('Position').updateOne({ _id: dept.positionId }, { $set: { timesheetType } });
}

/** A Core client, as Core's client service would create it. */
export async function client(name: string): Promise<string> {
  const created = (await coreModel('Client').create({ name })) as { _id: Types.ObjectId };
  return created._id.toHexString();
}

/** Sets an employee's separation date (keeping the status), as Core's user service would. */
export async function setSeparationDate(
  employee: Person,
  separationDate: string | null,
): Promise<void> {
  await coreModel('Employee').updateOne(
    { _id: new Types.ObjectId(employee.employeeId) },
    {
      $set: {
        separationDate: separationDate ? new Date(`${separationDate}T00:00:00+08:00`) : null,
      },
    },
  );
}

// ---------------------------------------------------------------------------------------------
// Step 2.6 helpers (docs/TESTING.md#onboarding-and-change-request-tests).

/** Sets or clears an employee's profile photo, as Core's photo service would (a made-up file id). */
export async function setPhoto(employee: Person, present = true): Promise<void> {
  await coreModel('Employee').updateOne(
    { _id: new Types.ObjectId(employee.employeeId) },
    { $set: { photoFileId: present ? new Types.ObjectId() : null } },
  );
}

/** Marks an account as still having its temporary password, as Core's user service would. */
export async function setTemporaryPassword(employee: Person, temporary: boolean): Promise<void> {
  await coreModel('User').updateOne(
    { _id: new Types.ObjectId(employee.userId) },
    { $set: { mustChangePassword: temporary } },
  );
}

/** The person's actor as it is after a move to `dept` (the roles follow the department). */
export function actorIn(employee: Person, dept: Department): TalentActor {
  return { ...employee.actor, roles: departmentRolesFor(dept.code) };
}

/** Decides a Core approval request as `who`, with the version stored now. */
export async function decide(
  who: { id: string; email: string; isSystemAdministrator?: boolean },
  requestId: string,
  decision: 'approve' | 'return' | 'reject',
  remarks: string | null = null,
): Promise<void> {
  const { decideApproval } = await import('@pulse/core/server');
  const stored = await database()
    .collection('approvalRequests')
    .findOne({ _id: new Types.ObjectId(requestId) });
  await decideApproval(who, requestId, {
    decision,
    remarks,
    version: stored?.version as number,
  });
}

// ---------------------------------------------------------------------------------------------
// Step 2.7 helpers (docs/TESTING.md#timesheet-approval-dtr-and-offset-tests).

/**
 * A nationwide holiday on `date` (a Core `holidays` record, as Core's holiday service would write
 * it), confirmed unless `status` says draft. Returns its id. Made-up names only.
 */
export async function holiday(
  date: string,
  {
    status = 'confirmed',
    type = 'regular',
    name = 'Made-up Holiday',
  }: {
    status?: 'draft' | 'confirmed';
    type?: 'regular' | 'specialNonWorking' | 'specialWorking';
    name?: string;
  } = {},
): Promise<string> {
  const created = (await coreModel('Holiday').create({
    name,
    date: new Date(`${date}T00:00:00+08:00`),
    year: Number(date.slice(0, 4)),
    type,
    scope: 'nationwide',
    location: null,
    legalBasis: status === 'confirmed' ? 'Made-up Proclamation No. 1' : null,
    status,
    source: 'manual',
    sourceKey: null,
    declared: false,
    confirmedAt: status === 'confirmed' ? new Date() : null,
  })) as { _id: Types.ObjectId };
  return created._id.toHexString();
}

/** Confirms, drafts again, or soft-deletes a holiday, as Core's holiday service would. */
export async function setHoliday(
  id: string,
  change: { status?: 'draft' | 'confirmed'; deleted?: boolean },
): Promise<void> {
  const set: Record<string, unknown> = {};
  if (change.status) set.status = change.status;
  if (change.deleted) set.deletedAt = new Date();
  await database()
    .collection('holidays')
    .updateOne({ _id: new Types.ObjectId(id) }, { $set: set });
}

/** Sets a timesheet's status directly (a test shortcut past the approval flow). */
export async function setTimesheetStatus(timesheetId: string, status: string): Promise<void> {
  await database()
    .collection('timesheets')
    .updateOne({ _id: new Types.ObjectId(timesheetId) }, { $set: { status } });
}

/** A Core approval request, raw. */
export async function approvalRequest(requestId: string) {
  return database()
    .collection('approvalRequests')
    .findOne({ _id: new Types.ObjectId(requestId) });
}

// ---------------------------------------------------------------------------------------------
// Step 2.8 helpers (docs/TESTING.md#leave-and-time-off-tests).

/**
 * Sets an employee's regularization date (or clears it) on their Talent employee record, creating
 * the record when there is none, as the employee record service would.
 */
export async function setRegularizationDate(
  employee: Person,
  regularizationDate: string | null,
): Promise<void> {
  await database()
    .collection('employeeRecords')
    .updateOne(
      { employeeId: new Types.ObjectId(employee.employeeId) },
      {
        $set: {
          regularizationDate: regularizationDate
            ? new Date(`${regularizationDate}T00:00:00+08:00`)
            : null,
        },
        $setOnInsert: { workRegion: 'NCR', createdAt: new Date(), updatedAt: new Date() },
      },
      { upsert: true },
    );
}

/** Sets an employee's sex on their Talent employee record, as the employee record service would. */
export async function setSex(employee: Person, sex: 'female' | 'male' | null): Promise<void> {
  await database()
    .collection('employeeRecords')
    .updateOne(
      { employeeId: new Types.ObjectId(employee.employeeId) },
      {
        $set: { sex },
        $setOnInsert: { workRegion: 'NCR', createdAt: new Date(), updatedAt: new Date() },
      },
      { upsert: true },
    );
}

/** Changes an employee's employment status, as Core's user service would. */
export async function setEmploymentStatus(
  employee: Person,
  employmentStatus: EmploymentStatus,
): Promise<void> {
  await coreModel('Employee').updateOne(
    { _id: new Types.ObjectId(employee.employeeId) },
    { $set: { employmentStatus } },
  );
}

/**
 * Adds a `talent.leaveSettings` version from `effectiveFrom`: the seeded value with `change`
 * applied (for example the go-live date), as HR's "Add version" would. Returns its value.
 */
export async function setLeaveSettings(
  change: Partial<import('../../time-off/settings').LeaveSettings>,
  effectiveFrom = '2000-01-02',
): Promise<import('../../time-off/settings').LeaveSettings> {
  const { addConfigVersion } = await import('@pulse/core/server');
  const { SEED_LEAVE_SETTINGS } = await import('../../time-off/settings');
  const { LEAVE_SETTINGS_SETTING } = await import('../payroll-settings/settings');
  const value = { ...structuredClone(SEED_LEAVE_SETTINGS), ...change };
  await addConfigVersion(LEAVE_SETTINGS_SETTING, {
    effectiveFrom,
    value,
    source: 'Made-up test version',
    actorId: null,
  });
  return value;
}

/**
 * A time off request stored straight in `timeOffRequests` (a test shortcut past filing, for the
 * balance services' holdings), with the documented fields. Returns its id.
 */
export async function storedTimeOffRequest(
  employee: Person,
  fields: {
    kind: 'leave' | 'offset';
    status: 'pending' | 'returned' | 'approved' | 'rejected' | 'cancelled';
    startDate: string;
    endDate?: string;
    leaveTypeKey?: string | null;
    chargeableHalfDays?: number | null;
    paidHalfDays?: number | null;
    minutes?: number | null;
  },
): Promise<string> {
  const id = new Types.ObjectId();
  await database()
    .collection('timeOffRequests')
    .insertOne({
      _id: id,
      employeeId: new Types.ObjectId(employee.employeeId),
      kind: fields.kind,
      status: fields.status,
      leaveTypeKey: fields.leaveTypeKey ?? null,
      startDate: new Date(`${fields.startDate}T00:00:00+08:00`),
      endDate: new Date(`${fields.endDate ?? fields.startDate}T00:00:00+08:00`),
      chargeableHalfDays: fields.chargeableHalfDays ?? null,
      paidHalfDays: fields.paidHalfDays ?? null,
      minutes: fields.minutes ?? null,
    });
  return id.toHexString();
}

/**
 * A leave balance for a `credited` type, stored straight in `leaveEntries` as one `adjustment` of
 * `halfDays` dated `effectiveOn` (a test shortcut past the opening balances page).
 */
export async function leaveBalanceEntry(
  employee: Person,
  typeKey: string,
  halfDays: number,
  effectiveOn = '2026-01-01',
): Promise<void> {
  await database()
    .collection('leaveEntries')
    .insertOne({
      employeeId: new Types.ObjectId(employee.employeeId),
      typeKey,
      kind: 'adjustment',
      halfDays,
      effectiveOn: new Date(`${effectiveOn}T00:00:00+08:00`),
      year: null,
      sourceType: null,
      sourceId: null,
      reason: 'Made-up test balance',
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy: null,
      updatedBy: null,
    });
}

/** An offset balance, stored straight in `offsetEntries` as one `adjustment` of `minutes`. */
export async function offsetBalanceEntry(employee: Person, minutes: number): Promise<void> {
  await database()
    .collection('offsetEntries')
    .insertOne({
      employeeId: new Types.ObjectId(employee.employeeId),
      kind: 'adjustment',
      minutes,
      effectiveOn: new Date('2026-01-01T00:00:00+08:00'),
      timesheetId: null,
      sourceType: null,
      sourceId: null,
      reason: 'Made-up test balance',
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy: null,
      updatedBy: null,
    });
}
