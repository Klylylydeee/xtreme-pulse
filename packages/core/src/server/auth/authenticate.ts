import { randomBytes } from 'node:crypto';
import { connectDb } from '@pulse/db';
import { normalizeEmail } from '../../account';
import { checkEmailDomain } from '../allowed-email-domains/service';
import { EmployeeModel } from '../employees/model';
import { UserModel } from '../users/model';
import { resolveAccountStatus } from './account-status';
import { hashPassword, verifyPassword } from './password';

// Spec: SECURITY.md#sign-in-and-passwords — sign-in: lowercase the email, accept only the stored
// allowed domains, verify the argon2id hash, and require an active account
// (SECURITY.md#account-status). Sign-ins are never audit-logged, and nothing here logs.

export type AuthenticateFailure =
  /** The email's domain isn't an allowed email domain. */
  | 'bad-domain'
  /** No such account, or the wrong password. The two are never told apart. */
  | 'invalid'
  /** The password is right but the account is deactivated. */
  | 'inactive';

export type AuthenticateResult =
  { ok: true; userId: string } | { ok: false; code: AuthenticateFailure };

// An unknown email still costs one argon2id verification, so the response time doesn't tell which
// emails have accounts. The dummy hash is made once per process from a random value, with the
// same settings as real hashes, so it matches no password anyone can type.
let dummyHash: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(32).toString('base64url')).catch((error: unknown) => {
    dummyHash = null;
    throw error;
  });
  return dummyHash;
}

/** Checks an email and password. A wrong email or password is a result, never an error. */
export async function authenticate({
  email,
  password,
}: {
  email: string;
  password: string;
}): Promise<AuthenticateResult> {
  const normalized = normalizeEmail(email);
  const domain = await checkEmailDomain(normalized);
  if (!domain.allowed) return { ok: false, code: domain.domain ? 'bad-domain' : 'invalid' };

  await connectDb();
  const user = await UserModel.findOne({ email: normalized }).select('+passwordHash').lean();
  if (!user) {
    await verifyPassword(await getDummyHash(), password);
    return { ok: false, code: 'invalid' };
  }
  if (!(await verifyPassword(user.passwordHash, password))) return { ok: false, code: 'invalid' };

  // Only after a correct password, so the status never tells a guesser anything.
  const employee =
    !user.isSystemAccount && user.employeeId
      ? await EmployeeModel.findById(user.employeeId, { employmentStatus: 1 }).lean()
      : null;
  if (resolveAccountStatus(user, employee) !== 'active') return { ok: false, code: 'inactive' };

  return { ok: true, userId: user._id.toString() };
}
