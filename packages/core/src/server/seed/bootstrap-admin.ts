import { emailDomainOf, normalizeEmail } from '../../account';
import { AllowedEmailDomainModel } from '../allowed-email-domains/model';
import { hashPassword } from '../auth/password';
import { UserModel } from '../users/model';
import { isDuplicateKeyError } from './duplicate-key';

// Spec: docs/modules/core.md#bootstrap-system-administrator-account — the first System
// Administrator: a system account (no employee), flagged to change its password on first sign-in.
// It is created only while no System Administrator exists.

/** A seed input problem. The message says what to fix and never contains the password. */
export class SeedInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedInputError';
  }
}

/** True when any user is a System Administrator. */
export async function hasSystemAdministrator(): Promise<boolean> {
  return (await UserModel.exists({ isSystemAdministrator: true })) !== null;
}

export interface CreateBootstrapAdministratorInput {
  email: string;
  password: string;
}

export type CreateBootstrapAdministratorResult =
  | { status: 'created'; email: string }
  /** A System Administrator already existed, or another seed run created one at the same time. */
  | { status: 'exists' };

/**
 * Creates the bootstrap System Administrator, unless one exists. Throws {@link SeedInputError}
 * when the email isn't on an allowed domain, the email belongs to another user (left unchanged),
 * or the password is empty.
 */
export async function createBootstrapAdministrator({
  email,
  password,
}: CreateBootstrapAdministratorInput): Promise<CreateBootstrapAdministratorResult> {
  const normalized = normalizeEmail(email);
  const domain = emailDomainOf(normalized);
  if (!domain) {
    throw new SeedInputError(`SEED_ADMIN_EMAIL "${normalized}" is not an email address.`);
  }
  if (!(await AllowedEmailDomainModel.exists({ domain }))) {
    throw new SeedInputError(
      `SEED_ADMIN_EMAIL is on ${domain}, which is not an allowed email domain. Use an address on an allowed domain, such as sysadmin@xtreme-works.com.`,
    );
  }
  if (password.length === 0) {
    throw new SeedInputError(
      'SEED_ADMIN_PASSWORD is empty. Set it in .env.local or the server environment for the first run.',
    );
  }
  if (await hasSystemAdministrator()) return { status: 'exists' };
  if (await UserModel.exists({ email: normalized })) {
    throw new SeedInputError(
      `${normalized} already belongs to a user who is not a System Administrator. Set SEED_ADMIN_EMAIL to another address; the existing user was not changed.`,
    );
  }

  try {
    await UserModel.create({
      email: normalized,
      passwordHash: await hashPassword(password),
      mustChangePassword: true,
      isSystemAdministrator: true,
      isSystemAccount: true,
      systemAccountDisabled: false,
      employeeId: null,
      createdBy: null,
    });
  } catch (error) {
    // Two seed runs at once: the unique system account index lets only one create it. The same
    // email from the other run is the same race.
    if (
      isDuplicateKeyError(error, 'isSystemAccount') ||
      (isDuplicateKeyError(error, 'email') && (await hasSystemAdministrator()))
    ) {
      return { status: 'exists' };
    }
    throw error;
  }
  return { status: 'created', email: normalized };
}
