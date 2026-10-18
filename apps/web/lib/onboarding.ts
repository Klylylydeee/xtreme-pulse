import { safeCallbackUrl } from './callback-url';
import { ONBOARDING_HREF } from './navigation';

// Spec: docs/modules/talent.md#onboarding-checklist-and-change-requests-build-step-26 ("Required
// but not enforced"; decision 261 in docs/BUILD_PLAN.md) and docs/DESIGN_SYSTEM.md#feedback--motion
// ("Onboarding progress") — the onboarding reminder's pure helpers: where the change-password page
// sends a new user, and the toolbar pill's and Home card's wording. Pure code, tested without a
// database (lib/onboarding.test.ts).

/** The own onboarding progress the pill and the Home card show. */
export interface OnboardingReminder {
  done: number;
  total: number;
  /** True while any of the user's own items is To do. */
  showReminder: boolean;
}

/**
 * Where the change-password page sends the user once the password is changed: their callback page
 * when they were on their way somewhere; otherwise `/talent/onboarding` when this replaced a
 * temporary password and any of their own onboarding items is To do (guided once); otherwise Home.
 */
export function afterPasswordChangePath({
  callbackUrl,
  hadTemporaryPassword,
  onboardingPending,
}: {
  callbackUrl: unknown;
  hadTemporaryPassword: boolean;
  onboardingPending: boolean;
}): string {
  const destination = safeCallbackUrl(callbackUrl);
  if (destination !== '/') return destination;
  return hadTemporaryPassword && onboardingPending ? ONBOARDING_HREF : '/';
}

/** "Onboarding 5 of 8": the pill's text on wider screens. */
export function onboardingPillText({ done, total }: Pick<OnboardingReminder, 'done' | 'total'>) {
  return `Onboarding ${done} of ${total}`;
}

/** "5/8": the pill's text on a phone. */
export function onboardingPillShortText({
  done,
  total,
}: Pick<OnboardingReminder, 'done' | 'total'>) {
  return `${done}/${total}`;
}

/** "5 of 8 done": the pill's accessible name follows "Onboarding, ", and the Home card's bar. */
export function onboardingDoneText({ done, total }: Pick<OnboardingReminder, 'done' | 'total'>) {
  return `${done} of ${total} done`;
}

/** The share done, 0 to 1, for the ring and the bar (0 with no items). */
export function onboardingFraction({ done, total }: Pick<OnboardingReminder, 'done' | 'total'>) {
  if (total <= 0) return 0;
  return Math.min(1, Math.max(0, done / total));
}
