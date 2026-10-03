import { isValidObjectId } from 'mongoose';
import { connectDb, withTransaction } from '@pulse/db';
import {
  type ChangePasswordInput,
  changePasswordSchema,
  normalizeEmail,
  SAME_AS_CURRENT,
  SAME_AS_EMAIL,
} from '../../account';
import { ActionError } from '../../actions';
import { now } from '../../dates';
import { recordAudit } from '../audit/service';
import { snapshotForAudit } from '../audit/snapshot';
import { UserModel } from '../users/model';
import { hashPassword, verifyPassword } from './password';

// Spec: SECURITY.md#sign-in-and-passwords — users change their own password with the current one.
// The new one follows the password rule, differs from the current password and the email, and
// clears the temporary-password flag. Other sessions are not ended (build step 1.5 decides).
// Errors never contain a password.
//
// The change is audit-logged (SECURITY.md#audit-logging) in the same transaction as the write, so
// a password never changes without its `passwordChange` entry: if the entry can't be written, the
// password stays as it was. The entry's snapshots never hold the password or its hash
// (`passwordHash` has `select: false`, which snapshotForAudit leaves out).

const SIGN_IN_AGAIN = 'Sign in again, then change your password.';

/** Changes the signed-in user's password. Throws {@link ActionError} for the form to show. */
export async function changePassword(userId: string, input: ChangePasswordInput): Promise<void> {
  // The action has validated already; the service still holds the rule itself.
  const parsed = changePasswordSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.map(String).join('.') || undefined;
    throw new ActionError(issue?.message ?? 'Check the form and try again.', { field });
  }
  const { currentPassword, newPassword } = parsed.data;

  if (!isValidObjectId(userId)) throw new ActionError(SIGN_IN_AGAIN);
  await connectDb();
  const user = await UserModel.findById(userId).select('+passwordHash');
  if (!user) throw new ActionError(SIGN_IN_AGAIN);

  if (!(await verifyPassword(user.passwordHash, currentPassword))) {
    throw new ActionError('Your current password isn’t right.', { field: 'currentPassword' });
  }
  if (newPassword === currentPassword) {
    throw new ActionError(SAME_AS_CURRENT, { field: 'newPassword' });
  }
  if (normalizeEmail(newPassword) === user.email) {
    throw new ActionError(SAME_AS_EMAIL, { field: 'newPassword' });
  }

  const before = snapshotForAudit(UserModel, user);
  const passwordHash = await hashPassword(newPassword);
  // The same values go into the write and the `after` snapshot, `updatedAt` included.
  const changes = {
    passwordHash,
    mustChangePassword: false,
    updatedBy: user._id,
    updatedAt: now(),
  };
  user.set(changes);
  const after = snapshotForAudit(UserModel, user);

  await withTransaction(async (session) => {
    // An update, not `user.save()`: `withTransaction` may run this callback again, and a retried
    // save would find nothing modified and skip the write.
    await UserModel.updateOne({ _id: user._id }, { $set: changes }, { session, timestamps: false });
    await recordAudit(
      {
        actorId: user._id,
        actorEmail: user.email,
        module: 'core',
        action: 'passwordChange',
        record: { type: 'core.user', id: user._id, label: user.email },
        before,
        after,
      },
      { session },
    );
  });
}
