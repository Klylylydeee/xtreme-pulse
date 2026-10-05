import { beforeAll, describe, expect, it } from 'vitest';
import mongoose, { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { AccessDeniedError, ActionError } from '../../actions';
import { AuditLogModel } from '../audit/model';
import { resolveModuleAccess } from '../auth/module-access';
import type { CurrentUser } from '../auth/session-user';
import { coreSeedLoaders } from '../seed/loaders';
import { UserModel } from '../users/model';
import { AllowedEmailDomainModel } from './model';
import {
  addAllowedEmailDomain,
  checkEmailDomain,
  listAllowedEmailDomains,
  removeAllowedEmailDomain,
} from './service';

// Allowed email domains (docs/modules/core.md#company-settings-page,
// docs/TESTING.md#core-administration-tests). Made-up data only.

function actor(email: string, overrides: Partial<CurrentUser> = {}): CurrentUser {
  return {
    id: new Types.ObjectId().toHexString(),
    email,
    mustChangePassword: false,
    isSystemAdministrator: true,
    isSystemAccount: false,
    employee: null,
    roles: [],
    // The effective map, as loadSessionUser resolves it.
    moduleAccess: resolveModuleAccess({
      isSystemAdministrator: overrides.isSystemAdministrator ?? true,
    }),
    ...overrides,
  };
}

const admin = actor('admin.test@xtreme-works.com');
const hr = actor('hr.test@xtreme-works.com', { isSystemAdministrator: false, roles: ['hr'] });

async function idOf(domain: string): Promise<string> {
  const record = await AllowedEmailDomainModel.findOne({ domain }, null, { withDeleted: true })
    .lean()
    .orFail();
  return record._id.toHexString();
}

async function entriesFor(id: string) {
  return AuditLogModel.find({
    'record.type': 'core.allowedEmailDomain',
    'record.id': new Types.ObjectId(id),
  })
    .sort({ _id: 1 })
    .lean();
}

beforeAll(async () => {
  await connectDb();
  for (const loader of coreSeedLoaders) await loader.run();
  for (const email of ['one@gmail.com', 'two@gmail.com', 'three@yahoo.com']) {
    await UserModel.create({
      email,
      passwordHash: 'made-up-not-a-hash',
      employeeId: new Types.ObjectId(),
    });
  }
});

describe('allowed email domains', () => {
  it('lists the domains with how many users are on each', async () => {
    const list = await listAllowedEmailDomains(admin);
    expect(list.map((row) => [row.domain, row.userCount])).toEqual([
      ['gmail.com', 2],
      ['xtreme-works.com', 0],
      ['yahoo.com', 1],
    ]);
  });

  it('refuses anyone but the System Administrator and changes nothing', async () => {
    const gmail = await idOf('gmail.com');
    await expect(listAllowedEmailDomains(hr)).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(addAllowedEmailDomain(hr, { domain: 'example.org' })).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    await expect(removeAllowedEmailDomain(hr, gmail)).rejects.toBeInstanceOf(AccessDeniedError);
    expect(await AllowedEmailDomainModel.countDocuments({})).toBe(3);
    expect(await AuditLogModel.countDocuments({ 'record.type': 'core.allowedEmailDomain' })).toBe(
      0,
    );
  });

  it('refuses to remove the acting System Administrator’s own domain', async () => {
    const own = await idOf('xtreme-works.com');
    const error = await removeAllowedEmailDomain(admin, own).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ActionError);
    expect((error as Error).message).toContain('your own email');
    expect((await checkEmailDomain('someone@xtreme-works.com')).allowed).toBe(true);
    expect(await entriesFor(own)).toHaveLength(0);
  });

  it('removes a domain as a soft delete with a delete entry', async () => {
    const gmail = await idOf('gmail.com');
    await removeAllowedEmailDomain(admin, gmail);
    expect((await checkEmailDomain('one@gmail.com')).allowed).toBe(false);
    const stored = await AllowedEmailDomainModel.findById(gmail, null, { withDeleted: true })
      .lean()
      .orFail();
    expect(stored.deletedAt).toBeInstanceOf(Date);

    const entries = await entriesFor(gmail);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: 'delete', after: null, actorEmail: admin.email });
    expect(entries[0]?.before).toMatchObject({ domain: 'gmail.com' });
  });

  it('refuses to remove the last remaining domain', async () => {
    // An admin on another domain, so the own-domain rule doesn't apply.
    const otherAdmin = actor('admin.other@yahoo.com');
    const yahoo = await idOf('yahoo.com');
    await removeAllowedEmailDomain(admin, yahoo);

    const last = await idOf('xtreme-works.com');
    const error = await removeAllowedEmailDomain(otherAdmin, last).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ActionError);
    expect((error as Error).message).toContain('last allowed domain');
    expect(await AllowedEmailDomainModel.countDocuments({})).toBe(1);
    expect(await entriesFor(last)).toHaveLength(0);
  });

  it('restores a removed domain when it is added again, with a restore entry', async () => {
    const gmail = await idOf('gmail.com');
    const view = await addAllowedEmailDomain(admin, { domain: ' @Gmail.COM ' });
    expect(view).toMatchObject({ id: gmail, domain: 'gmail.com', userCount: 2 });
    expect((await checkEmailDomain('one@gmail.com')).allowed).toBe(true);
    expect(
      await AllowedEmailDomainModel.countDocuments({ domain: 'gmail.com' }, { withDeleted: true }),
    ).toBe(1);

    const entries = await entriesFor(gmail);
    expect(entries.map((entry) => entry.action)).toEqual(['delete', 'restore']);
    expect(entries[1]?.after).toMatchObject({ domain: 'gmail.com', deletedAt: null });
  });

  it('adds a new domain with a create entry, and refuses one already allowed', async () => {
    const view = await addAllowedEmailDomain(admin, { domain: 'example.org' });
    expect(view).toMatchObject({ domain: 'example.org', userCount: 0 });
    const entries = await entriesFor(view.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: 'create', before: null });

    const duplicate = await addAllowedEmailDomain(admin, { domain: 'example.org' }).catch(
      (caught: unknown) => caught,
    );
    expect(duplicate).toBeInstanceOf(ActionError);
    expect((duplicate as ActionError).field).toBe('domain');

    const invalid = await addAllowedEmailDomain(admin, { domain: 'not a domain' }).catch(
      (caught: unknown) => caught,
    );
    expect(invalid).toBeInstanceOf(ActionError);
    expect((invalid as ActionError).field).toBe('domain');
    expect(await entriesFor(view.id)).toHaveLength(1);
  });
});

// Two removals at once must not empty the list: each alone sees another domain left, so without
// a shared write both would commit (write skew). docs/modules/core.md#company-settings-page
describe('removals at the same time', () => {
  // An admin on a domain that isn't on the list, so the own-domain rule never applies.
  const outsideAdmin = actor('admin.outside@example.net');

  it('refuses the last domain when another removal commits while it runs', async () => {
    await removeAllowedEmailDomain(admin, await idOf('example.org'));
    // Left: gmail.com and xtreme-works.com. Another request removes gmail.com, not committed yet.
    const session = await mongoose.startSession();
    session.startTransaction({
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
    });
    await AllowedEmailDomainModel.updateOne(
      { domain: 'gmail.com' },
      { $set: { deletedAt: new Date() } },
      { session },
    );
    const last = await idOf('xtreme-works.com');
    const removing = removeAllowedEmailDomain(outsideAdmin, last).catch(
      (caught: unknown) => caught,
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    await session.commitTransaction();
    await session.endSession();

    const error = await removing;
    expect(error).toBeInstanceOf(ActionError);
    expect((error as Error).message).toContain('last allowed domain');
    expect((await checkEmailDomain('someone@xtreme-works.com')).allowed).toBe(true);
    expect(await AllowedEmailDomainModel.countDocuments({})).toBe(1);
  });

  it('lets only one of two removals at once succeed when two domains are left', async () => {
    await addAllowedEmailDomain(admin, { domain: 'gmail.com' });
    const [gmail, works] = [await idOf('gmail.com'), await idOf('xtreme-works.com')];
    const results = await Promise.allSettled([
      removeAllowedEmailDomain(outsideAdmin, gmail),
      removeAllowedEmailDomain(outsideAdmin, works),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await AllowedEmailDomainModel.countDocuments({})).toBe(1);
  });
});
