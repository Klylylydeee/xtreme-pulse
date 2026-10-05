import type { ClientSession } from 'mongoose';
import { connectDb, withTransaction } from '@pulse/db';
import { emailDomainOf } from '../../account';
import { ActionError } from '../../actions';
import { emailDomainSchema, type EmailDomainInput } from '../../company-details';
import { now } from '../../dates';
import { recordAudit } from '../audit/service';
import { snapshotForAudit, snapshotsForAudit } from '../audit/snapshot';
import type { CurrentUser } from '../auth/session-user';
import { assertSystemAdministrator } from '../auth/roles';
import { toObjectId } from '../paging';
import { isDuplicateKeyError } from '../seed/duplicate-key';
import { UserModel } from '../users/model';
import { AllowedEmailDomainModel } from './model';

// Spec: SECURITY.md#sign-in-and-passwords — sign-in and user creation accept only emails on the
// stored allowed email domains. A removed (soft-deleted) domain no longer counts.
//
// Spec: docs/modules/core.md#company-settings-page — the System Administrator manages the list
// (until module access in step 1.6). Removing a domain is a soft delete (audit `delete`); adding
// a removed domain again restores that record (audit `restore`). The last remaining domain, and
// the acting System Administrator's own domain, can't be removed. Record type
// `core.allowedEmailDomain`.

export type EmailDomainCheck =
  | { allowed: true; domain: string }
  /** `domain` is null when the value isn't an email at all. */
  | { allowed: false; domain: string | null };

/** Whether `email` is on an allowed email domain. The email is normalized first. */
export async function checkEmailDomain(email: string): Promise<EmailDomainCheck> {
  const domain = emailDomainOf(email);
  if (!domain) return { allowed: false, domain: null };
  await connectDb();
  const allowed = (await AllowedEmailDomainModel.exists({ domain })) !== null;
  return allowed ? { allowed: true, domain } : { allowed: false, domain };
}

/**
 * Like {@link checkEmailDomain}, inside a transaction that saves the email: writes the domain
 * record (the same claim as org-claims.ts), so a removal of the domain that overlaps the save
 * conflicts and is retried, and the retry sees the removal. A read alone would let both commit,
 * leaving a new email on a removed domain. The write only bumps the version key, with timestamps
 * off, so the domain doesn't look edited and no audit entry is due.
 */
export async function claimEmailDomain(
  email: string,
  session: ClientSession,
): Promise<EmailDomainCheck> {
  const domain = emailDomainOf(email);
  if (!domain) return { allowed: false, domain: null };
  const result = await AllowedEmailDomainModel.updateOne(
    { domain, deletedAt: null },
    { $inc: { __v: 1 } },
    { session, timestamps: false },
  );
  return result.matchedCount === 1 ? { allowed: true, domain } : { allowed: false, domain };
}

/** The audit record type of an allowed email domain. */
export const ALLOWED_EMAIL_DOMAIN_RECORD_TYPE = 'core.allowedEmailDomain';

const DOMAINS_ONLY = 'Only the System Administrator can manage the allowed email domains.';

/** One allowed domain on the settings page. */
export interface AllowedEmailDomainView {
  id: string;
  domain: string;
  /** User accounts whose email is on this domain (any status). */
  userCount: number;
  createdAt: Date;
}

/** How many user accounts are on each domain, keyed by domain. */
async function userCountsByDomain(): Promise<Map<string, number>> {
  const rows = await UserModel.aggregate<{ _id: string | null; count: number }>([
    { $project: { domain: { $arrayElemAt: [{ $split: ['$email', '@'] }, -1] } } },
    { $group: { _id: '$domain', count: { $sum: 1 } } },
  ]);
  return new Map(
    rows.filter((row) => typeof row._id === 'string').map((row) => [row._id as string, row.count]),
  );
}

/**
 * The allowed email domains, A to Z, each with how many users are on it. System Administrator
 * only ({@link AccessDeniedError}).
 */
export async function listAllowedEmailDomains(
  actor: CurrentUser,
): Promise<AllowedEmailDomainView[]> {
  assertSystemAdministrator(actor, DOMAINS_ONLY);
  await connectDb();
  const [domains, counts] = await Promise.all([
    AllowedEmailDomainModel.find({}, { domain: 1, createdAt: 1 }, { sort: { domain: 1 } }).lean(),
    userCountsByDomain(),
  ]);
  return domains.map((record) => ({
    id: record._id.toHexString(),
    domain: record.domain,
    userCount: counts.get(record.domain) ?? 0,
    createdAt: record.createdAt,
  }));
}

function parseDomain(input: EmailDomainInput): string {
  const parsed = emailDomainSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ActionError(issue?.message ?? 'Enter a domain such as xtreme-works.com.', {
      field: 'domain',
    });
  }
  return parsed.data.domain;
}

function alreadyAllowed(domain: string): ActionError {
  return new ActionError(`${domain} is already allowed.`, { field: 'domain' });
}

/**
 * Allows a new email domain. A domain that was removed is restored (the same record, audit
 * `restore`); a new one is created (audit `create`). System Administrator only. Throws
 * {@link ActionError} on the field `domain` when it is invalid or already allowed.
 */
export async function addAllowedEmailDomain(
  actor: CurrentUser,
  input: EmailDomainInput,
): Promise<AllowedEmailDomainView> {
  assertSystemAdministrator(actor, DOMAINS_ONLY);
  const domain = parseDomain(input);
  const actorId = toObjectId(actor.id);

  try {
    const record = await withTransaction(async (session) => {
      const existing = await AllowedEmailDomainModel.findOne({ domain }, null, {
        session,
        withDeleted: true,
      }).lean();
      if (existing && existing.deletedAt === null) throw alreadyAllowed(domain);

      if (existing) {
        const at = now();
        const set = { deletedAt: null, updatedBy: actorId, updatedAt: at };
        // Filtering on `deletedAt` lets the update reach the removed record.
        const result = await AllowedEmailDomainModel.updateOne(
          { _id: existing._id, deletedAt: { $ne: null } },
          { $set: set },
          { session, timestamps: false },
        );
        if (result.matchedCount !== 1) throw alreadyAllowed(domain);
        const restored = { ...existing, ...set };
        const { before, after } = snapshotsForAudit(AllowedEmailDomainModel, existing, restored);
        await recordAudit(
          {
            actorId: actor.id,
            actorEmail: actor.email,
            module: 'core',
            action: 'restore',
            record: { type: ALLOWED_EMAIL_DOMAIN_RECORD_TYPE, id: existing._id, label: domain },
            before,
            after,
          },
          { session },
        );
        return restored;
      }

      const [created] = await AllowedEmailDomainModel.create(
        [{ domain, createdBy: actorId, updatedBy: actorId }],
        { session },
      );
      if (!created) throw new Error('The domain was not saved.');
      await recordAudit(
        {
          actorId: actor.id,
          actorEmail: actor.email,
          module: 'core',
          action: 'create',
          record: { type: ALLOWED_EMAIL_DOMAIN_RECORD_TYPE, id: created._id, label: domain },
          before: null,
          after: snapshotForAudit(AllowedEmailDomainModel, created),
        },
        { session },
      );
      return created.toObject();
    });
    const counts = await userCountsByDomain();
    return {
      id: record._id.toHexString(),
      domain: record.domain,
      userCount: counts.get(record.domain) ?? 0,
      createdAt: record.createdAt,
    };
  } catch (error) {
    // Another request added the same domain first.
    if (isDuplicateKeyError(error, 'domain')) throw alreadyAllowed(domain);
    throw error;
  }
}

/**
 * Removes an allowed email domain (a soft delete, audit `delete`). Users on it can no longer sign
 * in. System Administrator only. Refused with {@link ActionError} for the last remaining domain
 * and for the domain of the acting System Administrator's own email.
 */
export async function removeAllowedEmailDomain(
  actor: CurrentUser,
  domainId: string,
): Promise<void> {
  assertSystemAdministrator(actor, DOMAINS_ONLY);
  const id = toObjectId(domainId);
  const gone = new ActionError('This domain was already removed. Reload the page.');
  if (!id) throw gone;
  const actorId = toObjectId(actor.id);
  const ownDomain = emailDomainOf(actor.email);

  await withTransaction(async (session) => {
    const existing = await AllowedEmailDomainModel.findOne({ _id: id }, null, { session }).lean();
    if (!existing) throw gone;
    if (existing.domain === ownDomain) {
      throw new ActionError(
        `You can’t remove ${existing.domain}: your own email is on it, so you couldn’t sign in again.`,
      );
    }
    // Write every live domain before counting them. Two removals that each only read the count
    // would both see two domains, remove different ones and commit, leaving none (write skew
    // under snapshot isolation). Writing them all makes concurrent removals conflict, and
    // `withTransaction` retries the loser, which then sees the other's removal. The write only
    // bumps the version key, with timestamps off, so no record looks edited and no audit entry
    // is due (`__v` isn't snapshotted).
    await AllowedEmailDomainModel.updateMany(
      {},
      { $inc: { __v: 1 } },
      { session, timestamps: false },
    );
    const live = await AllowedEmailDomainModel.countDocuments({}, { session });
    if (live <= 1) {
      throw new ActionError(
        `You can’t remove ${existing.domain}: it is the last allowed domain, and nobody could sign in. Add another domain first.`,
      );
    }

    const set = { deletedAt: now(), updatedBy: actorId, updatedAt: now() };
    const result = await AllowedEmailDomainModel.updateOne(
      { _id: id, deletedAt: null },
      { $set: set },
      { session, timestamps: false },
    );
    if (result.matchedCount !== 1) throw gone;
    await recordAudit(
      {
        actorId: actor.id,
        actorEmail: actor.email,
        module: 'core',
        action: 'delete',
        record: { type: ALLOWED_EMAIL_DOMAIN_RECORD_TYPE, id, label: existing.domain },
        before: snapshotForAudit(AllowedEmailDomainModel, existing),
        after: null,
      },
      { session },
    );
  });
}
