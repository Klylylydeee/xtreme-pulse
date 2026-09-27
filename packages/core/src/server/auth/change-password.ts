import { isValidObjectId } from 'mongoose';
import { connectDb } from '@pulse/db';
import {
  type ChangePasswordInput,
  changePasswordSchema,
  normalizeEmail,
  SAME_AS_CURRENT,
  SAME_AS_EMAIL,
} from '../../account';
import { ActionError } from '../../actions';
import { UserModel } from '../users/model';
import { hashPassword, verifyPassword } from './password';

// Spec: SECURITY.md#sign-in-and-passwords — users change their own password with the current one.
// The new one follows the password rule, differs from the current password and the email, and
// clears the temporary-password flag. Other sessions are not ended (build step 1.5 decides).
// Errors never contain a password.

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

  user.passwordHash = await hashPassword(newPassword);
  user.mustChangePassword = false;
  user.updatedBy = user._id;
  // STEP 1.3 EXTENSION POINT: audit-log "password changed" (never the value)
  await user.save();
}
