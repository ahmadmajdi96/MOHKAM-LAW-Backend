/**
 * Password hashing via Bun's native Argon2id.
 *
 * Argon2id is the current OWASP recommendation — memory-hard, so it resists
 * GPU cracking in a way bcrypt does not. Bun ships it natively, so there is no
 * native-module build step in the container.
 *
 * Supabase used bcrypt. Legacy hashes are detected by prefix and verified with
 * bcrypt, then transparently upgraded to Argon2id on the next successful
 * login — no forced password reset during migration.
 */

const ARGON2_OPTIONS = {
  algorithm: "argon2id",
  memoryCost: 19_456, // 19 MiB — OWASP minimum for argon2id
  timeCost: 2,
} as const;

export async function hashPassword(plain: string): Promise<string> {
  return Bun.password.hash(plain, ARGON2_OPTIONS);
}

export function isLegacyBcryptHash(hash: string): boolean {
  return hash.startsWith("$2a$") || hash.startsWith("$2b$") || hash.startsWith("$2y$");
}

/**
 * Bun.password.verify auto-detects the algorithm from the hash prefix, so this
 * handles both Argon2id and inherited bcrypt hashes.
 *
 * Returns `needsRehash` so the caller can upgrade the stored hash in place.
 */
export async function verifyPassword(
  plain: string,
  hash: string,
): Promise<{ valid: boolean; needsRehash: boolean }> {
  try {
    const valid = await Bun.password.verify(plain, hash);
    return { valid, needsRehash: valid && isLegacyBcryptHash(hash) };
  } catch {
    // Malformed hash in the database — treat as a failed login, never a 500.
    return { valid: false, needsRehash: false };
  }
}

/**
 * Constant-time-ish guard for the "user does not exist" path. Without this,
 * response timing reveals which emails are registered, because the real path
 * spends ~50ms in Argon2 and the missing-user path returns immediately.
 */
const DUMMY_HASH = await hashPassword(crypto.randomUUID());

export async function burnTimingBudget(): Promise<void> {
  await Bun.password.verify("invalid", DUMMY_HASH).catch(() => false);
}
