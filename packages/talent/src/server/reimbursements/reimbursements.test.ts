import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { AccessDeniedError, parsePesos } from '@pulse/core';
import {
  addConfigVersion,
  findStoredFile,
  listConfigVersions,
  openAccessibleFile,
} from '@pulse/core/server';
import type { CreateReimbursementInput } from '../../reimbursements/inputs';
import type { ReimbursementSettings } from '../../reimbursements/schemas';
import {
  RECEIPT_REQUIRED,
  REIMBURSEMENT_NOT_FOUND,
  REIMBURSEMENT_TYPE,
  STALE_REIMBURSEMENT_MESSAGE,
} from '../../reimbursements/views';
import { TIMESHEET_APPROVED_MESSAGE, TIMESHEET_PENDING_MESSAGE } from '../../timesheets/schemas';
import { registerTalentFileAccess } from '../files/registrations';
import { SEED_REIMBURSEMENT_SETTINGS } from '../payroll-settings/seed-data';
import { REIMBURSEMENT_SETTINGS_SETTING } from '../payroll-settings/settings';
import { ReceiptClaimModel } from '../receipt-claims/model';
import {
  auditEntries,
  client,
  currentUser,
  database,
  type Department,
  department,
  pdfFile,
  type Person,
  person,
  pngFile,
  seedPayrollSettings,
  setReportingTo,
  setSeparationDate,
  systemAccount,
} from '../testing/fixtures';
import { TimeEntryModel, TimesheetModel } from '../timesheets/model';
import { getOwnTimesheetView, getTimesheetView } from '../timesheets/service';
import { ReimbursementModel } from './model';
import { addReimbursement, deleteReimbursement, updateReimbursement } from './service';

// The reimbursement line tests (docs/TESTING.md#reimbursement-tests: "Lines", "Limits", "Who sees
// lines", "The receipt file"; build step 2.5, decisions 237–251 in docs/BUILD_PLAN.md). Made-up
// people, merchants and receipts only. "Today" is Monday 2026-09-14, 10:00 Manila, in the cut-off
// 2026-09-11 to 2026-09-25 (the previous one 2026-08-26 to 2026-09-10), with the seeded window of
// one previous cut-off.

let NET: Department;
let HRD: Department;
let hr: Person;
let admin: Person;
let reader: Person;
let boss: Person;
let outsider: Person;
let worker: Person;
let clientId: string;
let storageDir: string;

const TODAY = new Date('2026-09-14T10:00:00+08:00');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(TODAY);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Version A (from 2026-09-01): a parking type that requires the client, an active toll type,
 * and a meal limit of ₱500.00 per day. */
function versionA(): ReimbursementSettings {
  const value = structuredClone(SEED_REIMBURSEMENT_SETTINGS);
  value.types = value.types.map((type) =>
    type.key === 'meal' ? { ...type, limit: { amountCentavos: 50_000, per: 'day' } } : type,
  );
  value.types.push(
    {
      key: 'parking',
      name: 'Parking',
      active: true,
      requiresRoute: false,
      requiresDescription: false,
      requiresClient: true,
      limit: null,
    },
    {
      key: 'toll',
      name: 'Toll',
      active: true,
      requiresRoute: false,
      requiresDescription: false,
      requiresClient: false,
      limit: null,
    },
  );
  return value;
}

/** Version B (from 2026-09-05): toll inactive, and the meal limit ₱500.00 per line. */
function versionB(): ReimbursementSettings {
  const value = versionA();
  value.types = value.types.map((type) => {
    if (type.key === 'toll') return { ...type, active: false };
    if (type.key === 'meal') return { ...type, limit: { amountCentavos: 50_000, per: 'line' } };
    return type;
  });
  return value;
}

async function ensureVersionB(): Promise<void> {
  const versions = await listConfigVersions(REIMBURSEMENT_SETTINGS_SETTING);
  if (versions.some((version) => version.effectiveFrom === '2026-09-05')) return;
  await addConfigVersion(REIMBURSEMENT_SETTINGS_SETTING, {
    effectiveFrom: '2026-09-05',
    value: versionB(),
    source: 'Made-up test policy',
    actorId: null,
  });
}

beforeAll(async () => {
  storageDir = await mkdtemp(path.join(tmpdir(), 'pulse-test-storage-'));
  process.env.FILE_STORAGE_DIR = storageDir;
  await connectDb();
  await TimesheetModel.init();
  await TimeEntryModel.init();
  await ReimbursementModel.init();
  await ReceiptClaimModel.init();
  await seedPayrollSettings();
  await addConfigVersion(REIMBURSEMENT_SETTINGS_SETTING, {
    effectiveFrom: '2026-09-01',
    value: versionA(),
    source: 'Made-up test policy',
    actorId: null,
  });
  NET = await department('Network', 'NET');
  HRD = await department('Human Resource', 'HR');
  hr = await person('Hana', 'Reyes', HRD, { talent: 'write' });
  admin = await person('Ada', 'Admin', NET, { admin: true });
  reader = await person('Rita', 'Lopez', NET, { talent: 'read' });
  boss = await person('Bea', 'Tan', NET);
  outsider = await person('Otto', 'Gomez', NET);
  worker = await person('Wes', 'Lim', NET, { dateHired: '2025-01-01' });
  await setReportingTo(worker, [boss]);
  clientId = await client('Made-up Client Corp');
  registerTalentFileAccess();
});

afterAll(async () => {
  await rm(storageDir, { recursive: true, force: true });
});

let count = 0;
async function employee(dateHired = '2025-01-01'): Promise<Person> {
  count += 1;
  return person('Test', `Person${count}`, NET, { dateHired });
}

let receiptCount = 0;
function freshReceipt() {
  receiptCount += 1;
  return {
    merchantTin: String(300_000_000 + receiptCount),
    receiptNumber: `SI-${receiptCount}`,
  };
}

async function timesheetOf(p: Person, cutOff?: string): Promise<string> {
  const view = await getOwnTimesheetView(p.actor, cutOff ? { cutOff } : {});
  if (!view?.timesheet.id) throw new Error('No timesheet.');
  return view.timesheet.id;
}

type LineValues = Omit<CreateReimbursementInput, 'timesheetId'>;

function lineValues(values: Partial<LineValues> = {}): LineValues {
  return {
    typeKey: 'meal',
    receiptDate: '2026-09-12',
    merchant: 'Made-up Diner',
    amountCentavos: 25_000,
    clientId: null,
    pickUp: null,
    dropOff: null,
    description: null,
    ...freshReceipt(),
    ...values,
  };
}

async function add(
  p: Person,
  values: Partial<LineValues> = {},
  { cutOff, file = pngFile('receipt.png') }: { cutOff?: string; file?: File | null } = {},
) {
  return addReimbursement(
    p.actor,
    { timesheetId: await timesheetOf(p, cutOff), ...lineValues(values) },
    file,
  );
}

async function storedLine(id: string) {
  return database()
    .collection('reimbursements')
    .findOne({ _id: new Types.ObjectId(id) });
}

describe('lines', () => {
  it('requires the receipt file', async () => {
    const p = await employee();
    await expect(add(p, {}, { file: null })).rejects.toThrow(RECEIPT_REQUIRED);
    await expect(add(p, {}, { file: new File([], 'empty.png') })).rejects.toThrow(RECEIPT_REQUIRED);
  });

  it('requires each type’s fields', async () => {
    const p = await employee();
    await expect(add(p, { typeKey: 'transportation' })).rejects.toThrow('pick-up');
    await expect(add(p, { typeKey: 'transportation', pickUp: 'Office' })).rejects.toThrow(
      'drop-off',
    );
    await expect(
      add(p, { typeKey: 'transportation', pickUp: 'Office', dropOff: 'Client site' }),
    ).resolves.toBeTruthy();
    await expect(add(p, { typeKey: 'other' })).rejects.toThrow('description');
    await expect(
      add(p, { typeKey: 'other', description: 'Printer paper for the site' }),
    ).resolves.toBeTruthy();
    await expect(add(p, { typeKey: 'parking' })).rejects.toThrow('Choose the client');
    await expect(add(p, { typeKey: 'parking', clientId })).resolves.toBeTruthy();
    await expect(add(p, { typeKey: 'nonsense' })).rejects.toThrow('Choose a type');
  });

  it('drops a route the type doesn’t ask for, and refuses a client that isn’t live', async () => {
    const p = await employee();
    const saved = await add(p, { pickUp: 'Home', dropOff: 'Office', description: 'Lunch' });
    expect(await storedLine(saved.id)).toMatchObject({
      pickUp: null,
      dropOff: null,
      description: 'Lunch',
    });
    await expect(add(p, { clientId: new Types.ObjectId().toHexString() })).rejects.toThrow(
      'Choose a client from the list.',
    );
  });

  it('refuses an inactive type for a new line, and keeps a stored one on edit', async () => {
    const p = await employee();
    const toll = await add(p, { typeKey: 'toll' });
    await ensureVersionB();
    await expect(add(p, { typeKey: 'toll' })).rejects.toThrow('no longer used');
    const edited = await updateReimbursement(p.actor, {
      reimbursementId: toll.id,
      version: toll.version,
      ...lineValues({ typeKey: 'toll', merchant: 'Made-up Tollway' }),
    });
    expect(edited.version).toBe(2);
    // Changing another line to the inactive type is refused.
    const meal = await add(p);
    await expect(
      updateReimbursement(p.actor, {
        reimbursementId: meal.id,
        version: meal.version,
        ...lineValues({ typeKey: 'toll' }),
      }),
    ).rejects.toThrow('no longer used');
  });

  it('takes the amount as positive whole centavos', async () => {
    const p = await employee();
    for (const amountCentavos of [0, -100, 12.5]) {
      await expect(add(p, { amountCentavos })).rejects.toThrow();
    }
    expect(parsePesos('1,234.50')).toBe(123_450);
    expect(() => parsePesos('12.345')).toThrow('2 decimal places');
    const saved = await add(p, { amountCentavos: parsePesos('1,234.50') });
    expect((await storedLine(saved.id))?.amountCentavos).toBe(123_450);
  });

  it('refuses a TIN that isn’t 9, 12 or 14 digits, and stores the canonical 14', async () => {
    const p = await employee();
    await expect(add(p, { merchantTin: '1234567' })).rejects.toThrow('9, 12 or 14 digits');
    await expect(add(p, { receiptNumber: '--' })).rejects.toThrow('letter or digit');
    const saved = await add(p, { merchantTin: '444-555-666-001', receiptNumber: 'si 00042' });
    expect(await storedLine(saved.id)).toMatchObject({
      merchantTin: '44455566600001',
      receiptNumber: 'si 00042',
    });
  });
});

describe('the filing window', () => {
  it('takes receipts from the start of the previous cut-off to today', async () => {
    const p = await employee();
    await expect(add(p, { receiptDate: '2026-08-26' })).resolves.toBeTruthy();
    await expect(add(p, { receiptDate: '2026-08-25' })).rejects.toThrow('must be dated');
    await expect(add(p, { receiptDate: '2026-09-14' })).resolves.toBeTruthy();
    await expect(add(p, { receiptDate: '2026-09-15' })).rejects.toThrow('after today');
  });

  it('refuses a receipt before the date hired or after the separation date', async () => {
    const fresh = await employee('2026-09-01');
    await expect(add(fresh, { receiptDate: '2026-08-31' })).rejects.toThrow('date hired');
    await expect(add(fresh, { receiptDate: '2026-09-01' })).resolves.toBeTruthy();
    const leaving = await employee();
    await setSeparationDate(leaving, '2026-09-12');
    await expect(add(leaving, { receiptDate: '2026-09-13' })).rejects.toThrow('separation date');
    await expect(add(leaving, { receiptDate: '2026-09-12' })).resolves.toBeTruthy();
  });

  it('adds only to the current and previous timesheets, and edits on an older one', async () => {
    const p = await employee();
    // Back on 2026-08-20, the cut-off 2026-08-11 to 2026-08-25 is the current one.
    vi.setSystemTime(new Date('2026-08-20T10:00:00+08:00'));
    const old = await add(p, { receiptDate: '2026-08-15' }, { cutOff: '2026-08-11' });
    vi.setSystemTime(TODAY);
    await expect(add(p, { receiptDate: '2026-08-15' }, { cutOff: '2026-08-11' })).rejects.toThrow(
      'New reimbursements go on',
    );
    await expect(
      add(p, { receiptDate: '2026-08-27' }, { cutOff: '2026-08-26' }),
    ).resolves.toBeTruthy();
    const edited = await updateReimbursement(p.actor, {
      reimbursementId: old.id,
      version: old.version,
      ...lineValues({ receiptDate: '2026-08-15', merchant: 'Made-up Diner, fixed' }),
    });
    expect(edited.version).toBe(2);
  });

  it.each([
    ['pendingSupervisor', TIMESHEET_PENDING_MESSAGE],
    ['pendingHr', TIMESHEET_PENDING_MESSAGE],
    ['approved', TIMESHEET_APPROVED_MESSAGE],
  ])('refuses a line on a %s timesheet (step 2.7’s lock)', async (status, message) => {
    const p = await employee();
    const line = await add(p);
    const timesheetId = await timesheetOf(p);
    await database()
      .collection('timesheets')
      .updateOne({ _id: new Types.ObjectId(timesheetId) }, { $set: { status } });
    await expect(add(p)).rejects.toThrow(message);
    await expect(
      updateReimbursement(p.actor, {
        reimbursementId: line.id,
        version: line.version,
        ...lineValues(),
      }),
    ).rejects.toThrow(message);
    await expect(
      deleteReimbursement(p.actor, { reimbursementId: line.id, version: line.version }),
    ).rejects.toThrow(message);
  });

  it('lets a returned timesheet’s lines change again', async () => {
    const p = await employee();
    const line = await add(p);
    const timesheetId = await timesheetOf(p);
    await database()
      .collection('timesheets')
      .updateOne({ _id: new Types.ObjectId(timesheetId) }, { $set: { status: 'returned' } });
    const edited = await updateReimbursement(p.actor, {
      reimbursementId: line.id,
      version: line.version,
      ...lineValues({ merchant: 'Made-up Diner, fixed' }),
    });
    expect(edited.version).toBe(line.version + 1);
  });
});

describe('saves', () => {
  it('refuses a stale version', async () => {
    const p = await employee();
    const line = await add(p);
    await updateReimbursement(p.actor, {
      reimbursementId: line.id,
      version: line.version,
      ...lineValues(),
    });
    await expect(
      updateReimbursement(p.actor, {
        reimbursementId: line.id,
        version: line.version,
        ...lineValues(),
      }),
    ).rejects.toThrow(STALE_REIMBURSEMENT_MESSAGE);
    await expect(
      deleteReimbursement(p.actor, { reimbursementId: line.id, version: line.version }),
    ).rejects.toThrow(STALE_REIMBURSEMENT_MESSAGE);
  });

  it('never finds another person’s line, HR and the System Administrator included', async () => {
    const line = await add(worker);
    for (const who of [hr, admin, reader, boss, outsider]) {
      await expect(
        updateReimbursement(who.actor, {
          reimbursementId: line.id,
          version: line.version,
          ...lineValues(),
        }),
      ).rejects.toThrow(REIMBURSEMENT_NOT_FOUND);
      await expect(
        deleteReimbursement(who.actor, { reimbursementId: line.id, version: line.version }),
      ).rejects.toThrow(REIMBURSEMENT_NOT_FOUND);
    }
    // Nor can anyone add to another person's timesheet.
    await expect(
      addReimbursement(
        hr.actor,
        { timesheetId: await timesheetOf(worker), ...lineValues() },
        pngFile(),
      ),
    ).rejects.toThrow('can’t be found');
    const system = await systemAccount();
    await expect(
      addReimbursement(
        system,
        { timesheetId: await timesheetOf(worker), ...lineValues() },
        pngFile(),
      ),
    ).rejects.toThrow(AccessDeniedError);
  });

  it('touches the timesheet, soft deletes, and audits each create, update and delete', async () => {
    const p = await employee();
    const timesheetId = new Types.ObjectId(await timesheetOf(p));
    const sheet = () => database().collection('timesheets').findOne({ _id: timesheetId });
    const v0 = (await sheet())?.__v as number;

    const line = await add(p, { receiptDate: '2026-09-13' });
    const v1 = (await sheet())?.__v as number;
    expect(v1).toBeGreaterThan(v0);
    const edited = await updateReimbursement(p.actor, {
      reimbursementId: line.id,
      version: line.version,
      ...lineValues({ receiptDate: '2026-09-13', merchant: 'Made-up Bakery' }),
    });
    const v2 = (await sheet())?.__v as number;
    expect(v2).toBeGreaterThan(v1);
    await deleteReimbursement(p.actor, { reimbursementId: line.id, version: edited.version });
    expect((await sheet())?.__v as number).toBeGreaterThan(v2);

    const stored = await storedLine(line.id);
    expect(stored?.deletedAt).toBeInstanceOf(Date);
    const entries = (await auditEntries(REIMBURSEMENT_TYPE)).filter(
      (entry) => String(entry.record.id) === line.id,
    );
    expect(entries.map((entry) => entry.action)).toEqual(['create', 'update', 'delete']);
    for (const entry of entries) {
      expect(entry.record.label).toBe(`${p.employeeNumber} · 2026-09-13`);
      expect(entry.module).toBe('talent');
    }
  });

  it('writes nothing for a refused save', async () => {
    const p = await employee();
    const before = await Promise.all([
      database().collection('reimbursements').countDocuments(),
      database().collection('receiptClaims').countDocuments(),
      database().collection('auditLogs').countDocuments(),
    ]);
    await expect(add(p, { typeKey: 'other' })).rejects.toThrow();
    const after = await Promise.all([
      database().collection('reimbursements').countDocuments(),
      database().collection('receiptClaims').countDocuments(),
      database().collection('auditLogs').countDocuments(),
    ]);
    expect(after).toEqual(before);
  });
});

describe('limits', () => {
  it('flags each line of a day over the daily limit, across timesheets, and still saves them', async () => {
    const p = await employee();
    // 2026-09-03 is in version A: ₱500.00 per day.
    const first = await add(
      p,
      { receiptDate: '2026-09-03', amountCentavos: 30_000 },
      { cutOff: '2026-08-26' },
    );
    expect(first.overLimit).toBeNull();
    const second = await add(p, { receiptDate: '2026-09-03', amountCentavos: 25_000 });
    expect(second.overLimit).toEqual({ limitCentavos: 50_000, per: 'day', excessCentavos: 5_000 });

    const previous = await getOwnTimesheetView(p.actor, { cutOff: '2026-08-26' });
    const current = await getOwnTimesheetView(p.actor);
    const flagged = [
      ...(previous?.reimbursements.groups.flatMap((group) => group.lines) ?? []),
      ...(current?.reimbursements.groups.flatMap((group) => group.lines) ?? []),
    ].filter((line) => line.receiptDate === '2026-09-03');
    expect(flagged).toHaveLength(2);
    for (const line of flagged) expect(line.overLimit?.excessCentavos).toBe(5_000);
  });

  it('uses the receipt date’s version: per line from 2026-09-05, none before 2026-09-01', async () => {
    await ensureVersionB();
    const p = await employee();
    const small = await add(p, { receiptDate: '2026-09-12', amountCentavos: 30_000 });
    const also = await add(p, { receiptDate: '2026-09-12', amountCentavos: 25_000 });
    const big = await add(p, { receiptDate: '2026-09-12', amountCentavos: 60_000 });
    expect(small.overLimit).toBeNull();
    expect(also.overLimit).toBeNull();
    expect(big.overLimit).toEqual({ limitCentavos: 50_000, per: 'line', excessCentavos: 10_000 });
    const unlimited = await add(p, { receiptDate: '2026-08-28', amountCentavos: 90_000 });
    expect(unlimited.overLimit).toBeNull();
  });
});

describe('who sees lines', () => {
  it('shows them read-only to Talent Read and a supervisor, and refuses anyone else', async () => {
    const line = await add(worker, { receiptDate: '2026-09-11', merchant: 'Made-up Grill' });
    const own = await getOwnTimesheetView(worker.actor);
    expect(own?.reimbursements).toMatchObject({
      canAdd: true,
      canEdit: true,
      window: { from: '2026-08-26', to: '2026-09-14' },
    });
    expect(own?.reimbursements.types?.map((type) => type.key)).toContain('meal');
    expect(own?.reimbursements.count).toBeGreaterThan(0);

    for (const viewer of [reader, boss]) {
      const view = await getTimesheetView(viewer.actor, worker.employeeId);
      const lines = view?.reimbursements.groups.flatMap((group) => group.lines) ?? [];
      expect(lines.map((l) => l.id)).toContain(line.id);
      expect(view?.reimbursements).toMatchObject({ canAdd: false, canEdit: false, window: null });
      expect(view?.reimbursements.types).toBeUndefined();
    }
    await expect(getTimesheetView(outsider.actor, worker.employeeId)).rejects.toThrow(
      AccessDeniedError,
    );
  });

  it('groups by receipt date, newest first, with the footer total', async () => {
    const p = await employee();
    await add(p, { receiptDate: '2026-09-11', amountCentavos: 10_000 });
    await add(p, { receiptDate: '2026-09-13', amountCentavos: 20_050 });
    await add(p, { receiptDate: '2026-09-11', amountCentavos: 5_000, clientId });
    const view = await getOwnTimesheetView(p.actor);
    const section = view?.reimbursements;
    expect(section?.groups.map((group) => group.receiptDate)).toEqual(['2026-09-13', '2026-09-11']);
    expect(section?.totalCentavos).toBe(35_050);
    expect(section?.count).toBe(3);
    const withClient = section?.groups[1]?.lines.find((line) => line.client);
    expect(withClient?.client?.name).toBe('Made-up Client Corp');
    expect(withClient?.typeName).toBe('Meal');
  });
});

describe('the receipt file', () => {
  async function receiptFileOf(id: string): Promise<string> {
    const line = await storedLine(id);
    return String(line?.receiptFileId);
  }

  async function opens(viewer: Person, fileId: string): Promise<boolean> {
    const opened = await openAccessibleFile(currentUser(viewer), fileId);
    await opened?.stream.cancel();
    return opened !== null;
  }

  it('opens for the employee, Talent Read and a supervisor only', async () => {
    const line = await add(worker);
    const fileId = await receiptFileOf(line.id);
    expect(await opens(worker, fileId)).toBe(true);
    expect(await opens(reader, fileId)).toBe(true);
    expect(await opens(boss, fileId)).toBe(true);
    expect(await opens(outsider, fileId)).toBe(false);
    // Talent Write includes Talent Read.
    expect(await opens(hr, fileId)).toBe(true);
  });

  it('stores a photo as WebP and a PDF as uploaded', async () => {
    const photo = await add(worker);
    expect((await findStoredFile(await receiptFileOf(photo.id)))?.contentType).toBe('image/webp');
    const pdf = await add(worker, {}, { file: pdfFile('receipt.pdf') });
    const stored = await findStoredFile(await receiptFileOf(pdf.id));
    expect(stored?.contentType).toBe('application/pdf');
    const view = await getOwnTimesheetView(worker.actor);
    const shown = view?.reimbursements.groups
      .flatMap((group) => group.lines)
      .find((line) => line.id === pdf.id);
    expect(shown?.receipt.isPdf).toBe(true);
  });

  it('no longer opens once replaced, or after the line is deleted', async () => {
    const line = await add(worker);
    const oldFile = await receiptFileOf(line.id);
    const edited = await updateReimbursement(
      worker.actor,
      { reimbursementId: line.id, version: line.version, ...lineValues() },
      pdfFile('new-receipt.pdf'),
    );
    const newFile = await receiptFileOf(line.id);
    expect(newFile).not.toBe(oldFile);
    expect(await opens(worker, oldFile)).toBe(false);
    expect(await opens(worker, newFile)).toBe(true);
    await deleteReimbursement(worker.actor, {
      reimbursementId: line.id,
      version: edited.version,
    });
    expect(await opens(worker, newFile)).toBe(false);
    expect(await opens(reader, newFile)).toBe(false);
  });
});
