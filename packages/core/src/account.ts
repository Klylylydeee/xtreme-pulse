import { z } from 'zod';

// Account rules shared by the server and the browser (sign-in form, user sheet).

// Spec: SECURITY.md#sign-in-and-passwords — the default allowed email domains. `pnpm seed:admin`
// loads them into the stored allowed email domains (`allowedEmailDomains`); the stored records are
// what sign-in and user creation check, and the System Administrator can change them.
export const ALLOWED_EMAIL_DOMAINS = ['xtreme-works.com', 'gmail.com', 'yahoo.com'] as const;
export type AllowedEmailDomain = (typeof ALLOWED_EMAIL_DOMAINS)[number];

// Spec: SECURITY.md#account-status — account status is derived from employment status, never set
// on its own. The bootstrap system account has no employment status; see
// docs/modules/core.md#bootstrap-system-administrator-account.
export const EMPLOYMENT_STATUS = {
  Probationary: 'active',
  Regular: 'active',
  Contractual: 'active',
  Resigned: 'deactivated',
  Terminated: 'deactivated',
  Retired: 'deactivated',
} as const;

export type EmploymentStatus = keyof typeof EMPLOYMENT_STATUS;
export type AccountStatus = (typeof EMPLOYMENT_STATUS)[EmploymentStatus];

/** Every employment status, in the order above. */
export const EMPLOYMENT_STATUSES = Object.keys(EMPLOYMENT_STATUS) as EmploymentStatus[];

/** Emails are stored and compared lowercase and trimmed (SECURITY.md#sign-in-and-passwords). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const DOMAIN_LABEL = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?';
const DOMAIN = `${DOMAIN_LABEL}(?:\\.${DOMAIN_LABEL})+`;

/** A lowercase email domain without the `@`, for example `xtreme-works.com`. */
export const EMAIL_DOMAIN_PATTERN = new RegExp(`^${DOMAIN}$`);

// One `@`, something before it, and a dotted domain after it. Deliverability isn't checked: the
// account is created by HR or the System Administrator, never by self-registration.
const EMAIL_SHAPE = new RegExp(`^[^\\s@]+@(${DOMAIN})$`);

/** The lowercase domain of `email` (`Ana@Gmail.com` → `gmail.com`), or null if it isn't an email. */
export function emailDomainOf(email: string): string | null {
  return EMAIL_SHAPE.exec(normalizeEmail(email))?.[1] ?? null;
}

// Spec: SECURITY.md#sign-in-and-passwords — a session lasts this long from sign-in. The limit is
// absolute (activity doesn't extend it). It can be made longer, never shorter.
export const SESSION_MAX_AGE_HOURS = 24;

// Spec: SECURITY.md#sign-in-and-passwords — the password rule: 12 to 128 characters, no
// composition rules. It also applies to temporary passwords (build step 1.5), minus the check
// against the current password. The checks against the current password and the email need the
// account, so the change-password service runs them.
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/** The password rule in words, for help text under a new-password field. */
export const PASSWORD_RULE_HELP = `Use ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters. A few words together are easy to remember. It must differ from your current password and your email.`;

/** A new password: required, and within the length rule. */
export function newPasswordField() {
  return z
    .string({ error: 'Enter a new password.' })
    .min(1, 'Enter a new password.')
    .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters.`)
    .max(PASSWORD_MAX_LENGTH, `Use ${PASSWORD_MAX_LENGTH} characters or fewer.`);
}

const newPasswordFields = {
  newPassword: newPasswordField(),
  confirm: z
    .string({ error: 'Enter the new password again.' })
    .min(1, 'Enter the new password again.'),
};

/** Shown when a new password is the same as the current one. */
export const SAME_AS_CURRENT = 'Choose a password that’s different from your current one.';
/** Shown when a new password is the account's email. */
export const SAME_AS_EMAIL = 'Choose a password that isn’t your email.';

const CONFIRM_MISMATCH = 'The passwords don’t match. Enter the new password again.';

/** A new password and its confirmation, which must match. */
export const newPasswordSchema = z
  .object(newPasswordFields)
  .refine((value) => value.confirm === value.newPassword, {
    path: ['confirm'],
    message: CONFIRM_MISMATCH,
  });

/**
 * Changing your own password: the current password, then a new one that follows the rule and
 * differs from the current one. The service also checks the current password and the email.
 */
export const changePasswordSchema = z
  .object({
    currentPassword: z
      .string({ error: 'Enter your current password.' })
      .min(1, 'Enter your current password.'),
    ...newPasswordFields,
  })
  .superRefine((value, ctx) => {
    if (value.newPassword === value.currentPassword) {
      ctx.addIssue({ code: 'custom', path: ['newPassword'], message: SAME_AS_CURRENT });
    }
    if (value.confirm !== value.newPassword) {
      ctx.addIssue({ code: 'custom', path: ['confirm'], message: CONFIRM_MISMATCH });
    }
  });

export type ChangePasswordInput = z.output<typeof changePasswordSchema>;

/** Signing in: the fields only need to be filled in; the service checks everything else. */
export const signInSchema = z.object({
  email: z
    .string({ error: 'Enter your work email.' })
    .trim()
    .min(1, 'Enter your work email.')
    .refine((value) => emailDomainOf(value) !== null, { message: 'Enter a valid email address.' })
    .transform(normalizeEmail),
  password: z.string({ error: 'Enter your password.' }).min(1, 'Enter your password.'),
});

export type SignInInput = z.output<typeof signInSchema>;
