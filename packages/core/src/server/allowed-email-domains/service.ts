import { connectDb } from '@pulse/db';
import { emailDomainOf } from '../../account';
import { AllowedEmailDomainModel } from './model';

// Spec: SECURITY.md#sign-in-and-passwords — sign-in and user creation accept only emails on the
// stored allowed email domains. A removed (soft-deleted) domain no longer counts.

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
