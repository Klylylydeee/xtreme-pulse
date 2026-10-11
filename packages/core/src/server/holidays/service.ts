import type { ClientSession, Types } from 'mongoose';
import { connectDb, withTransaction } from '@pulse/db';
import { AccessDeniedError, ActionError } from '../../actions';
import {
  addDays,
  assertBusinessDate,
  type BusinessDate,
  formatDate,
  now,
  startOfBusinessDate,
  toBusinessDate,
} from '../../dates';
import {
  type DeclareHolidayInput,
  declareHolidaySchema,
  HOLIDAY_TYPE_LABELS,
  type HolidayActionInput,
  holidayActionSchema,
  holidayAuditLabel,
  type HolidayInput,
  holidayInputSchema,
  type HolidayScope,
  type HolidaySource,
  type HolidayStatus,
  type HolidayType,
  type HolidayUpdateInput,
  holidayUpdateSchema,
  holidayYearOf,
  holidayYearSchema,
  LEGAL_BASIS_REQUIRED_MESSAGE,
} from '../../holidays';
import { recordAudit } from '../audit/service';
import { snapshotForAudit, snapshotsForAudit } from '../audit/snapshot';
import { canManageHolidays, type RoleHolder } from '../auth/roles';
import { inputError, type OrgStructureActor } from '../departments/service';
import { ACTIVE_EMPLOYEES } from '../employees/active-employees';
import { EmployeeModel } from '../employees/model';
import { MASTER_DATA_COLLATION } from '../master-data-collation';
import { notify } from '../notifications/service';
import { toObjectId } from '../paging';
import { UserModel } from '../users/model';
import { enqueueHolidaysChanged } from './events';
import { type HolidayRecord, HolidayModel } from './model';

// Spec: docs/modules/core.md#holiday-calendar (build step 1.10, decisions 111–132 in
// docs/BUILD_PLAN.md) — the holiday calendar's services.
//
// - `/holidays` is open to every signed-in user. Someone who isn't HR or a System Administrator
//   gets confirmed holidays only, filtered in the query, so a draft never leaves the server.
// - HR and System Administrators add, edit, confirm, declare and delete. Every changing function
//   checks the role itself (`assertCanManageHolidays`), and writes its audit entry (`core.holiday`,
//   labelled `<name> · <YYYY-MM-DD>`) in the change's transaction.
// - Adding makes a draft (source `manual`). Confirming needs a legal basis; Confirm all is refused
//   while any of the year's drafts lacks one, and lists them. Declaring makes a confirmed holiday
//   marked `declared` and notifies every active user except the declarer (never the bootstrap
//   system account) in the same transaction.
// - A date moves only within its year. The same name on the same date, ignoring case, is refused
//   among live holidays; several holidays may share a date.
// - After a change to confirmed holidays commits, `core.holidaysChanged` is enqueued with the
//   affected dates (./events.ts). Changes to drafts enqueue nothing.

export const HOLIDAY_RECORD_TYPE = 'core.holiday';
/** The notification event of a declaration. */
export const HOLIDAY_DECLARED_EVENT = 'core.holidayDeclared';
/** Every holiday notification opens the calendar. */
export const HOLIDAYS_HREF = '/holidays';

/** Who is acting: the signed-in user (a `CurrentUser` fits). */
export type HolidayActor = OrgStructureActor;

const HOLIDAY_GONE = 'This holiday no longer exists. Reload the page.';
const CHANGED_ELSEWHERE =
  'This holiday changed since you opened it. Reload the page and try again.';
const NAME_TAKEN_ON_DATE =
  'There’s already a holiday with this name on this date. Choose another name or date.';
const MOVE_TO_OTHER_YEAR =
  'A holiday can only move within its year. Delete it and add a new one in the other year instead.';
const CONFIRMED_NEEDS_LEGAL_BASIS = 'A confirmed holiday needs its legal basis. Enter it again.';
/** Notifications per `notify()` call (its limit). */
const NOTIFY_BATCH = 5000;

/** Refuses anyone but HR and the System Administrator. */
export function assertCanManageHolidays(actor: RoleHolder | null | undefined): void {
  if (!actor || !canManageHolidays(actor)) {
    throw new AccessDeniedError('Only HR and the System Administrator can manage holidays.');
  }
}

/** The business date a stored holiday falls on. */
export function holidayDateOf(record: Pick<HolidayRecord, 'date'>): BusinessDate {
  return toBusinessDate(record.date);
}

/** The audit label of a stored holiday. */
export function holidayLabelOf(record: Pick<HolidayRecord, 'name' | 'date'>): string {
  return holidayAuditLabel({ name: record.name, date: holidayDateOf(record) });
}

/** Writes a holiday's audit entry in `session`. A null actor is a system action (a scheduled job). */
export async function recordHolidayAudit(
  actor: { id: string; email: string } | null,
  action: 'create' | 'update' | 'delete',
  id: Types.ObjectId,
  label: string,
  snapshots: { before: unknown; after: unknown },
  session: ClientSession,
): Promise<void> {
  await recordAudit(
    {
      actorId: actor?.id ?? null,
      actorEmail: actor?.email ?? null,
      module: 'core',
      action,
      record: { type: HOLIDAY_RECORD_TYPE, id, label },
      before: snapshots.before,
      after: snapshots.after,
    },
    { session },
  );
}

// --- Reading ---------------------------------------------------------------------------------

/** One holiday, as `/holidays` shows it. */
export interface HolidayView {
  id: string;
  name: string;
  /** The Manila day, `YYYY-MM-DD`. */
  date: BusinessDate;
  year: number;
  type: HolidayType;
  scope: HolidayScope;
  location: string | null;
  legalBasis: string | null;
  status: HolidayStatus;
  source: HolidaySource;
  declared: boolean;
  confirmedAt: Date | null;
  /** Send `updatedAt.toISOString()` back as `expectedUpdatedAt` (the stale-form check). */
  updatedAt: Date;
}

function toView(record: HolidayRecord): HolidayView {
  return {
    id: record._id.toHexString(),
    name: record.name,
    date: holidayDateOf(record),
    year: record.year,
    type: record.type,
    scope: record.scope,
    location: record.location ?? null,
    legalBasis: record.legalBasis ?? null,
    status: record.status,
    source: record.source,
    declared: record.declared,
    confirmedAt: record.confirmedAt ?? null,
    updatedAt: record.updatedAt,
  };
}

/** Confirmed only, unless the viewer is HR or a System Administrator. */
function visibleTo(viewer: RoleHolder): Record<string, unknown> {
  return canManageHolidays(viewer) ? {} : { status: 'confirmed' };
}

/**
 * A year's live holidays, by date and then name. HR and System Administrators get drafts too;
 * everyone else gets confirmed holidays only, filtered in the query.
 */
export async function listHolidays(
  viewer: RoleHolder,
  { year }: { year: number },
): Promise<HolidayView[]> {
  const parsedYear = holidayYearSchema.safeParse(year);
  if (!parsedYear.success) return [];
  await connectDb();
  const records = await HolidayModel.find({ year: parsedYear.data, ...visibleTo(viewer) })
    .sort({ date: 1, name: 1, _id: 1 })
    .lean();
  return records.map(toView);
}

/** The years that have a holiday the viewer can see, newest first (for the year picker). */
export async function listHolidayYears(viewer: RoleHolder): Promise<number[]> {
  await connectDb();
  const years = await HolidayModel.distinct('year', visibleTo(viewer));
  return years.map(Number).sort((a, b) => b - a);
}

/** One live holiday the viewer can see, or null (a draft is null for anyone but HR and admins). */
export async function getHoliday(viewer: RoleHolder, id: string): Promise<HolidayView | null> {
  const holidayId = toObjectId(id);
  if (!holidayId) return null;
  await connectDb();
  const record = await HolidayModel.findOne({ _id: holidayId, ...visibleTo(viewer) }).lean();
  return record ? toView(record) : null;
}

/** A holiday already on a date: what the form's non-blocking warning names. */
export interface SameDateHoliday {
  id: string;
  name: string;
  status: HolidayStatus;
}

/**
 * The live holidays on `date`, for the form's warning ("This date already has …"). Leave out the
 * holiday being edited with `exceptId`. HR and the System Administrator only.
 */
export async function findHolidaysOnDate(
  actor: RoleHolder,
  date: BusinessDate,
  { exceptId = null }: { exceptId?: string | null } = {},
): Promise<SameDateHoliday[]> {
  assertCanManageHolidays(actor);
  const day = assertBusinessDate(date);
  await connectDb();
  const filter: Record<string, unknown> = { date: startOfBusinessDate(day) };
  const except = exceptId ? toObjectId(exceptId) : null;
  if (except) filter._id = { $ne: except };
  const records = await HolidayModel.find(filter, { name: 1, status: 1 }).sort({ name: 1 }).lean();
  return records.map((record) => ({
    id: record._id.toHexString(),
    name: record.name,
    status: record.status,
  }));
}

/** A confirmed holiday, as other modules read it (Talent's DTR, Desk's SLA hours, Home). */
export interface ConfirmedHoliday {
  id: string;
  name: string;
  date: BusinessDate;
  type: HolidayType;
  scope: HolidayScope;
  location: string | null;
}

/**
 * The confirmed, live holidays from `from` to `to` (both Manila days, inclusive), by date. The
 * read other modules use; only confirmed holidays affect attendance, leave and payroll. The
 * caller checks its own access: confirmed holidays are open to every signed-in user.
 */
export async function listConfirmedHolidays(
  { from, to }: { from: BusinessDate; to: BusinessDate },
  { session }: { session?: ClientSession } = {},
): Promise<ConfirmedHoliday[]> {
  const start = startOfBusinessDate(assertBusinessDate(from));
  const end = startOfBusinessDate(addDays(assertBusinessDate(to), 1));
  if (end <= start) return [];
  await connectDb();
  const records = await HolidayModel.find({
    status: 'confirmed',
    date: { $gte: start, $lt: end },
  })
    .sort({ date: 1, name: 1, _id: 1 })
    .session(session ?? null)
    .lean();
  return records.map((record) => ({
    id: record._id.toHexString(),
    name: record.name,
    date: holidayDateOf(record),
    type: record.type,
    scope: record.scope,
    location: record.location ?? null,
  }));
}

// --- Changing --------------------------------------------------------------------------------

/** Refuses a name a live holiday on the same date already has, ignoring case. */
async function assertNameFreeOnDate(
  name: string,
  date: Date,
  exceptId: Types.ObjectId | null,
  session: ClientSession,
): Promise<void> {
  const filter: Record<string, unknown> = { date, name };
  if (exceptId) filter._id = { $ne: exceptId };
  const taken = await HolidayModel.findOne(filter, { _id: 1 })
    .collation(MASTER_DATA_COLLATION)
    .session(session)
    .lean();
  if (taken) throw new ActionError(NAME_TAKEN_ON_DATE, { field: 'name' });
}

/** Loads a live holiday in the transaction, or refuses. */
async function loadLiveHoliday(id: string, session: ClientSession): Promise<HolidayRecord> {
  const holidayId = toObjectId(id);
  if (!holidayId) throw new ActionError(HOLIDAY_GONE);
  const record = await HolidayModel.findById(holidayId).session(session).lean();
  if (!record) throw new ActionError(HOLIDAY_GONE);
  return record;
}

/** The stale-form check: refuses when the holiday changed after the sheet loaded it. */
function assertNotStale(record: HolidayRecord, expectedUpdatedAt: string | undefined): void {
  if (expectedUpdatedAt === undefined) return;
  if (record.updatedAt.getTime() !== Date.parse(expectedUpdatedAt)) {
    throw new ActionError(CHANGED_ELSEWHERE);
  }
}

/** Adds a holiday as a draft (source `manual`). The legal basis is optional on a draft. */
export async function createHoliday(
  actor: HolidayActor,
  input: HolidayInput,
): Promise<{ id: string }> {
  assertCanManageHolidays(actor);
  const parsed = holidayInputSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const values = parsed.data;
  const date = startOfBusinessDate(values.date);

  return withTransaction(async (session) => {
    await assertNameFreeOnDate(values.name, date, null, session);
    const [created] = await HolidayModel.create(
      [
        {
          name: values.name,
          date,
          year: holidayYearOf(values.date),
          type: values.type,
          scope: values.scope,
          location: values.location,
          legalBasis: values.legalBasis,
          status: 'draft',
          source: 'manual',
          sourceKey: null,
          declared: false,
          createdBy: toObjectId(actor.id),
        },
      ],
      { session },
    );
    if (!created) throw new Error('The holiday wasn’t created.');
    await recordHolidayAudit(
      actor,
      'create',
      created._id,
      holidayLabelOf(created),
      { before: null, after: snapshotForAudit(HolidayModel, created) },
      session,
    );
    return { id: created._id.toHexString() };
  });
}

/**
 * Edits a holiday: name, date (within its year only), type, scope, location and legal basis.
 * Refuses a stale sheet. A confirmed holiday keeps its legal basis, and its edit enqueues
 * holidays-changed for the old and the new date after the commit. Returns the new `updatedAt`.
 */
export async function updateHoliday(
  actor: HolidayActor,
  input: HolidayUpdateInput,
): Promise<{ updatedAt: string }> {
  assertCanManageHolidays(actor);
  const parsed = holidayUpdateSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const values = parsed.data;
  const date = startOfBusinessDate(values.date);

  const { changedDates, updatedAt } = await withTransaction(async (session) => {
    const before = await loadLiveHoliday(values.id, session);
    assertNotStale(before, values.expectedUpdatedAt);
    if (holidayYearOf(values.date) !== before.year) {
      throw new ActionError(MOVE_TO_OTHER_YEAR, { field: 'date' });
    }
    if (before.status === 'confirmed' && !values.legalBasis) {
      throw new ActionError(CONFIRMED_NEEDS_LEGAL_BASIS, { field: 'legalBasis' });
    }
    await assertNameFreeOnDate(values.name, date, before._id, session);

    await HolidayModel.updateOne(
      { _id: before._id },
      {
        $set: {
          name: values.name,
          date,
          type: values.type,
          scope: values.scope,
          location: values.location,
          legalBasis: values.legalBasis,
          updatedBy: toObjectId(actor.id),
        },
      },
      { session, runValidators: true },
    );
    const after = await HolidayModel.findById(before._id).session(session).lean().orFail();
    await recordHolidayAudit(
      actor,
      'update',
      before._id,
      holidayLabelOf(after),
      snapshotsForAudit(HolidayModel, before, after),
      session,
    );
    return {
      changedDates:
        before.status === 'confirmed' ? [holidayDateOf(before), holidayDateOf(after)] : [],
      updatedAt: after.updatedAt.toISOString(),
    };
  });
  await enqueueHolidaysChanged(changedDates);
  // The sheet sends this back as `expectedUpdatedAt` if it saves or confirms again.
  return { updatedAt };
}

/** Thrown by Confirm all while some of the year's drafts have no legal basis. */
export class HolidayLegalBasisMissingError extends ActionError {
  /** The drafts without a legal basis, by date. */
  readonly drafts: { id: string; name: string; date: BusinessDate }[];
  constructor(drafts: { id: string; name: string; date: BusinessDate }[]) {
    const names = drafts.map((draft) => `${draft.name} (${formatDate(draft.date)})`).join(', ');
    super(
      `${drafts.length === 1 ? 'This draft has' : `${drafts.length} drafts have`} no legal basis yet, so nothing was confirmed: ${names}. Enter each one’s legal basis first.`,
    );
    this.name = 'HolidayLegalBasisMissingError';
    this.drafts = drafts;
  }
}

/** Confirms one draft. It needs a legal basis. Notifies nobody; enqueues holidays-changed. */
export async function confirmHoliday(
  actor: HolidayActor,
  input: HolidayActionInput,
): Promise<void> {
  assertCanManageHolidays(actor);
  const parsed = holidayActionSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const { id, expectedUpdatedAt } = parsed.data;

  const date = await withTransaction(async (session) => {
    const before = await loadLiveHoliday(id, session);
    assertNotStale(before, expectedUpdatedAt);
    if (before.status === 'confirmed') throw new ActionError('This holiday is already confirmed.');
    if (!before.legalBasis) {
      throw new ActionError(
        `Enter the legal basis before confirming ${before.name}. ${LEGAL_BASIS_REQUIRED_MESSAGE}`,
        { field: 'legalBasis' },
      );
    }
    const after = await confirmInSession(actor, before, session);
    return holidayDateOf(after);
  });
  await enqueueHolidaysChanged([date]);
}

/** Sets a draft confirmed and writes its `update` entry, in `session`. */
async function confirmInSession(
  actor: HolidayActor,
  before: HolidayRecord,
  session: ClientSession,
): Promise<HolidayRecord> {
  const actorId = toObjectId(actor.id);
  const result = await HolidayModel.updateOne(
    { _id: before._id, status: 'draft' },
    { $set: { status: 'confirmed', confirmedAt: now(), confirmedBy: actorId, updatedBy: actorId } },
    { session },
  );
  if (result.modifiedCount !== 1) throw new ActionError(CHANGED_ELSEWHERE);
  const after = await HolidayModel.findById(before._id).session(session).lean().orFail();
  await recordHolidayAudit(
    actor,
    'update',
    before._id,
    holidayLabelOf(after),
    snapshotsForAudit(HolidayModel, before, after),
    session,
  );
  return after;
}

/**
 * Confirm all: confirms every live draft of `year` in one transaction, one `update` entry each.
 * Refused, confirming nothing, while any of them has no legal basis
 * ({@link HolidayLegalBasisMissingError} lists them). Notifies nobody; enqueues one
 * holidays-changed job with every date it confirmed.
 */
export async function confirmHolidayYear(
  actor: HolidayActor,
  year: number,
): Promise<{ confirmed: number; dates: BusinessDate[] }> {
  assertCanManageHolidays(actor);
  const parsedYear = holidayYearSchema.safeParse(year);
  if (!parsedYear.success) throw inputError(parsedYear.error.issues);

  const dates = await withTransaction(async (session) => {
    const drafts = await HolidayModel.find({ year: parsedYear.data, status: 'draft' })
      .sort({ date: 1, name: 1, _id: 1 })
      .session(session)
      .lean();
    if (drafts.length === 0) throw new ActionError(`${parsedYear.data} has no drafts to confirm.`);
    const missing = drafts.filter((draft) => !draft.legalBasis);
    if (missing.length > 0) {
      throw new HolidayLegalBasisMissingError(
        missing.map((draft) => ({
          id: draft._id.toHexString(),
          name: draft.name,
          date: holidayDateOf(draft),
        })),
      );
    }
    const confirmed: BusinessDate[] = [];
    for (const draft of drafts) {
      const after = await confirmInSession(actor, draft, session);
      confirmed.push(holidayDateOf(after));
    }
    return confirmed;
  });
  await enqueueHolidaysChanged(dates);
  return { confirmed: dates.length, dates: [...new Set(dates)].sort() };
}

/**
 * The users a declaration notifies: every active user except `exceptUserId`, never the bootstrap
 * system account. Account status is worked out as sign-in does it (SECURITY.md#account-status):
 * an ordinary account is active when its employee's employment status is.
 */
async function activeUsersExcept(
  exceptUserId: Types.ObjectId | null,
  session: ClientSession,
): Promise<Types.ObjectId[]> {
  const filter: Record<string, unknown> = {
    isSystemAccount: { $ne: true },
    employeeId: { $type: 'objectId' },
  };
  if (exceptUserId) filter._id = { $ne: exceptUserId };
  const users = await UserModel.find(filter, { employeeId: 1 }).session(session).lean();
  if (users.length === 0) return [];
  const active = await EmployeeModel.find(
    {
      _id: { $in: users.flatMap((user) => (user.employeeId ? [user.employeeId] : [])) },
      ...ACTIVE_EMPLOYEES,
    },
    { _id: 1 },
  )
    .session(session)
    .lean();
  const activeIds = new Set(active.map((employee) => employee._id.toHexString()));
  return users
    .filter((user) => user.employeeId && activeIds.has(user.employeeId.toHexString()))
    .map((user) => user._id);
}

/**
 * Declares a holiday announced at short notice: created confirmed and `declared`, with a required
 * legal basis, and every active user except the declarer is notified (`core.holidayDeclared`) in
 * the same transaction, so a failed save notifies no one. Enqueues holidays-changed.
 */
export async function declareHoliday(
  actor: HolidayActor,
  input: DeclareHolidayInput,
): Promise<{ id: string; notified: number }> {
  assertCanManageHolidays(actor);
  const parsed = declareHolidaySchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const values = parsed.data;
  const date = startOfBusinessDate(values.date);
  const actorId = toObjectId(actor.id);

  const result = await withTransaction(async (session) => {
    await assertNameFreeOnDate(values.name, date, null, session);
    const at = now();
    const [created] = await HolidayModel.create(
      [
        {
          name: values.name,
          date,
          year: holidayYearOf(values.date),
          type: values.type,
          scope: values.scope,
          location: values.location,
          legalBasis: values.legalBasis,
          status: 'confirmed',
          source: 'manual',
          sourceKey: null,
          declared: true,
          confirmedAt: at,
          confirmedBy: actorId,
          createdBy: actorId,
        },
      ],
      { session },
    );
    if (!created) throw new Error('The holiday wasn’t created.');
    await recordHolidayAudit(
      actor,
      'create',
      created._id,
      holidayLabelOf(created),
      { before: null, after: snapshotForAudit(HolidayModel, created) },
      session,
    );

    const recipients = await activeUsersExcept(actorId, session);
    const where = values.scope === 'local' && values.location ? ` in ${values.location}` : '';
    let notified = 0;
    for (let start = 0; start < recipients.length; start += NOTIFY_BATCH) {
      notified += await notify(
        {
          recipients: recipients.slice(start, start + NOTIFY_BATCH),
          module: 'core',
          event: HOLIDAY_DECLARED_EVENT,
          title: `Holiday declared: ${values.name}`,
          body: `${formatDate(values.date)} is a ${HOLIDAY_TYPE_LABELS[values.type].toLowerCase()}${where} (${values.legalBasis}).`,
          href: HOLIDAYS_HREF,
          record: { type: HOLIDAY_RECORD_TYPE, id: created._id },
        },
        { session },
      );
    }
    return { id: created._id.toHexString(), notified };
  });
  await enqueueHolidaysChanged([values.date]);
  return result;
}

/**
 * Deletes a holiday (a soft delete; no restore screen). A deleted auto-draft keeps its source key,
 * so it isn't drafted again. Deleting a confirmed holiday enqueues holidays-changed.
 */
export async function deleteHoliday(actor: HolidayActor, input: HolidayActionInput): Promise<void> {
  assertCanManageHolidays(actor);
  const parsed = holidayActionSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const { id, expectedUpdatedAt } = parsed.data;

  const changedDates = await withTransaction(async (session) => {
    const before = await loadLiveHoliday(id, session);
    assertNotStale(before, expectedUpdatedAt);
    const result = await HolidayModel.updateOne(
      { _id: before._id, deletedAt: null },
      { $set: { deletedAt: now(), updatedBy: toObjectId(actor.id) } },
      { session },
    );
    if (result.modifiedCount !== 1) throw new ActionError(HOLIDAY_GONE);
    await recordHolidayAudit(
      actor,
      'delete',
      before._id,
      holidayLabelOf(before),
      { before: snapshotForAudit(HolidayModel, before), after: null },
      session,
    );
    return before.status === 'confirmed' ? [holidayDateOf(before)] : [];
  });
  await enqueueHolidaysChanged(changedDates);
}
