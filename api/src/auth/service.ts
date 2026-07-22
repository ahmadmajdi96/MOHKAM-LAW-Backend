import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { profiles, sessions, users } from "../db/schema/auth.ts";
import { organizationMembers } from "../db/schema/org.ts";
import { env } from "../env.ts";
import { authFailuresTotal } from "../observability/metrics.ts";
import { logger } from "../observability/logger.ts";
import { AppError } from "../http/errors.ts";
import {
  burnTimingBudget,
  hashPassword,
  verifyPassword,
} from "./password.ts";
import {
  generateRefreshToken,
  hashToken,
  signAccessToken,
} from "./tokens.ts";

export interface SessionContext {
  userAgent?: string | undefined;
  ip?: string | undefined;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

async function issueSession(
  userId: string,
  email: string,
  familyId: string,
  context: SessionContext,
): Promise<TokenPair> {
  const refreshToken = generateRefreshToken();
  const refreshTokenHash = await hashToken(refreshToken);
  const expiresAt = new Date(Date.now() + env.JWT_REFRESH_TTL * 1000);

  const [session] = await db
    .insert(sessions)
    .values({
      userId,
      refreshTokenHash,
      familyId,
      userAgent: context.userAgent ?? null,
      ip: context.ip ?? null,
      expiresAt,
    })
    .returning({ id: sessions.id });

  if (!session) throw new AppError(500, "session_create_failed", "Could not create session");

  const accessToken = await signAccessToken({
    userId,
    email,
    sessionId: session.id,
  });

  return { accessToken, refreshToken, expiresIn: env.JWT_ACCESS_TTL };
}

export async function register(input: {
  email: string;
  password: string;
  fullName?: string | undefined;
  context: SessionContext;
}): Promise<TokenPair> {
  const email = input.email.trim().toLowerCase();

  const existing = await db.query.users.findFirst({
    where: eq(users.email, email),
    columns: { id: true },
  });
  if (existing) {
    // Deliberately the same shape as any other validation error — do not leak
    // whether the address is already registered.
    throw new AppError(409, "email_unavailable", "That email cannot be used");
  }

  const passwordHash = await hashPassword(input.password);

  const user = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(users)
      .values({ email, passwordHash })
      .returning({ id: users.id, email: users.email });

    if (!created) throw new AppError(500, "user_create_failed", "Could not create user");

    // Mirrors the old handle_new_user() trigger: a profile row must always
    // exist alongside the user.
    await tx.insert(profiles).values({
      id: created.id,
      fullName: input.fullName ?? email,
    });

    // An invite addressed to this email binds to the new account on signup.
    await tx
      .update(organizationMembers)
      .set({ userId: created.id, status: "active", updatedAt: new Date() })
      .where(
        and(
          eq(organizationMembers.invitedEmail, email),
          isNull(organizationMembers.userId),
        ),
      );

    return created;
  });

  return issueSession(user.id, user.email, crypto.randomUUID(), input.context);
}

export async function login(input: {
  email: string;
  password: string;
  context: SessionContext;
}): Promise<TokenPair> {
  const email = input.email.trim().toLowerCase();

  const user = await db.query.users.findFirst({
    where: eq(users.email, email),
    columns: {
      id: true,
      email: true,
      passwordHash: true,
      disabledAt: true,
    },
  });

  if (!user?.passwordHash) {
    // Spend the same time as a real verification so response latency does not
    // disclose whether the account exists.
    await burnTimingBudget();
    authFailuresTotal.inc({ reason: "unknown_user" });
    throw new AppError(401, "invalid_credentials", "Invalid email or password");
  }

  if (user.disabledAt) {
    authFailuresTotal.inc({ reason: "disabled" });
    throw new AppError(403, "account_disabled", "This account is disabled");
  }

  const { valid, needsRehash } = await verifyPassword(
    input.password,
    user.passwordHash,
  );

  if (!valid) {
    authFailuresTotal.inc({ reason: "bad_password" });
    throw new AppError(401, "invalid_credentials", "Invalid email or password");
  }

  // Silent bcrypt → Argon2id upgrade for accounts inherited from Supabase.
  if (needsRehash) {
    const upgraded = await hashPassword(input.password);
    await db
      .update(users)
      .set({ passwordHash: upgraded, updatedAt: new Date() })
      .where(eq(users.id, user.id));
    logger.info({ userId: user.id }, "upgraded password hash to argon2id");
  }

  await db
    .update(users)
    .set({ lastSignInAt: new Date() })
    .where(eq(users.id, user.id));

  return issueSession(user.id, user.email, crypto.randomUUID(), input.context);
}

/**
 * Refresh with rotation and reuse detection.
 *
 * Every refresh invalidates the presented token and issues a new one in the
 * same family. If an already-rotated token is presented again, the token was
 * captured — the entire family is revoked, forcing a fresh login on both the
 * attacker and the legitimate user.
 */
export async function refresh(input: {
  refreshToken: string;
  context: SessionContext;
}): Promise<TokenPair> {
  const tokenHash = await hashToken(input.refreshToken);

  const session = await db.query.sessions.findFirst({
    where: eq(sessions.refreshTokenHash, tokenHash),
  });

  if (!session) {
    authFailuresTotal.inc({ reason: "unknown_refresh_token" });
    throw new AppError(401, "invalid_refresh_token", "Invalid refresh token");
  }

  if (session.revokedAt) {
    await db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(
        and(eq(sessions.familyId, session.familyId), isNull(sessions.revokedAt)),
      );

    authFailuresTotal.inc({ reason: "refresh_token_reuse" });
    logger.warn(
      { userId: session.userId, familyId: session.familyId },
      "refresh token reuse detected — family revoked",
    );
    throw new AppError(401, "invalid_refresh_token", "Invalid refresh token");
  }

  if (session.expiresAt.getTime() <= Date.now()) {
    authFailuresTotal.inc({ reason: "refresh_token_expired" });
    throw new AppError(401, "invalid_refresh_token", "Invalid refresh token");
  }

  const user = await db.query.users.findFirst({
    where: eq(users.id, session.userId),
    columns: { id: true, email: true, disabledAt: true },
  });

  if (!user || user.disabledAt) {
    throw new AppError(403, "account_disabled", "This account is disabled");
  }

  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(eq(sessions.id, session.id));

  return issueSession(user.id, user.email, session.familyId, input.context);
}

export async function logout(refreshToken: string): Promise<void> {
  const tokenHash = await hashToken(refreshToken);
  const session = await db.query.sessions.findFirst({
    where: eq(sessions.refreshTokenHash, tokenHash),
    columns: { familyId: true },
  });
  if (!session) return;

  // Revoke the family, not just this token: logging out on one device should
  // not leave a rotated sibling token usable.
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(
      and(eq(sessions.familyId, session.familyId), isNull(sessions.revokedAt)),
    );
}

/** Housekeeping — invoked by the worker's nightly cron. */
export async function pruneExpiredSessions(): Promise<number> {
  const result = await db
    .delete(sessions)
    .where(sql`${sessions.expiresAt} < now() - interval '7 days'`);
  return result.count ?? 0;
}
