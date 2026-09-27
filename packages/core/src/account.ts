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
