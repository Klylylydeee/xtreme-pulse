import { describe, expect, it } from 'vitest';
import { newPasswordField, normalizeEmail, PASSWORD_MIN_LENGTH } from '../../account';
import {
  CROCKFORD_BASE32,
  generateTemporaryPassword,
  generateTemporaryPasswordFor,
  TEMPORARY_PASSWORD_PATTERN,
} from './temporary-password';

// Temporary passwords (SECURITY.md#sign-in-and-passwords, docs/TESTING.md#user-account-tests):
// 16 cryptographically random Crockford base32 characters as `XXXX-XXXX-XXXX-XXXX`, within the
// password rule, never the account's email. The reset itself is tested with the user service.

const SAMPLES = 2_000;

describe('generateTemporaryPassword', () => {
  it('uses the 32 Crockford base32 characters, without I, L, O or U', () => {
    expect(CROCKFORD_BASE32).toHaveLength(32);
    expect(new Set(CROCKFORD_BASE32).size).toBe(32);
    for (const letter of ['I', 'L', 'O', 'U']) expect(CROCKFORD_BASE32).not.toContain(letter);
  });

  it('is 16 Crockford base32 characters in the XXXX-XXXX-XXXX-XXXX form', () => {
    for (let index = 0; index < SAMPLES; index += 1) {
      const password = generateTemporaryPassword();
      expect(password).toMatch(TEMPORARY_PASSWORD_PATTERN);
      expect(password).toHaveLength(19);
      const characters = password.replaceAll('-', '');
      expect(characters).toHaveLength(16);
      for (const character of characters) expect(CROCKFORD_BASE32).toContain(character);
    }
  });

  it('meets the password rule', () => {
    const rule = newPasswordField();
    const password = generateTemporaryPassword();
    expect(password.length).toBeGreaterThanOrEqual(PASSWORD_MIN_LENGTH);
    expect(rule.safeParse(password).success).toBe(true);
  });

  it('never repeats over many passwords, and uses every character', () => {
    const passwords = new Set<string>();
    const counts = new Map<string, number>();
    for (let index = 0; index < SAMPLES; index += 1) {
      const password = generateTemporaryPassword();
      passwords.add(password);
      for (const character of password.replaceAll('-', '')) {
        counts.set(character, (counts.get(character) ?? 0) + 1);
      }
    }
    expect(passwords.size).toBe(SAMPLES);

    // 32,000 characters: about 1,000 of each. A broken source (a constant, a skewed mapping)
    // would leave characters out or pile them up; a fair one stays far inside these bounds.
    expect(counts.size).toBe(32);
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(700);
      expect(count).toBeLessThan(1_300);
    }
  });
});

describe('generateTemporaryPasswordFor', () => {
  it('never returns the account’s email', () => {
    const emails = ['ana.cruz@xtreme-works.com', 'Made.Up@Gmail.com'];
    for (const email of emails) {
      for (let index = 0; index < 200; index += 1) {
        const password = generateTemporaryPasswordFor(email);
        expect(password).toMatch(TEMPORARY_PASSWORD_PATTERN);
        expect(normalizeEmail(password)).not.toBe(normalizeEmail(email));
      }
    }
  });
});
