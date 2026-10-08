import type { ClientSession, Types } from 'mongoose';
import { connectDb, withTransaction } from '@pulse/db';
import { ActionError } from '../../actions';
import { now } from '../../dates';
import {
  type ClientInput,
  clientInputSchema,
  type ClientUpdateInput,
  clientUpdateSchema,
  formatTin,
  type PriceDisplay,
  type VatTreatment,
} from '../../master-data';
import { recordAudit } from '../audit/service';
import { snapshotForAudit, snapshotsForAudit } from '../audit/snapshot';
import { countMap, countPipeline, type GroupCount, inputError } from '../departments/service';
import { DepartmentModel } from '../departments/model';
import {
  activeEmployeeMap,
  employeeName,
  isActiveEmployee,
  searchActiveEmployees,
} from '../employees/active-employees';
import { EmployeeModel } from '../employees/model';
import {
  assertEngageOwner,
  assertEngageRead,
  assertEngageWrite,
  type MasterDataActor,
} from '../master-data-access';
import { MASTER_DATA_COLLATION } from '../master-data-collation';
import { toObjectId } from '../paging';
import { ClientContactModel } from './contact-model';
import { type ClientRecord, ClientModel } from './model';
import { type ClientContactView, contactView } from './contacts';
import type { MasterDataOption } from '../master-data-access';
import { auditActor, auditLabel } from '../master-data-audit';
import { ClientSiteModel } from './site-model';
import { type ClientSiteView, siteView } from './sites';

// Spec: docs/modules/core.md#managing-master-data and docs/modules/engage.md#clients-sites-and-contacts
// — clients are Core master data that Engage (and the System Administrator on `/admin/clients`)
// manage through these services. Every function checks Engage access itself (master-data-access.ts),
// and every change writes its audit entry (`core.client`) in the same transaction.
//
// - Names aren't unique: a name matching another client's ignoring case, retired ones included,
//   is refused unless the request confirms it ("Save anyway", `allowDuplicateName`).
// - The owning Account Manager is optional; a new one must be an employee whose account is active
//   (never the system account, which has no employee). An unchanged one who went inactive is kept.
// - Retiring is a soft delete (Engage Owner). It leaves the sites and contacts as they are; a
//   retired client can't be edited, nor get sites or contacts, until it is restored.
// Sites and contacts are in sites.ts and contacts.ts.

const RECORD_TYPE = 'core.client';

const CLIENT_GONE = 'This client no longer exists. Reload the page.';
const ACCOUNT_MANAGER_NOT_ELIGIBLE = 'Choose an employee whose account is active.';

/** A client found by {@link findClientsNamed}. */
export interface ClientNameMatch {
  id: string;
  name: string;
  /** True when the matching client is retired. */
  retired: boolean;
}

/** Clients named `name` ignoring case, retired ones included, except `exceptId`. */
async function clientsNamed(
  name: string,
  exceptId: Types.ObjectId | null,
  session: ClientSession | null,
): Promise<ClientNameMatch[]> {
  const filter: Record<string, unknown> = { name };
  if (exceptId) filter._id = { $ne: exceptId };
  const matches = await ClientModel.find(filter, { name: 1, deletedAt: 1 })
    .setOptions({ withDeleted: true })
    .collation(MASTER_DATA_COLLATION)
    .sort({ _id: 1 })
    .limit(20)
    .session(session)
    .lean();
  return matches.map((client) => ({
    id: client._id.toHexString(),
    name: client.name,
    retired: Boolean(client.deletedAt),
  }));
}

/** Refuses a name another client already has, unless the request confirmed it. */
async function assertNameConfirmed(
  name: string,
  exceptId: Types.ObjectId | null,
  allowDuplicateName: boolean,
  session: ClientSession,
): Promise<void> {
  if (allowDuplicateName) return;
  const matches = await clientsNamed(name, exceptId, session);
  const first = matches[0];
  if (!first) return;
  const which = `“${first.name}”${first.retired ? ' (retired)' : ''}`;
  const more = matches.length > 1 ? ` and ${matches.length - 1} more` : '';
  throw new ActionError(
    `Another client is already named ${which}${more}. Check it isn’t the same client, then choose Save anyway.`,
    { field: 'name' },
  );
}

/** A new Account Manager must be an employee whose account resolves to active. */
async function accountManagerIdFrom(
  value: string | null,
  session: ClientSession,
): Promise<Types.ObjectId | null> {
  if (value === null) return null;
  const id = toObjectId(value);
  if (!id || !(await isActiveEmployee(id, session))) {
    throw new ActionError(ACCOUNT_MANAGER_NOT_ELIGIBLE, { field: 'accountManagerEmployeeId' });
  }
  return id;
}

/** Loads a client in the transaction, retired ones included, or refuses. */
async function loadClient(id: string, session: ClientSession) {
  const clientId = toObjectId(id);
  if (!clientId) throw new ActionError(CLIENT_GONE);
  const client = await ClientModel.findById(clientId, null, { withDeleted: true })
    .session(session)
    .lean();
  if (!client) throw new ActionError(CLIENT_GONE);
  return client;
}

// --- Reading ---------------------------------------------------------------------------------

/** A client, as the list and the edit sheet show it. */
export interface ClientView {
  id: string;
  name: string;
  /** Digits only, or null. */
  tin: string | null;
  /** The TIN in groups of three (`000-000-000-000`), or null. */
  tinDisplay: string | null;
  billingAddress: string | null;
  vatTreatment: VatTreatment;
  priceDisplay: PriceDisplay;
  /** Null means the Fiscal default credit term applies. */
  creditTermsDays: number | null;
  industry: string | null;
  accountManagerEmployeeId: string | null;
  /** The Account Manager's name, or null when none is set (or the record is missing). */
  accountManagerName: string | null;
  /**
   * Whether the Account Manager's account resolves to active, or null when none is set. One who
   * became inactive stays set and shows an "Inactive" badge.
   */
  accountManagerActive: boolean | null;
  notes: string | null;
  /** Live (not removed) sites. */
  siteCount: number;
  /** Live (not removed) contacts. */
  contactCount: number;
  /** When it was retired; null while it is live. */
  retiredAt: Date | null;
  updatedAt: Date;
}

/** A client with its sites and contacts. */
export interface ClientDetailView extends ClientView {
  /** By name; removed ones too when asked. */
  sites: ClientSiteView[];
  /** The primary contact first, then by name; removed ones too when asked. */
  contacts: ClientContactView[];
}

type AccountManagerInfo = { name: string; active: boolean };

async function accountManagersOf(
  clients: ClientRecord[],
): Promise<Map<string, AccountManagerInfo>> {
  const ids = clients.flatMap((client) =>
    client.accountManagerEmployeeId ? [client.accountManagerEmployeeId] : [],
  );
  if (ids.length === 0) return new Map();
  const employees = await EmployeeModel.find(
    { _id: { $in: ids } },
    { firstName: 1, lastName: 1, employmentStatus: 1 },
  ).lean();
  const active = await activeEmployeeMap(employees);
  return new Map(
    employees.map((employee) => {
      const id = employee._id.toHexString();
      return [id, { name: employeeName(employee), active: active.get(id) ?? false }];
    }),
  );
}

function clientView(
  client: ClientRecord,
  managers: Map<string, AccountManagerInfo>,
  siteCount: number,
  contactCount: number,
): ClientView {
  const managerId = client.accountManagerEmployeeId?.toHexString() ?? null;
  const manager = managerId ? managers.get(managerId) : undefined;
  return {
    id: client._id.toHexString(),
    name: client.name,
    tin: client.tin,
    tinDisplay: client.tin ? formatTin(client.tin) : null,
    billingAddress: client.billingAddress,
    vatTreatment: client.vatTreatment,
    priceDisplay: client.priceDisplay,
    creditTermsDays: client.creditTermsDays,
    industry: client.industry,
    accountManagerEmployeeId: managerId,
    accountManagerName: manager?.name ?? null,
    // A manager whose record is missing counts as inactive.
    accountManagerActive: managerId ? (manager?.active ?? false) : null,
    notes: client.notes,
    siteCount,
    contactCount,
    retiredAt: client.deletedAt ?? null,
    updatedAt: client.updatedAt,
  };
}

/** Every live client, by name, with retired ones too when `includeRetired`. Engage Read. */
export async function listClients(
  actor: MasterDataActor,
  { includeRetired = false }: { includeRetired?: boolean } = {},
): Promise<ClientView[]> {
  assertEngageRead(actor);
  await connectDb();

  const clients = await ClientModel.find({}, null, { withDeleted: includeRetired })
    .collation(MASTER_DATA_COLLATION)
    .sort({ name: 1, _id: 1 })
    .lean();
  if (clients.length === 0) return [];
  // The aggregations leave removed sites and contacts out (the soft-delete plugin).
  const [siteCounts, contactCounts, managers] = await Promise.all([
    ClientSiteModel.aggregate<GroupCount>(countPipeline('clientId')).then(countMap),
    ClientContactModel.aggregate<GroupCount>(countPipeline('clientId')).then(countMap),
    accountManagersOf(clients),
  ]);

  return clients.map((client) => {
    const id = client._id.toHexString();
    return clientView(client, managers, siteCounts.get(id) ?? 0, contactCounts.get(id) ?? 0);
  });
}

/**
 * One client (retired or not) with its live sites and contacts, removed ones too when
 * `includeRemoved`, or null when there is no such client. Engage Read.
 */
export async function getClient(
  actor: MasterDataActor,
  id: string,
  { includeRemoved = false }: { includeRemoved?: boolean } = {},
): Promise<ClientDetailView | null> {
  assertEngageRead(actor);
  const clientId = toObjectId(id);
  if (!clientId) return null;
  await connectDb();

  const client = await ClientModel.findById(clientId, null, { withDeleted: true }).lean();
  if (!client) return null;
  const [sites, contacts, managers] = await Promise.all([
    ClientSiteModel.find({ clientId }, null, { withDeleted: includeRemoved })
      .collation(MASTER_DATA_COLLATION)
      .sort({ name: 1, _id: 1 })
      .lean(),
    ClientContactModel.find({ clientId }, null, { withDeleted: includeRemoved })
      .collation(MASTER_DATA_COLLATION)
      .sort({ isPrimary: -1, name: 1, _id: 1 })
      .lean(),
    accountManagersOf([client]),
  ]);
  const liveSites = sites.filter((site) => !site.deletedAt).length;
  const liveContacts = contacts.filter((contact) => !contact.deletedAt).length;

  return {
    ...clientView(client, managers, liveSites, liveContacts),
    sites: sites.map(siteView),
    contacts: contacts.map(contactView),
  };
}

/**
 * Clients named `name` ignoring case, retired ones included (except `exceptId`), for the form's
 * duplicate name warning. Engage Write.
 */
export async function findClientsNamed(
  actor: MasterDataActor,
  name: string,
  exceptId?: string | null,
): Promise<ClientNameMatch[]> {
  assertEngageWrite(actor);
  const trimmed = name.trim();
  if (!trimmed) return [];
  await connectDb();
  return clientsNamed(trimmed, exceptId ? toObjectId(exceptId) : null, null);
}

/** An employee who can be picked as a client's Account Manager. */
export interface AccountManagerOption {
  id: string;
  name: string;
  employeeNumber: string;
  departmentName: string | null;
}

/**
 * Employees whose account resolves to active, from any department, for the Account Manager
 * picker: matched on name or employee number, by last name, at most 20. Engage Write.
 */
export async function searchEligibleAccountManagers(
  actor: MasterDataActor,
  search = '',
): Promise<AccountManagerOption[]> {
  assertEngageWrite(actor);
  await connectDb();

  const eligible = await searchActiveEmployees(search);
  if (eligible.length === 0) return [];
  // A retired department still shows its name.
  const departments = await DepartmentModel.find(
    { _id: { $in: eligible.map((employee) => employee.departmentId) } },
    { name: 1 },
    { withDeleted: true },
  ).lean();
  const departmentNames = new Map(departments.map((d) => [d._id.toHexString(), d.name]));

  return eligible.map((employee) => ({
    id: employee._id.toHexString(),
    name: employeeName(employee),
    employeeNumber: employee.employeeNumber,
    departmentName: departmentNames.get(employee.departmentId.toHexString()) ?? null,
  }));
}

/**
 * Live clients (id and name only), by name, for other modules' client pickers. Any signed-in user
 * may read it (docs/modules/core.md#managing-master-data); the caller checks the sign-in.
 */
export async function listClientOptions(): Promise<MasterDataOption[]> {
  await connectDb();
  const clients = await ClientModel.find({}, { name: 1 })
    .collation(MASTER_DATA_COLLATION)
    .sort({ name: 1, _id: 1 })
    .lean();
  return clients.map((client) => ({ id: client._id.toHexString(), name: client.name }));
}

// --- Changing --------------------------------------------------------------------------------

/** Adds a client. Engage Write. */
export async function createClient(
  actor: MasterDataActor,
  input: ClientInput,
): Promise<{ id: string }> {
  assertEngageWrite(actor);
  const parsed = clientInputSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const { allowDuplicateName, accountManagerEmployeeId, ...fields } = parsed.data;
  const actorId = toObjectId(actor.id);

  return withTransaction(async (session) => {
    await assertNameConfirmed(fields.name, null, allowDuplicateName, session);
    const managerId = await accountManagerIdFrom(accountManagerEmployeeId, session);

    const [created] = await ClientModel.create(
      [{ ...fields, accountManagerEmployeeId: managerId, createdBy: actorId }],
      { session },
    );
    if (!created) throw new Error('The client wasn’t created.');
    await recordAudit(
      {
        ...auditActor(actor),
        module: 'core',
        action: 'create',
        record: { type: RECORD_TYPE, id: created._id, label: auditLabel(created.name) },
        before: null,
        after: snapshotForAudit(ClientModel, created),
      },
      { session },
    );
    return { id: created._id.toHexString() };
  });
}

/**
 * Changes a live client. A new name matching another client's needs `allowDuplicateName`; a new
 * Account Manager must be an employee whose account is active, and an unchanged one is kept as
 * it is. Engage Write.
 */
export async function updateClient(
  actor: MasterDataActor,
  id: string,
  input: ClientUpdateInput,
): Promise<void> {
  assertEngageWrite(actor);
  const parsed = clientUpdateSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const { allowDuplicateName, accountManagerEmployeeId, ...fields } = parsed.data;

  await withTransaction(async (session) => {
    const before = await loadClient(id, session);
    if (before.deletedAt) {
      throw new ActionError('This client is retired. Restore it first to edit it.');
    }
    if (fields.name !== before.name) {
      await assertNameConfirmed(fields.name, before._id, allowDuplicateName, session);
    }
    const unchangedManager =
      (before.accountManagerEmployeeId?.toHexString() ?? null) === accountManagerEmployeeId;
    const managerId = unchangedManager
      ? before.accountManagerEmployeeId
      : await accountManagerIdFrom(accountManagerEmployeeId, session);

    await ClientModel.updateOne(
      { _id: before._id },
      {
        $set: { ...fields, accountManagerEmployeeId: managerId, updatedBy: toObjectId(actor.id) },
      },
      { session, runValidators: true },
    );
    const after = await ClientModel.findById(before._id).session(session).lean().orFail();
    await recordAudit(
      {
        ...auditActor(actor),
        module: 'core',
        action: 'update',
        record: { type: RECORD_TYPE, id: before._id, label: auditLabel(after.name) },
        ...snapshotsForAudit(ClientModel, before, after),
      },
      { session },
    );
  });
}

/** Retires (soft-deletes) a client, leaving its sites and contacts as they are. Engage Owner. */
export async function retireClient(actor: MasterDataActor, id: string): Promise<void> {
  assertEngageOwner(actor);

  await withTransaction(async (session) => {
    const before = await loadClient(id, session);
    if (before.deletedAt) throw new ActionError('This client is already retired.');

    // Filtering on live: an overlapping site or contact change (claimLiveClient) conflicts.
    await ClientModel.updateOne(
      { _id: before._id, deletedAt: null },
      { $set: { deletedAt: now(), updatedBy: toObjectId(actor.id) } },
      { session },
    );
    await recordAudit(
      {
        ...auditActor(actor),
        module: 'core',
        action: 'delete',
        record: { type: RECORD_TYPE, id: before._id, label: auditLabel(before.name) },
        before: snapshotForAudit(ClientModel, before),
        after: null,
      },
      { session },
    );
  });
}

/** Restores a retired client, unchanged, with its sites and contacts. Engage Owner. */
export async function restoreClient(actor: MasterDataActor, id: string): Promise<void> {
  assertEngageOwner(actor);

  await withTransaction(async (session) => {
    const before = await loadClient(id, session);
    if (!before.deletedAt) throw new ActionError('This client isn’t retired.');

    await ClientModel.updateOne(
      { _id: before._id, deletedAt: { $ne: null } },
      { $set: { deletedAt: null, updatedBy: toObjectId(actor.id) } },
      { session },
    );
    const after = await ClientModel.findById(before._id).session(session).lean().orFail();
    await recordAudit(
      {
        ...auditActor(actor),
        module: 'core',
        action: 'restore',
        record: { type: RECORD_TYPE, id: before._id, label: auditLabel(after.name) },
        ...snapshotsForAudit(ClientModel, before, after),
      },
      { session },
    );
  });
}
