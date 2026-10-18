import { describe, expect, it } from 'vitest';
import {
  afterPasswordChangePath,
  onboardingDoneText,
  onboardingFraction,
  onboardingPillShortText,
  onboardingPillText,
} from './onboarding';

// Spec: docs/TESTING.md#onboarding-and-change-request-tests ("Navigation": the change-password
// redirect) and docs/DESIGN_SYSTEM.md#feedback--motion ("Onboarding progress") — where a new user
// lands after replacing a temporary password, and the reminder's wording. Pure: no database.

describe('afterPasswordChangePath (step 2.6)', () => {
  it('sends a new user with To do items to the checklist, guided once', () => {
    expect(
      afterPasswordChangePath({
        callbackUrl: undefined,
        hadTemporaryPassword: true,
        onboardingPending: true,
      }),
    ).toBe('/talent/onboarding');
    // A callback to Home is no other page: still the checklist.
    expect(
      afterPasswordChangePath({
        callbackUrl: '/',
        hadTemporaryPassword: true,
        onboardingPending: true,
      }),
    ).toBe('/talent/onboarding');
  });

  it('sends them to their callback page when they were on their way somewhere', () => {
    expect(
      afterPasswordChangePath({
        callbackUrl: '/approvals?request=64b7f0c2a1b2c3d4e5f60718',
        hadTemporaryPassword: true,
        onboardingPending: true,
      }),
    ).toBe('/approvals?request=64b7f0c2a1b2c3d4e5f60718');
  });

  it('goes Home when every own item is done or waiting for HR', () => {
    expect(
      afterPasswordChangePath({
        callbackUrl: undefined,
        hadTemporaryPassword: true,
        onboardingPending: false,
      }),
    ).toBe('/');
  });

  it('goes Home after an ordinary password change, whatever the checklist says', () => {
    expect(
      afterPasswordChangePath({
        callbackUrl: undefined,
        hadTemporaryPassword: false,
        onboardingPending: true,
      }),
    ).toBe('/');
  });

  it('never follows an unsafe callback', () => {
    for (const callbackUrl of ['https://evil.example', '//evil.example', '/\\evil.example']) {
      expect(
        afterPasswordChangePath({
          callbackUrl,
          hadTemporaryPassword: true,
          onboardingPending: true,
        }),
      ).toBe('/talent/onboarding');
      expect(
        afterPasswordChangePath({
          callbackUrl,
          hadTemporaryPassword: false,
          onboardingPending: false,
        }),
      ).toBe('/');
    }
  });
});

describe('the onboarding reminder’s wording (step 2.6)', () => {
  const progress = { done: 5, total: 8 };

  it('reads "Onboarding 5 of 8", "5/8" on a phone, and "5 of 8 done"', () => {
    expect(onboardingPillText(progress)).toBe('Onboarding 5 of 8');
    expect(onboardingPillShortText(progress)).toBe('5/8');
    expect(onboardingDoneText(progress)).toBe('5 of 8 done');
  });

  it('gives the share done for the ring and the bar, between 0 and 1', () => {
    expect(onboardingFraction(progress)).toBe(0.625);
    expect(onboardingFraction({ done: 8, total: 8 })).toBe(1);
    expect(onboardingFraction({ done: 0, total: 0 })).toBe(0);
    expect(onboardingFraction({ done: 9, total: 8 })).toBe(1);
  });
});
