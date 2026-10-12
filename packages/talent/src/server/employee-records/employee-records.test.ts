import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mongo, Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { AccessDeniedError, ActionError, lastFourOf } from '@pulse/core';
import { HIDDEN_SENSITIVE, HIDDEN_SENSITIVE_CHANGED } from '@pulse/core/server';
import { RECORD_CHANGED_ELSEWHERE, RESTRICTED_SECTIONS_NOTICE } from '../../validation';
import { EMPLOYEE_RECORD_TYPE, type EmployeeRecordView } from '../../views';
import { addCompensationEntry } from '../compensation/service';
import { CompensationEntryModel } from '../compensation/model';
import {
  auditEntries,
  countAudit,
  database,
  type Department,
  department,
  moveTo,
  type Person,
  person,
  rawAuditJson,
  setTalentAccess,
  withoutIdsAndDates,
} from '../testing/fixtures';
import { EmployeeRecordModel } from './model';
import {
  getEmployeeRecordView,
  getOwnRecordView,
  listEmployeeRecords,
  setBankAccount,
  setGovernmentIds,
  updateEmployment,
  updatePersonal,
} from './service';

// The employee record, its sections and edits (docs/modules/talent.md#the-employee-record-build-step-21,
// SECURITY.md#sensitive-data, docs/TESTING.md#employee-record-tests). Made-up data only: these are
// not real IDs or account numbers.

const IDS = {
  tin: '900123456781',
  sss: '0498765432',
  philhealth: '120987654329',
  pagibig: '121234567893',
};
const ACCOUNT_NUMBER = '0009876543217';
const SALARY_CENTAVOS = 4876543;
const PLAINTEXTS = [...Object.values(IDS), ACCOUNT_NUMBER, String(SALARY_CENTAVOS), '48765'];
const LAST_FOURS = [...Object.values(IDS), ACCOUNT_NUMBER].map((value) => lastFourOf(value));

let NET: Department;
let HRD: Department;
let ACCT: Department;
let BOD: Department;

let admin: Person;
let hr: Person;
let accounting: Person;
let board: Person;
let writer: Person;
let owner: Person;
let reader: Person;

beforeAll(async () => {
  await connectDb();
  await Promise.all([EmployeeRecordModel.init(), CompensationEntryModel.init()]);
  NET = await department('Network', 'NET');
  HRD = await department('Human Resource', 'HR');
  ACCT = await department('Accounting', 'ACCT');
  BOD = await department('Board of Directors', 'BOD');
  admin = await person('Ada', 'Admin', NET, { admin: true });
  hr = await person('Hana', 'Reyes', HRD, { talent: 'write' });
  accounting = await person('Abel', 'Santos', ACCT, { talent: 'write' });
  board = await person('Bert', 'Lim', BOD, { talent: 'write' });
  writer = await person('Wena', 'Cruz', NET, { talent: 'write' });
  owner = await person('Oscar', 'Tan', NET, { talent: 'owner' });
  reader = await person('Rita', 'Uy', NET, { talent: 'read' });
});

afterEach(async () => {
  await database().command({ collMod: 'auditLogs', validator: {} });
});

/** A record with every section filled in by the System Administrator. */
async function filledRecord(dept: Department = NET, name = 'Ellen'): Promise<Person> {
  const subject = await person(name, 'Garcia', dept);
  let { version } = await updatePersonal(admin.actor, {
    employeeId: subject.employeeId,
    version: 0,
    dateOfBirth: '1990-05-17',
    sex: 'female',
    civilStatus: 'married',
    nationality: 'Filipino',
    presentAddress: '1 Sample Street, Pasig',
    permanentAddress: null,
    mobileNumber: '09171234567',
    personalEmail: 'ellen@example.com',
    emergencyContactName: 'Ed Garcia',
    emergencyContactRelationship: 'Spouse',
    emergencyContactMobile: '09181234567',
  });
  ({ version } = await setGovernmentIds(admin.actor, {
    employeeId: subject.employeeId,
    version,
    ...IDS,
    rdoCode: '043',
  }));
  await setBankAccount(admin.actor, {
    employeeId: subject.employeeId,
    version,
    bank: 'unionbank',
    accountNumber: ACCOUNT_NUMBER,
    accountName: 'Ellen Garcia',
  });
  await addCompensationEntry(admin.actor, {
    employeeId: subject.employeeId,
    effectiveDate: '2024-01-01',
    basicSalaryCentavos: SALARY_CENTAVOS,
    rateType: 'monthly',
    minimumWageEarner: false,
    reason: 'Starting salary',
  });
  return subject;
}

async function versionOf(subject: Person): Promise<number> {
  const record = await EmployeeRecordModel.findOne({
    employeeId: new Types.ObjectId(subject.employeeId),
  }).lean();
  return record?.version ?? 0;
}

/** The stored bytes of an encrypted value, to compare. */
function bytes(value: unknown): string {
  if (value instanceof mongo.Binary) return Buffer.from(value.value()).toString('hex');
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
  throw new Error('Not a stored value.');
}

function personalInput(subject: Person, version: number) {
  return {
    employeeId: subject.employeeId,
    version,
    sex: 'male' as const,
    nationality: 'Filipino',
    presentAddress: null,
    permanentAddress: null,
    mobileNumber: null,
    personalEmail: null,
    emergencyContactName: null,
    emergencyContactRelationship: null,
    emergencyContactMobile: null,
  };
}

function expectNoSensitive(view: EmployeeRecordView | null) {
  expect(view).not.toBeNull();
  if (!view) return;
  expect(Object.keys(view)).not.toContain('compensation');
  expect(Object.keys(view)).not.toContain('governmentIds');
  expect(Object.keys(view)).not.toContain('bankAccount');
  expect(Object.keys(view.personal)).not.toContain('dateOfBirth');
  expect(Object.keys(view.personal)).not.toContain('civilStatus');
  expect(view.restrictedNotice).toBe(RESTRICTED_SECTIONS_NOTICE);
  const json = withoutIdsAndDates(JSON.stringify(view));
  for (const value of [...PLAINTEXTS, ...LAST_FOURS]) expect(json).not.toContain(value);
  expect(json).not.toContain('lastFour');
  expect(json).not.toContain('married');
  expect(json).not.toContain('1990');
}

describe('storage', () => {
  it('stores the IDs, account number and salary as binary subtype 6', async () => {
    const subject = await filledRecord();
    const raw = await database()
      .collection('employeeRecords')
      .findOne({ employeeId: new Types.ObjectId(subject.employeeId) });
    for (const value of [
      raw?.governmentIds?.tin,
      raw?.governmentIds?.sss,
      raw?.governmentIds?.philhealth,
      raw?.governmentIds?.pagibig,
      raw?.bankAccount?.accountNumber,
    ]) {
      expect(value).toBeInstanceOf(mongo.Binary);
      expect((value as mongo.Binary).sub_type).toBe(6);
    }
    expect(raw?.governmentIds?.rdoCode).toBe('043');
    const entry = await database()
      .collection('compensationEntries')
      .findOne({ employeeId: new Types.ObjectId(subject.employeeId) });
    expect(entry?.basicSalaryCentavos).toBeInstanceOf(mongo.Binary);
    expect((entry?.basicSalaryCentavos as mongo.Binary).sub_type).toBe(6);
    const rawJson = mongo.BSON.EJSON.stringify([raw, entry]);
    for (const value of PLAINTEXTS) expect(rawJson).not.toContain(value);
  });

  it('refuses a plain value in the model and in the collection validator', async () => {
    const employeeId = new Types.ObjectId();
    await expect(
      EmployeeRecordModel.create({
        employeeId,
        version: 1,
        governmentIds: { tin: Buffer.from('900123456781') },
      }),
    ).rejects.toThrow();
    await expect(
      database()
        .collection('employeeRecords')
        .insertOne({ employeeId, version: 1, governmentIds: { tin: '900123456781' } }),
    ).rejects.toMatchObject({ code: 121 });
    await expect(
      database()
        .collection('employeeRecords')
        .insertOne({ employeeId, version: 1, bankAccount: { accountNumber: '0009876543217' } }),
    ).rejects.toMatchObject({ code: 121 });
    await expect(
      database().collection('compensationEntries').insertOne({
        employeeId,
        effectiveDate: new Date(),
        basicSalaryCentavos: SALARY_CENTAVOS,
        rateType: 'monthly',
        minimumWageEarner: false,
        reason: 'x',
      }),
    ).rejects.toMatchObject({ code: 121 });
    expect(await EmployeeRecordModel.countDocuments({ employeeId })).toBe(0);
  });

  it('creates one record on the first save, and two first saves at once leave one', async () => {
    const subject = await person('Fidel', 'Ramos', NET);
    const results = await Promise.allSettled([
      updatePersonal(writer.actor, personalInput(subject, 0)),
      updatePersonal(owner.actor, personalInput(subject, 0)),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ActionError);
    expect(((rejected[0] as PromiseRejectedResult).reason as Error).message).toBe(
      RECORD_CHANGED_ELSEWHERE,
    );
    expect(
      await EmployeeRecordModel.countDocuments({
        employeeId: new Types.ObjectId(subject.employeeId),
      }),
    ).toBe(1);
    expect(
      (await auditEntries(EMPLOYEE_RECORD_TYPE)).filter(
        (entry) => entry.record.label === `${subject.employeeNumber} · Fidel Ramos`,
      ),
    ).toHaveLength(1);
  });

  it('refuses a stale version and changes nothing', async () => {
    const subject = await person('Gloria', 'Arroyo', NET);
    await updatePersonal(writer.actor, personalInput(subject, 0));
    await updateEmployment(writer.actor, {
      employeeId: subject.employeeId,
      version: 1,
      workRegion: 'VII',
      contractEndDate: null,
      regularizationDate: null,
      separationRemarks: null,
    });
    const before = await EmployeeRecordModel.findOne({
      employeeId: new Types.ObjectId(subject.employeeId),
    }).lean();
    const entries = await countAudit();
    await expect(
      updateEmployment(writer.actor, {
        employeeId: subject.employeeId,
        version: 1,
        workRegion: 'III',
        contractEndDate: null,
        regularizationDate: null,
        separationRemarks: null,
      }),
    ).rejects.toThrow(RECORD_CHANGED_ELSEWHERE);
    const after = await EmployeeRecordModel.findOne({
      employeeId: new Types.ObjectId(subject.employeeId),
    }).lean();
    expect(after).toEqual(before);
    expect(after?.workRegion).toBe('VII');
    expect(await countAudit()).toBe(entries);
  });

  it('refuses deleting or replacing a record', async () => {
    const subject = await person('Joseph', 'Estrada', NET);
    await updatePersonal(writer.actor, personalInput(subject, 0));
    const filter = { employeeId: new Types.ObjectId(subject.employeeId) };
    await expect(EmployeeRecordModel.deleteOne(filter)).rejects.toThrow(/never deleted/);
    await expect(EmployeeRecordModel.deleteMany(filter)).rejects.toThrow(/never deleted/);
    await expect(EmployeeRecordModel.findOneAndDelete(filter)).rejects.toThrow(/never deleted/);
    await expect(
      EmployeeRecordModel.replaceOne(filter, { employeeId: filter.employeeId, version: 9 }),
    ).rejects.toThrow(/never deleted/);
    await expect(
      EmployeeRecordModel.findOneAndReplace(filter, { employeeId: filter.employeeId, version: 9 }),
    ).rejects.toThrow(/never deleted/);
    await expect(EmployeeRecordModel.bulkWrite([{ deleteOne: { filter } }])).rejects.toThrow(
      /never deleted/,
    );
    await expect(
      EmployeeRecordModel.bulkWrite([
        { updateOne: { filter, update: { $set: { nationality: 'Edited' } } } },
      ]),
    ).rejects.toThrow(/never deleted/);
    await expect(
      EmployeeRecordModel.updateMany(filter, { $set: { nationality: 'Edited' } }),
    ).rejects.toThrow(/never deleted/);
    await expect(
      EmployeeRecordModel.aggregate([{ $match: filter }, { $out: 'employeeRecords' }]),
    ).rejects.toThrow(/never deleted/);
    const loaded = await EmployeeRecordModel.findOne(filter).orFail();
    await expect(loaded.deleteOne()).rejects.toThrow(/never deleted/);
    loaded.set('nationality', 'Edited');
    await expect(loaded.save()).rejects.toThrow(/never deleted/);
    expect(await EmployeeRecordModel.countDocuments(filter)).toBe(1);
  });

  it('keeps a stored ID when the input is empty, and replaces it when given', async () => {
    const subject = await filledRecord(NET, 'Imelda');
    const stored = await EmployeeRecordModel.findOne({
      employeeId: new Types.ObjectId(subject.employeeId),
    })
      .select('+governmentIds.tin +governmentIds.sss')
      .lean();
    await setGovernmentIds(hr.actor, {
      employeeId: subject.employeeId,
      version: await versionOf(subject),
      rdoCode: '044',
      sss: '0411112222',
    });
    const after = await EmployeeRecordModel.findOne({
      employeeId: new Types.ObjectId(subject.employeeId),
    })
      .select('+governmentIds.tin +governmentIds.sss')
      .lean();
    expect(bytes(after?.governmentIds.tin)).toEqual(bytes(stored?.governmentIds.tin));
    expect(bytes(after?.governmentIds.sss)).not.toEqual(bytes(stored?.governmentIds.sss));
    const view = await getEmployeeRecordView(hr.actor, subject.employeeId);
    expect(view?.governmentIds?.sss?.lastFour).toBe('2222');
    expect(view?.governmentIds?.tin?.lastFour).toBe(lastFourOf(IDS.tin));
    expect(view?.governmentIds?.rdoCode).toBe('044');
  });

  it('needs an account number on the first bank account save', async () => {
    const subject = await person('Corazon', 'Aquino', NET);
    await expect(
      setBankAccount(hr.actor, {
        employeeId: subject.employeeId,
        version: 0,
        bank: 'rcbc',
        accountName: 'Corazon Aquino',
      }),
    ).rejects.toMatchObject({ field: 'accountNumber' });
  });
});

describe('section visibility (the step’s "Done when")', () => {
  let subject: Person;
  let hrSubject: Person;

  beforeAll(async () => {
    subject = await filledRecord(NET, 'Liza');
    hrSubject = await filledRecord(HRD, 'Helen');
  });

  it('gives a Talent Write or Owner user with no role none of the sensitive data', async () => {
    expectNoSensitive(await getEmployeeRecordView(writer.actor, subject.employeeId));
    expectNoSensitive(await getEmployeeRecordView(owner.actor, subject.employeeId));
    expectNoSensitive(await getEmployeeRecordView(reader.actor, subject.employeeId));
    expectNoSensitive(await getEmployeeRecordView(writer.actor, hrSubject.employeeId));
  });

  it('gives HR the TIN’s last 4, masked, and every section', async () => {
    const view = await getEmployeeRecordView(hr.actor, subject.employeeId);
    expect(view?.governmentIds?.tin).toEqual({
      lastFour: lastFourOf(IDS.tin),
      ownerType: EMPLOYEE_RECORD_TYPE,
      ownerId: view?.recordId,
      field: 'tin',
    });
    expect(view?.bankAccount?.accountNumber?.lastFour).toBe(lastFourOf(ACCOUNT_NUMBER));
    expect(view?.bankAccount?.bank).toBe('unionbank');
    expect(view?.personal.dateOfBirth).toBe('1990-05-17');
    expect(view?.personal.civilStatus).toBe('married');
    expect(view?.compensation?.current?.rateType).toBe('monthly');
    expect(view?.restrictedNotice).toBeUndefined();
    const json = JSON.stringify(view);
    for (const value of [...Object.values(IDS), ACCOUNT_NUMBER]) expect(json).not.toContain(value);
  });

  it('gives Accounting the same view as HR', async () => {
    const hrView = await getEmployeeRecordView(hr.actor, subject.employeeId);
    const acctView = await getEmployeeRecordView(accounting.actor, subject.employeeId);
    expect(acctView?.personal).toEqual(hrView?.personal);
    expect(acctView?.governmentIds).toEqual(hrView?.governmentIds);
    expect(acctView?.bankAccount).toEqual(hrView?.bankAccount);
    expect(acctView?.compensation).toEqual(hrView?.compensation);
    expect(acctView?.can.editGovernmentIds).toBe(false);
    expect(acctView?.can.addCompensation).toBe(false);
  });

  it('gives a Board member the three sections for an HR-department employee only', async () => {
    const hrView = await getEmployeeRecordView(board.actor, hrSubject.employeeId);
    expect(hrView?.governmentIds?.tin?.lastFour).toBe(lastFourOf(IDS.tin));
    expect(hrView?.bankAccount?.accountNumber?.lastFour).toBe(lastFourOf(ACCOUNT_NUMBER));
    expect(hrView?.compensation?.entries).toHaveLength(1);
    expect(Object.keys(hrView?.personal ?? {})).not.toContain('dateOfBirth');
    expect(Object.keys(hrView?.personal ?? {})).not.toContain('civilStatus');
    expect(hrView?.can.editGovernmentIds).toBe(true);

    expectNoSensitive(await getEmployeeRecordView(board.actor, subject.employeeId));
  });

  it('gives the employee everything on their own record, read-only', async () => {
    const view = await getOwnRecordView(subject.actor);
    expect(view?.employeeId).toBe(subject.employeeId);
    expect(view?.governmentIds?.tin?.lastFour).toBe(lastFourOf(IDS.tin));
    expect(view?.bankAccount?.accountNumber?.lastFour).toBe(lastFourOf(ACCOUNT_NUMBER));
    expect(view?.compensation?.current).not.toBeNull();
    expect(view?.personal.dateOfBirth).toBe('1990-05-17');
    expect(view?.personal.civilStatus).toBe('married');
    // Read-only: only the employee's own photo and e-signature controls (step 2.2) are offered.
    const { changePhoto, uploadESignature, ...rest } = view?.can ?? ({} as never);
    expect(changePhoto).toBe(true);
    expect(uploadESignature).toBe(true);
    expect(Object.values(rest).every((allowed) => allowed === false)).toBe(true);
    expect(view?.manageAccessHref).toBeNull();
    expect(view?.editInUsersHref).toBeNull();
  });

  it('masks the salary with no digits', async () => {
    const view = await getEmployeeRecordView(hr.actor, subject.employeeId);
    const entry = view?.compensation?.entries[0];
    expect(entry?.basicSalary).toEqual({
      mask: '••••',
      ownerType: 'talent.compensationEntry',
      ownerId: entry?.id,
      field: 'basicSalary',
    });
    const json = withoutIdsAndDates(JSON.stringify(view));
    expect(json).not.toContain(String(SALARY_CENTAVOS));
    expect(json).not.toContain('48765');
    expect(json).not.toContain(lastFourOf(SALARY_CENTAVOS));
  });

  it('refuses the record and the list without Talent Read, and has no own view for no employee', async () => {
    const nobody = await person('Nora', 'Aunor', NET);
    await expect(getEmployeeRecordView(nobody.actor, subject.employeeId)).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    await expect(listEmployeeRecords(nobody.actor)).rejects.toBeInstanceOf(AccessDeniedError);
    expect(await getOwnRecordView({ ...admin.actor, employee: null })).toBeNull();
    const own = await getOwnRecordView(nobody.actor);
    expect(own?.filledIn).toBe(false);
    expect(own?.version).toBe(0);
  });

  it('lists employees with no sensitive field, date of birth or civil status', async () => {
    const list = await listEmployeeRecords(admin.actor);
    const row = list.rows.find((r) => r.employeeId === subject.employeeId);
    expect(row?.filledIn).toBe(true);
    expect(Object.keys(row ?? {}).sort()).toEqual(
      [
        'active',
        'dateHired',
        'department',
        'employeeId',
        'employeeNumber',
        'employmentStatus',
        'filledIn',
        'firstName',
        'initials',
        'lastName',
        'middleName',
        'name',
        'photoUrl',
        'position',
        'separated',
        'userId',
      ].sort(),
    );
    const json = withoutIdsAndDates(JSON.stringify(list));
    for (const value of [...PLAINTEXTS, ...LAST_FOURS]) expect(json).not.toContain(value);
    expect(json).not.toContain('married');
    expect(json).not.toContain('1990');
    expect(list.stats.find((s) => s.status === 'Regular')?.count).toBeGreaterThan(0);

    const fresh = await person('Nestor', 'Torre', NET);
    const again = await listEmployeeRecords(reader.actor, { q: 'nestor' });
    expect(again.rows.map((r) => r.employeeId)).toEqual([fresh.employeeId]);
    expect(again.rows[0]?.filledIn).toBe(false);
  });

  it('counts a salary entry as filled in only for viewers who may see Compensation', async () => {
    // Only a compensation entry is saved: no employeeRecords record exists.
    const paidOnly = await person('Pilar', 'Salonga', NET);
    await addCompensationEntry(hr.actor, {
      employeeId: paidOnly.employeeId,
      effectiveDate: '2024-01-01',
      basicSalaryCentavos: SALARY_CENTAVOS,
      rateType: 'monthly',
      minimumWageEarner: false,
      reason: 'Starting salary',
    });
    const rowFor = async (viewer: Person) =>
      (await listEmployeeRecords(viewer.actor, { q: 'pilar' })).rows[0];
    expect((await rowFor(hr))?.filledIn).toBe(true);
    expect((await rowFor(accounting))?.filledIn).toBe(true);
    // For anyone else the badge would tell them a salary is stored.
    for (const viewer of [writer, reader, board]) {
      expect((await rowFor(viewer))?.filledIn).toBe(false);
      expect((await getEmployeeRecordView(viewer.actor, paidOnly.employeeId))?.filledIn).toBe(
        false,
      );
    }
    expect((await getEmployeeRecordView(hr.actor, paidOnly.employeeId))?.filledIn).toBe(true);
  });

  it('offers Manage access and Edit in Users to HR and the System Administrator only', async () => {
    const hrView = await getEmployeeRecordView(hr.actor, subject.employeeId);
    expect(hrView?.manageAccessHref).toBe(`/admin/access?user=${subject.userId}`);
    expect(hrView?.editInUsersHref).toBe(`/admin/users?q=${subject.employeeNumber}`);
    const writerView = await getEmployeeRecordView(writer.actor, subject.employeeId);
    expect(writerView?.manageAccessHref).toBeNull();
    expect(writerView?.editInUsersHref).toBeNull();
  });
});

describe('who may change what', () => {
  const ids = (subject: Person, version: number) => ({
    employeeId: subject.employeeId,
    version,
    tin: '900111222333',
    rdoCode: '050',
  });
  const bank = (subject: Person, version: number) => ({
    employeeId: subject.employeeId,
    version,
    bank: 'rcbc' as const,
    accountNumber: '1234500001',
    accountName: 'Sample Name',
  });
  const pay = (subject: Person) => ({
    employeeId: subject.employeeId,
    effectiveDate: '2024-06-01',
    basicSalaryCentavos: 3000000,
    rateType: 'monthly' as const,
    minimumWageEarner: false,
    reason: 'Raise',
  });

  async function expectAllSensitive(actor: Person, subject: Person) {
    await setGovernmentIds(actor.actor, ids(subject, await versionOf(subject)));
    await setBankAccount(actor.actor, bank(subject, await versionOf(subject)));
    await addCompensationEntry(actor.actor, pay(subject));
  }

  async function expectRefused(actor: Person, subject: Person) {
    const record = await EmployeeRecordModel.findOne({
      employeeId: new Types.ObjectId(subject.employeeId),
    })
      .select('+governmentIds.tin +bankAccount.accountNumber')
      .lean();
    const entries = await countAudit();
    const compensation = await CompensationEntryModel.countDocuments({
      employeeId: new Types.ObjectId(subject.employeeId),
    });
    const version = await versionOf(subject);
    await expect(setGovernmentIds(actor.actor, ids(subject, version))).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    await expect(setBankAccount(actor.actor, bank(subject, version))).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    await expect(addCompensationEntry(actor.actor, pay(subject))).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    // A refused change writes nothing.
    expect(
      await EmployeeRecordModel.findOne({ employeeId: new Types.ObjectId(subject.employeeId) })
        .select('+governmentIds.tin +bankAccount.accountNumber')
        .lean(),
    ).toEqual(record);
    expect(await countAudit()).toBe(entries);
    expect(
      await CompensationEntryModel.countDocuments({
        employeeId: new Types.ObjectId(subject.employeeId),
      }),
    ).toBe(compensation);
  }

  it('lets HR and the System Administrator, with Talent Write, change a non-HR employee’s', async () => {
    await expectAllSensitive(hr, await person('Ramon', 'Magsaysay', NET));
    await expectAllSensitive(admin, await person('Diosdado', 'Macapagal', NET));
  });

  it('refuses HR for an HR-department employee, where the System Administrator and Board succeed', async () => {
    const colleague = await person('Elpidio', 'Quirino', HRD);
    await expectRefused(hr, colleague);
    await expectAllSensitive(admin, colleague);
    await expectAllSensitive(board, colleague);
  });

  it('refuses a Board member for anyone outside HR', async () => {
    await expectRefused(board, await person('Sergio', 'Osmena', NET));
  });

  it('always refuses Accounting', async () => {
    await expectRefused(accounting, await person('Manuel', 'Roxas', NET));
    await expectRefused(accounting, await person('Jose', 'Laurel', HRD));
  });

  it('refuses HR without Talent Write', async () => {
    const hrReader = await person('Herminia', 'Rojas', HRD, { talent: 'read' });
    await expectRefused(hrReader, await person('Emilio', 'Aguinaldo', NET));
  });

  it('lets a Talent Write user with no role change personal and employment fields only', async () => {
    const subject = await person('Carlos', 'Garcia', NET);
    let { version } = await updatePersonal(writer.actor, personalInput(subject, 0));
    ({ version } = await updateEmployment(writer.actor, {
      employeeId: subject.employeeId,
      version,
      workRegion: 'III',
      contractEndDate: null,
      regularizationDate: '2024-07-01',
      separationRemarks: null,
    }));
    expect(version).toBe(2);
    await expectRefused(writer, subject);
    await expect(
      updatePersonal(writer.actor, {
        ...personalInput(subject, version),
        dateOfBirth: '1980-01-01',
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(
      updatePersonal(writer.actor, { ...personalInput(subject, version), civilStatus: 'single' }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    expect(await versionOf(subject)).toBe(2);
    // HR may change them.
    await updatePersonal(hr.actor, {
      ...personalInput(subject, version),
      dateOfBirth: '1980-01-01',
      civilStatus: 'single',
    });
  });

  it('refuses a Talent Read user any change', async () => {
    const subject = await person('Ferdinand', 'Marcos', NET);
    await expect(updatePersonal(reader.actor, personalInput(subject, 0))).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    expect(await versionOf(subject)).toBe(0);
  });

  it('refuses everyone their own record, the System Administrator included', async () => {
    for (const self of [hr, admin, writer, board]) {
      await expect(
        updatePersonal(self.actor, personalInput(self, await versionOf(self))),
      ).rejects.toBeInstanceOf(AccessDeniedError);
    }
    await expectRefused(admin, admin);
    await expectRefused(hr, hr);
  });

  it('follows a department change made after the session loaded', async () => {
    const mover = await person('Rodrigo', 'Duterte', NET);
    await moveTo(mover, HRD);
    // The service reads the employee's department again, so HR is now refused.
    await expect(
      setGovernmentIds(hr.actor, ids(mover, await versionOf(mover))),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it('re-checks the actor inside the transaction, against their access and department as now', async () => {
    // The actors' sessions are stale: they still say Talent Write and HR.
    const lowered = await person('Leni', 'Robredo', HRD, { talent: 'write' });
    await setTalentAccess(lowered, 'read');
    const moved = await person('Mar', 'Roxas', HRD, { talent: 'write' });
    await moveTo(moved, NET);
    const subject = await person('Grace', 'Poe', NET);
    await expectRefused(lowered, subject);
    await expectRefused(moved, subject);
    await expect(updatePersonal(lowered.actor, personalInput(subject, 0))).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    expect(await versionOf(subject)).toBe(0);
  });
});

describe('audit', () => {
  it('writes a create on the first save and an update after, labelled, with sensitive values hidden', async () => {
    const subject = await person('Benigno', 'Aquino', NET);
    const label = `${subject.employeeNumber} · Benigno Aquino`;
    let { version } = await setGovernmentIds(hr.actor, {
      employeeId: subject.employeeId,
      version: 0,
      tin: IDS.tin,
      rdoCode: '043',
    });
    ({ version } = await setGovernmentIds(hr.actor, {
      employeeId: subject.employeeId,
      version,
      tin: '900555666777',
      rdoCode: '043',
    }));
    await updateEmployment(hr.actor, {
      employeeId: subject.employeeId,
      version,
      workRegion: 'XI',
      contractEndDate: null,
      regularizationDate: null,
      separationRemarks: null,
    });
    const entries = (await auditEntries(EMPLOYEE_RECORD_TYPE)).filter(
      (entry) => entry.record.label === label,
    );
    expect(entries.map((entry) => entry.action)).toEqual(['create', 'update', 'update']);
    for (const entry of entries) {
      expect(entry.module).toBe('talent');
      expect(entry.actorId?.toHexString()).toBe(hr.userId);
    }
    expect(entries[0]?.after?.governmentIds?.tin).toEqual(HIDDEN_SENSITIVE);
    expect(entries[1]?.before?.governmentIds?.tin).toEqual(HIDDEN_SENSITIVE);
    expect(entries[1]?.after?.governmentIds?.tin).toEqual(HIDDEN_SENSITIVE_CHANGED);
    expect(entries[2]?.after?.workRegion).toBe('XI');
    expect(entries[2]?.after?.governmentIds?.tin).toEqual(HIDDEN_SENSITIVE);
  });

  it('writes nothing when the audit entry can’t be written', async () => {
    const subject = await person('Elpidia', 'Lopez', NET);
    await database().command({
      collMod: 'auditLogs',
      validator: { $jsonSchema: { required: ['aFieldNoEntryHas'] } },
      validationLevel: 'strict',
      validationAction: 'error',
    });
    await expect(updatePersonal(writer.actor, personalInput(subject, 0))).rejects.toThrow();
    await database().command({ collMod: 'auditLogs', validator: {} });
    expect(await versionOf(subject)).toBe(0);
  });

  it('never holds a plaintext value or its last 4 in the raw audit JSON', async () => {
    await filledRecord(NET, 'Josefa');
    const json = withoutIdsAndDates(await rawAuditJson());
    for (const value of [...PLAINTEXTS, ...LAST_FOURS]) expect(json).not.toContain(value);
  });
});
