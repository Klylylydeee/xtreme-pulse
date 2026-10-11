import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose, { type mongo, type Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { EMPLOYMENT_STATUS, type EmploymentStatus } from '../../account';
import { AccessDeniedError, ActionError } from '../../actions';
import { toBusinessDate } from '../../dates';
import type { DeclareHolidayInput, HolidayInput } from '../../holidays';
import { AuditLogModel } from '../audit/model';
import { departmentRolesFor } from '../auth/roles';
import { DepartmentModel } from '../departments/model';
import { EmployeeModel } from '../employees/model';
import { NotificationModel } from '../notifications/model';
import { PositionModel } from '../positions/model';
import { coreSeedLoaders } from '../seed/loaders';
import { UserModel } from '../users/model';
import {
  registerHolidaysChangedListener,
  runHolidaysChangedListeners,
  setHolidaysChangedEnqueuer,
  unregisterHolidaysChangedListener,
} from './events';
import { HolidayModel } from './model';
import {
  confirmHoliday,
  confirmHolidayYear,
  createHoliday,
  declareHoliday,
  deleteHoliday,
  findHolidaysOnDate,
  getHoliday,
  HOLIDAY_DECLARED_EVENT,
  type HolidayActor,
  HolidayLegalBasisMissingError,
  listConfirmedHolidays,
  listHolidays,
  listHolidayYears,
  updateHoliday,
} from './service';

// The holiday services (docs/modules/core.md#holiday-calendar, docs/TESTING.md#holiday-calendar-tests):
// access, visibility, adding, editing, confirming, Confirm all, declaring, deleting, the audit
// entries and the holidays-changed event. Made-up people and holidays only.

function database(): mongo.Db {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Not connected.');
  return db;
}

async function failAuditWrites(): Promise<void> {
  await database().command({
    collMod: 'auditLogs',
    validator: { $jsonSchema: { required: ['aFieldNoEntryHas'] } },
    validationLevel: 'strict',
    validationAction: 'error',
  });
}

async function restoreAuditWrites(): Promise<void> {
  await database().command({ collMod: 'auditLogs', validator: {}, validationLevel: 'off' });
}

let sequence = 0;

/** A user with an employee in `departmentCode`, as an actor (id, email and roles). */
async function person(
  departmentCode: string,
  employmentStatus: EmploymentStatus = 'Regular',
  { isSystemAdministrator = false } = {},
): Promise<HolidayActor> {
  sequence += 1;
  const department = await DepartmentModel.findOne({ code: departmentCode }).lean().orFail();
  const position = await PositionModel.findOne({ departmentId: department._id }).lean().orFail();
  const employee = await EmployeeModel.create({
    employeeNumber: `2026-${String(sequence).padStart(2, '0')}`,
    firstName: 'Sample',
    lastName: `Person ${sequence}`,
    departmentId: department._id,
    positionId: position._id,
    employmentStatus,
    dateHired: new Date('2026-01-05T00:00:00+08:00'),
    separationDate:
      EMPLOYMENT_STATUS[employmentStatus] === 'deactivated'
        ? new Date('2026-06-01T00:00:00+08:00')
        : null,
  });
  const email = `holiday.person.${sequence}@xtreme-works.com`;
  const user = await UserModel.create({
    email,
    passwordHash: 'made-up-not-a-hash',
    mustChangePassword: false,
    isSystemAdministrator,
    employeeId: employee._id,
  });
  return {
    id: user._id.toHexString(),
    email,
    isSystemAdministrator,
    roles: departmentRolesFor(departmentCode),
  };
}

let HR: HolidayActor;
let ADMIN: HolidayActor;
let STAFF: HolidayActor;
let ACCOUNTING: HolidayActor;
let BOARD: HolidayActor;
let RESIGNED: HolidayActor;
let systemAccountId: Types.ObjectId;

/** The holidays-changed jobs enqueued, each as its dates. */
const enqueued: string[][] = [];

let dayCounter = 0;
/** A fresh, unused day in 2027 (so tests don't collide), as YYYY-MM-DD. */
function nextDay(year = 2027): string {
  dayCounter += 1;
  const date = new Date(Date.UTC(year, 0, 1 + dayCounter));
  return date.toISOString().slice(0, 10);
}

function holiday(overrides: Partial<HolidayInput> = {}): HolidayInput {
  return {
    name: `Sample holiday ${dayCounter + 1}`,
    date: nextDay(),
    type: 'specialNonWorking',
    scope: 'nationwide',
    location: null,
    legalBasis: null,
    ...overrides,
  };
}

async function auditFor(id: string) {
  return AuditLogModel.find({ 'record.type': 'core.holiday', 'record.id': id })
    .sort({ createdAt: 1, _id: 1 })
    .lean();
}

async function stored(id: string) {
  return HolidayModel.findById(id, null, { withDeleted: true }).lean().orFail();
}

async function editOf(id: string, changes: Partial<HolidayInput> = {}) {
  const record = await stored(id);
  return {
    id,
    name: record.name,
    date: toBusinessDate(record.date),
    type: record.type,
    scope: record.scope,
    location: record.location,
    legalBasis: record.legalBasis,
    expectedUpdatedAt: record.updatedAt.toISOString(),
    ...changes,
  };
}

beforeAll(async () => {
  await connectDb();
  for (const loader of coreSeedLoaders) await loader.run();
  // Collections must exist before a transaction writes to them.
  await Promise.all([HolidayModel.init(), AuditLogModel.init(), NotificationModel.init()]);
  HR = await person('HR');
  ADMIN = await person('NET', 'Regular', { isSystemAdministrator: true });
  STAFF = await person('NET');
  ACCOUNTING = await person('ACCT');
  BOARD = await person('BOD');
  RESIGNED = await person('POS', 'Resigned');
  const system = await UserModel.create({
    email: 'system.account@xtreme-works.com',
    passwordHash: 'made-up-not-a-hash',
    isSystemAdministrator: true,
    isSystemAccount: true,
    employeeId: null,
  });
  systemAccountId = system._id;
});

beforeEach(() => {
  enqueued.length = 0;
  setHolidaysChangedEnqueuer(async (dates) => {
    enqueued.push(dates);
  });
});

afterEach(async () => {
  await restoreAuditWrites();
  setHolidaysChangedEnqueuer(null);
  vi.restoreAllMocks();
});

describe('who can change holidays', () => {
  it('refuses anyone but HR and System Administrators, and changes nothing', async () => {
    const { id } = await createHoliday(HR, holiday({ legalBasis: 'Proclamation No. 1' }));
    const before = await stored(id);
    for (const outsider of [STAFF, ACCOUNTING, BOARD]) {
      await expect(createHoliday(outsider, holiday())).rejects.toBeInstanceOf(AccessDeniedError);
      await expect(
        declareHoliday(outsider, { ...holiday(), legalBasis: 'P' }),
      ).rejects.toBeInstanceOf(AccessDeniedError);
      await expect(updateHoliday(outsider, await editOf(id, { name: 'X' }))).rejects.toBeInstanceOf(
        AccessDeniedError,
      );
      await expect(confirmHoliday(outsider, { id })).rejects.toBeInstanceOf(AccessDeniedError);
      await expect(confirmHolidayYear(outsider, 2027)).rejects.toBeInstanceOf(AccessDeniedError);
      await expect(deleteHoliday(outsider, { id })).rejects.toBeInstanceOf(AccessDeniedError);
      await expect(findHolidaysOnDate(outsider, '2027-01-01')).rejects.toBeInstanceOf(
        AccessDeniedError,
      );
    }
    const after = await stored(id);
    expect(after).toEqual(before);
    expect(await auditFor(id)).toHaveLength(1);
    expect(enqueued).toEqual([]);
  });

  it('lets HR and a System Administrator add holidays', async () => {
    await expect(createHoliday(HR, holiday())).resolves.toHaveProperty('id');
    await expect(createHoliday(ADMIN, holiday())).resolves.toHaveProperty('id');
  });
});

describe('createHoliday', () => {
  it('adds a manual draft with one create entry labelled <name> · <date>, enqueuing nothing', async () => {
    const date = nextDay();
    const { id } = await createHoliday(HR, holiday({ name: 'Sample Day', date }));
    const record = await stored(id);
    expect(record).toMatchObject({
      name: 'Sample Day',
      year: 2027,
      status: 'draft',
      source: 'manual',
      sourceKey: null,
      declared: false,
      legalBasis: null,
      confirmedAt: null,
      deletedAt: null,
    });
    expect(record.date.toISOString()).toBe(new Date(`${date}T00:00:00+08:00`).toISOString());

    const entries = await auditFor(id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'create',
      module: 'core',
      actorEmail: HR.email,
      record: { type: 'core.holiday', label: `Sample Day · ${date}` },
      before: null,
      after: { name: 'Sample Day', status: 'draft' },
    });
    expect(enqueued).toEqual([]);
  });

  it('requires a location for a local holiday, and stores none for a nationwide one', async () => {
    await expect(
      createHoliday(HR, holiday({ scope: 'local', location: '' })),
    ).rejects.toMatchObject({ field: 'location' });
    const local = await createHoliday(HR, holiday({ scope: 'local', location: 'Quezon City' }));
    expect((await stored(local.id)).location).toBe('Quezon City');
    const nationwide = await createHoliday(HR, holiday({ location: 'Leftover' }));
    expect((await stored(nationwide.id)).location).toBeNull();
  });

  it('refuses the same name on the same date, ignoring case, among live holidays only', async () => {
    const date = nextDay();
    const first = await createHoliday(HR, holiday({ name: 'Founding Day', date }));
    await expect(createHoliday(HR, holiday({ name: 'FOUNDING day', date }))).rejects.toMatchObject({
      field: 'name',
    });
    // A different name on the same date is fine, and the warning data names the others.
    const second = await createHoliday(HR, holiday({ name: 'Another Day', date }));
    const onDate = await findHolidaysOnDate(HR, date, { exceptId: second.id });
    expect(onDate.map((h) => h.name)).toEqual(['Founding Day']);
    // A deleted holiday doesn't block the name.
    await deleteHoliday(HR, { id: first.id });
    await expect(createHoliday(HR, holiday({ name: 'Founding Day', date }))).resolves.toBeTruthy();
  });

  it('rolls back when the audit entry can’t be written', async () => {
    const date = nextDay();
    await failAuditWrites();
    await expect(createHoliday(HR, holiday({ name: 'Rolled back', date }))).rejects.toThrow();
    await restoreAuditWrites();
    expect(await HolidayModel.countDocuments({ name: 'Rolled back' }, { withDeleted: true })).toBe(
      0,
    );
  });
});

describe('visibility', () => {
  it('gives anyone but HR and System Administrators confirmed holidays only', async () => {
    const year = 2031;
    const draft = await createHoliday(HR, holiday({ name: 'Draft day', date: '2031-03-03' }));
    const confirmed = await declareHoliday(HR, {
      ...holiday({ name: 'Confirmed day', date: '2031-03-04' }),
      legalBasis: 'Proclamation No. 2',
    });

    for (const viewer of [STAFF, ACCOUNTING, BOARD]) {
      const seen = await listHolidays(viewer, { year });
      expect(seen.map((h) => h.id)).toEqual([confirmed.id]);
      expect(await getHoliday(viewer, draft.id)).toBeNull();
      expect(await getHoliday(viewer, confirmed.id)).not.toBeNull();
    }
    for (const manager of [HR, ADMIN]) {
      const seen = await listHolidays(manager, { year });
      expect(seen.map((h) => h.name)).toEqual(['Draft day', 'Confirmed day']);
      expect(await getHoliday(manager, draft.id)).toMatchObject({ status: 'draft' });
    }
    expect(await listHolidayYears(STAFF)).toContain(year);
    expect(
      await listConfirmedHolidays({ from: '2031-03-01', to: '2031-03-31' }).then((list) =>
        list.map((h) => [h.name, h.date]),
      ),
    ).toEqual([['Confirmed day', '2031-03-04']]);
  });
});

describe('updateHoliday', () => {
  it('edits a draft with one update entry and enqueues nothing', async () => {
    const date = nextDay();
    const { id } = await createHoliday(HR, holiday({ name: 'Old name', date }));
    await updateHoliday(ADMIN, await editOf(id, { name: 'New name', type: 'regular' }));
    const entries = await auditFor(id);
    expect(entries.map((e) => e.action)).toEqual(['create', 'update']);
    expect(entries[1]).toMatchObject({
      actorEmail: ADMIN.email,
      record: { label: `New name · ${date}` },
      before: { name: 'Old name' },
      after: { name: 'New name', type: 'regular' },
    });
    expect(enqueued).toEqual([]);
  });

  it('moves a date within its year but refuses a move to another year, changing nothing', async () => {
    const { id } = await createHoliday(HR, holiday({ date: '2027-05-05' }));
    await updateHoliday(HR, await editOf(id, { date: '2027-05-06' }));
    expect((await getHoliday(HR, id))?.date).toBe('2027-05-06');

    const before = await stored(id);
    await expect(updateHoliday(HR, await editOf(id, { date: '2028-05-06' }))).rejects.toMatchObject(
      { field: 'date' },
    );
    expect(await stored(id)).toEqual(before);
    expect(await auditFor(id)).toHaveLength(2);
  });

  it('refuses a stale sheet', async () => {
    const { id } = await createHoliday(HR, holiday());
    const stale = await editOf(id, { name: 'First edit' });
    await updateHoliday(HR, stale);
    await expect(updateHoliday(HR, { ...stale, name: 'Second edit' })).rejects.toBeInstanceOf(
      ActionError,
    );
    expect((await stored(id)).name).toBe('First edit');
  });

  it('returns the new updatedAt, so the same sheet can save or confirm again', async () => {
    const { id } = await createHoliday(HR, holiday());
    const first = await editOf(id, { name: 'Saved once' });
    const { updatedAt } = await updateHoliday(HR, first);
    expect(updatedAt).toBe((await stored(id)).updatedAt.toISOString());
    // Edit, then confirm refused (no legal basis), then save again from the same sheet.
    await expect(confirmHoliday(HR, { id, expectedUpdatedAt: updatedAt })).rejects.toMatchObject({
      field: 'legalBasis',
    });
    const again = await updateHoliday(HR, {
      ...first,
      legalBasis: 'Proclamation No. 5',
      expectedUpdatedAt: updatedAt,
    });
    await confirmHoliday(HR, { id, expectedUpdatedAt: again.updatedAt });
    expect((await stored(id)).status).toBe('confirmed');
  });

  it('never changes source or sourceKey', async () => {
    const { id } = await createHoliday(HR, holiday());
    await updateHoliday(HR, {
      ...(await editOf(id, { name: 'Renamed' })),
      ...({ source: 'rule', sourceKey: 'rule:sneaky' } as object),
    });
    expect(await stored(id)).toMatchObject({ name: 'Renamed', source: 'manual', sourceKey: null });
    // The model refuses it too.
    await HolidayModel.updateOne(
      { _id: id },
      { $set: { source: 'online', sourceKey: 'x', year: 1 } },
    );
    expect(await stored(id)).toMatchObject({ source: 'manual', sourceKey: null, year: 2027 });
  });

  it('enqueues both dates when a confirmed holiday moves, after the commit', async () => {
    const { id } = await declareHoliday(HR, {
      ...holiday({ date: '2027-09-09' }),
      legalBasis: 'Proclamation No. 3',
    });
    enqueued.length = 0;
    await updateHoliday(HR, await editOf(id, { date: '2027-09-10' }));
    expect(enqueued).toEqual([['2027-09-09', '2027-09-10']]);
    // A confirmed holiday keeps its legal basis.
    await expect(updateHoliday(HR, await editOf(id, { legalBasis: '' }))).rejects.toMatchObject({
      field: 'legalBasis',
    });
  });

  it('enqueues nothing when the change rolls back', async () => {
    const { id } = await declareHoliday(HR, {
      ...holiday(),
      legalBasis: 'Proclamation No. 4',
    });
    enqueued.length = 0;
    const edit = await editOf(id, { name: 'Never saved' });
    await failAuditWrites();
    await expect(updateHoliday(HR, edit)).rejects.toThrow();
    await restoreAuditWrites();
    expect((await stored(id)).name).not.toBe('Never saved');
    expect(enqueued).toEqual([]);
  });
});

describe('confirmHoliday', () => {
  it('needs a legal basis, then confirms with one update entry and enqueues the date', async () => {
    const date = nextDay();
    const { id } = await createHoliday(HR, holiday({ name: 'To confirm', date }));
    await expect(confirmHoliday(HR, { id })).rejects.toMatchObject({ field: 'legalBasis' });
    expect((await stored(id)).status).toBe('draft');
    expect(enqueued).toEqual([]);

    await updateHoliday(HR, await editOf(id, { legalBasis: 'Proclamation No. 5' }));
    const notificationsBefore = await NotificationModel.countDocuments({});
    await confirmHoliday(ADMIN, { id });
    expect(await stored(id)).toMatchObject({
      status: 'confirmed',
      confirmedBy: new mongoose.Types.ObjectId(ADMIN.id),
    });
    expect((await stored(id)).confirmedAt).toBeInstanceOf(Date);
    const entries = await auditFor(id);
    expect(entries.map((e) => e.action)).toEqual(['create', 'update', 'update']);
    expect(entries[2]).toMatchObject({
      record: { label: `To confirm · ${date}` },
      before: { status: 'draft' },
      after: { status: 'confirmed' },
    });
    expect(enqueued).toEqual([[date]]);
    // Confirming notifies nobody.
    expect(await NotificationModel.countDocuments({})).toBe(notificationsBefore);
    await expect(confirmHoliday(HR, { id })).rejects.toBeInstanceOf(ActionError);
  });

  it('rolls back when the audit entry can’t be written, enqueuing nothing', async () => {
    const { id } = await createHoliday(HR, holiday({ legalBasis: 'Proclamation No. 6' }));
    await failAuditWrites();
    await expect(confirmHoliday(HR, { id })).rejects.toThrow();
    await restoreAuditWrites();
    expect((await stored(id)).status).toBe('draft');
    expect(enqueued).toEqual([]);
  });
});

describe('confirmHolidayYear (Confirm all)', () => {
  it('refuses while any draft lacks a legal basis, lists them, and confirms nothing', async () => {
    const withBasis = await createHoliday(
      HR,
      holiday({ name: 'Has basis', date: '2032-01-10', legalBasis: 'Proclamation No. 7' }),
    );
    await createHoliday(HR, holiday({ name: 'No basis A', date: '2032-01-11' }));
    await createHoliday(HR, holiday({ name: 'No basis B', date: '2032-01-12' }));

    const refusal = await confirmHolidayYear(HR, 2032).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(HolidayLegalBasisMissingError);
    expect((refusal as HolidayLegalBasisMissingError).drafts.map((d) => [d.name, d.date])).toEqual([
      ['No basis A', '2032-01-11'],
      ['No basis B', '2032-01-12'],
    ]);
    expect(await HolidayModel.countDocuments({ year: 2032, status: 'confirmed' })).toBe(0);
    expect((await auditFor(withBasis.id)).map((e) => e.action)).toEqual(['create']);
    expect(enqueued).toEqual([]);
  });

  it('confirms every draft, one update entry each, and enqueues one job with every date', async () => {
    const ids = [];
    for (const [name, date] of [
      ['First', '2033-01-01'],
      ['Second', '2033-04-09'],
      ['Third', '2033-12-25'],
    ] as const) {
      ids.push((await createHoliday(HR, holiday({ name, date, legalBasis: 'Proclamation 8' }))).id);
    }
    const notificationsBefore = await NotificationModel.countDocuments({});
    const result = await confirmHolidayYear(HR, 2033);
    expect(result).toEqual({ confirmed: 3, dates: ['2033-01-01', '2033-04-09', '2033-12-25'] });
    expect(await HolidayModel.countDocuments({ year: 2033, status: 'confirmed' })).toBe(3);
    for (const id of ids) {
      expect((await auditFor(id)).map((e) => e.action)).toEqual(['create', 'update']);
    }
    expect(enqueued).toEqual([['2033-01-01', '2033-04-09', '2033-12-25']]);
    expect(await NotificationModel.countDocuments({})).toBe(notificationsBefore);
    await expect(confirmHolidayYear(HR, 2033)).rejects.toBeInstanceOf(ActionError);
  });
});

describe('declareHoliday', () => {
  it('needs a legal basis', async () => {
    await expect(declareHoliday(HR, holiday() as DeclareHolidayInput)).rejects.toMatchObject({
      field: 'legalBasis',
    });
  });

  it('creates a confirmed, declared holiday and notifies every active user but the declarer', async () => {
    const date = nextDay();
    const { id, notified } = await declareHoliday(HR, {
      ...holiday({ name: 'Eid’l Fitr', date, type: 'regular' }),
      legalBasis: 'Proclamation No. 9',
    });
    expect(await stored(id)).toMatchObject({
      status: 'confirmed',
      declared: true,
      source: 'manual',
      legalBasis: 'Proclamation No. 9',
      confirmedBy: new mongoose.Types.ObjectId(HR.id),
    });
    const entries = await auditFor(id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'create',
      record: { label: `Eid’l Fitr · ${date}` },
    });

    const sent = await NotificationModel.find({
      event: HOLIDAY_DECLARED_EVENT,
      'record.id': id,
    }).lean();
    const recipients = new Set(sent.map((n) => n.recipientUserId.toHexString()));
    expect(notified).toBe(sent.length);
    for (const actor of [ADMIN, STAFF, ACCOUNTING, BOARD])
      expect(recipients.has(actor.id)).toBe(true);
    expect(recipients.has(HR.id)).toBe(false);
    expect(recipients.has(RESIGNED.id)).toBe(false);
    expect(recipients.has(systemAccountId.toHexString())).toBe(false);
    expect(sent[0]).toMatchObject({ module: 'core', href: '/holidays', readAt: null });
    expect(enqueued).toEqual([[date]]);
  });

  it('notifies no one when the save fails', async () => {
    const date = nextDay();
    const before = await NotificationModel.countDocuments({ event: HOLIDAY_DECLARED_EVENT });
    await failAuditWrites();
    await expect(
      declareHoliday(HR, { ...holiday({ name: 'Failed', date }), legalBasis: 'Proclamation 10' }),
    ).rejects.toThrow();
    await restoreAuditWrites();
    expect(await NotificationModel.countDocuments({ event: HOLIDAY_DECLARED_EVENT })).toBe(before);
    expect(await HolidayModel.countDocuments({ name: 'Failed' }, { withDeleted: true })).toBe(0);
    expect(enqueued).toEqual([]);
  });
});

describe('deleteHoliday', () => {
  it('soft-deletes a draft with a delete entry (after null) and enqueues nothing', async () => {
    const date = nextDay();
    const { id } = await createHoliday(HR, holiday({ name: 'Doomed', date }));
    await deleteHoliday(HR, { id });
    const record = await stored(id);
    expect(record.deletedAt).toBeInstanceOf(Date);
    expect(await HolidayModel.findById(id).lean()).toBeNull();
    const entries = await auditFor(id);
    expect(entries.map((e) => e.action)).toEqual(['create', 'delete']);
    expect(entries[1]).toMatchObject({ record: { label: `Doomed · ${date}` }, after: null });
    expect(enqueued).toEqual([]);
    await expect(deleteHoliday(HR, { id })).rejects.toBeInstanceOf(ActionError);
  });

  it('enqueues the date when a confirmed holiday is deleted', async () => {
    const date = nextDay();
    const { id } = await declareHoliday(HR, {
      ...holiday({ date }),
      legalBasis: 'Proclamation 11',
    });
    enqueued.length = 0;
    await deleteHoliday(ADMIN, { id });
    expect(enqueued).toEqual([[date]]);
  });

  it('rolls back when the audit entry can’t be written', async () => {
    const { id } = await createHoliday(HR, holiday());
    await failAuditWrites();
    await expect(deleteHoliday(HR, { id })).rejects.toThrow();
    await restoreAuditWrites();
    expect((await stored(id)).deletedAt).toBeNull();
  });
});

describe('holidays changed', () => {
  it('logs a failed enqueue without failing the committed change', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    setHolidaysChangedEnqueuer(async () => {
      throw new Error('Redis is down');
    });
    const { id } = await declareHoliday(HR, { ...holiday(), legalBasis: 'Proclamation 12' });
    expect((await stored(id)).status).toBe('confirmed');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('core.holidaysChanged'));
  });

  it('runs every registered listener with the dates, and does nothing with none', async () => {
    expect(await runHolidaysChangedListeners({ dates: ['2027-01-02'] })).toEqual({ listeners: 0 });
    const calls: string[][] = [];
    registerHolidaysChangedListener('test.first', ({ dates }) => {
      calls.push(dates);
    });
    registerHolidaysChangedListener('test.second', async ({ dates }) => {
      calls.push(dates);
    });
    try {
      expect(
        await runHolidaysChangedListeners({ dates: ['2027-03-26', '2027-01-02', '2027-03-26'] }),
      ).toEqual({ listeners: 2 });
      expect(calls).toEqual([
        ['2027-01-02', '2027-03-26'],
        ['2027-01-02', '2027-03-26'],
      ]);
    } finally {
      unregisterHolidaysChangedListener('test.first');
      unregisterHolidaysChangedListener('test.second');
    }
  });

  it('fails the job when a listener throws, so it is retried', async () => {
    registerHolidaysChangedListener('test.failing', () => {
      throw new Error('recompute failed');
    });
    try {
      await expect(runHolidaysChangedListeners({ dates: ['2027-01-02'] })).rejects.toThrow(
        'recompute failed',
      );
    } finally {
      unregisterHolidaysChangedListener('test.failing');
    }
  });
});
