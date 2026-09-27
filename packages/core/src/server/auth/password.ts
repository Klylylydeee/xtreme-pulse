import { type Algorithm, hash, verify } from '@node-rs/argon2';

// Spec: SECURITY.md#sign-in-and-passwords — passwords are hashed with argon2id and never stored,
// logged or returned in plain text. Nothing in this file logs, and errors never carry the password
// or the hash.

// `Algorithm` is an ambient const enum, which `isolatedModules` can't read; 2 is Argon2id.
const ARGON2ID = 2 as Algorithm.Argon2id;

// OWASP's argon2id minimum: 19 MiB of memory, 2 passes, 1 thread.
const HASH_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/** Hashes a password with argon2id. The result is a PHC string with its own random salt. */
export async function hashPassword(password: string): Promise<string> {
  if (password.length === 0) throw new Error('A password cannot be empty.');
  return hash(password, HASH_OPTIONS);
}

/**
 * True when `password` matches `passwordHash`. A malformed hash counts as no match, so the caller
 * shows the same sign-in error either way.
 */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}
