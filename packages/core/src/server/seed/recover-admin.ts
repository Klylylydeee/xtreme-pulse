import { connectDb, withTransaction } from '@pulse/db';
import { now } from '../../dates';
import { recordAudit } from '../audit/service';
import { snapshotsForAudit } from '../audit/snapshot';
import { activeHrAndSystemAdministrators } from '../auth/admin-recipients';
import { hashPassword } from '../auth/password';
import { UserModel } from '../users/model';
import { SeedInputError } from './bootstrap-admin';

// Spec: SECURITY.md#system-administrator and docs/RUNBOOK.md#the-only-system-administrator-is-disabled
// — `pnpm recover:admin` (decision 75). When no System Administrator is active, it re-enables the
// bootstrap system account with a temporary password (SEED_ADMIN_PASSWORD), sets
// `mustChangePassword`, ends the account's old sessions (`sessionsValidFrom`) and writes an
// `update` entry on its `core.user` record with no actor (a system action). It refuses while any
// System Administrator is active. The password is never logged, returned or put in the entry.

const SYSTEM_ADMINISTRATOR_ACTIVE =
  'A System Administrator is still active, so nothing was changed. Ask them to reset the password or re-enable the account on /admin/users.';
const NO_SYSTEM_ACCOUNT =
  'There is no bootstrap system account to recover. Nothing was changed; see docs/RUNBOOK.md.';

export type RecoverSystemAdministratorResult = { status: 'recovered'; email: string };

/**
 * Re-enables the bootstrap system account with `password` as a temporary password. Throws
 * {@link SeedInputError} when the password is empty, any System Administrator is active, or there
 * is no system account; nothing is changed then.
 */
export async function recoverSystemAdministrator({
  password,
}: {
  password: string;
}): Promise<RecoverSystemAdministratorResult> {
  if (password.length === 0) {
    throw new SeedInputError(
      'SEED_ADMIN_PASSWORD is empty. Set a new one in the server environment to recover.',
    );
  }
  await connectDb();
  // Hashed once, before the transaction, so a retried transaction reuses it.
  const passwordHash = await hashPassword(password);

  return withTransaction(async (session) => {
    // Write every System Administrator's record first, as the never-zero guard does, so a change
    // in the app at the same time conflicts and one of the two is retried.
    const administrators = { $or: [{ isSystemAdministrator: true }, { isSystemAccount: true }] };
    await UserModel.updateMany(
      administrators,
      { $inc: { __v: 1 } },
      { session, timestamps: false },
    );

    const active = await activeHrAndSystemAdministrators(session);
    if (active.some((recipient) => recipient.isSystemAdministrator)) {
      throw new SeedInputError(SYSTEM_ADMINISTRATOR_ACTIVE);
    }
    const before = await UserModel.findOne({ isSystemAccount: true }).session(session).lean();
    if (!before) throw new SeedInputError(NO_SYSTEM_ACCOUNT);

    const at = now();
    const changes = {
      systemAccountDisabled: false,
      isSystemAdministrator: true,
      mustChangePassword: true,
      sessionsValidFrom: at,
      updatedBy: null,
      updatedAt: at,
    };
    await UserModel.updateOne(
      { _id: before._id },
      { $set: { ...changes, passwordHash } },
      { session, timestamps: false },
    );
    // Both sides from the record without the hash, which has `select: false` anyway.
    await recordAudit(
      {
        actorId: null,
        actorEmail: null,
        module: 'core',
        action: 'update',
        record: { type: 'core.user', id: before._id, label: before.email },
        ...snapshotsForAudit(UserModel, before, { ...before, ...changes }),
      },
      { session },
    );
    return { status: 'recovered' as const, email: before.email };
  });
}
