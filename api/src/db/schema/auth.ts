import {
  customType,
  index,
  inet,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// citext gives case-insensitive uniqueness without lower() indexes everywhere,
// so "Ahmad@x.com" and "ahmad@x.com" cannot become two accounts.
const citext = customType<{ data: string }>({
  dataType: () => "citext",
});

/**
 * Replaces Supabase `auth.users`. Every `owner_id` / `user_id` / `created_by`
 * column across the schema now references this table.
 *
 * IDs are preserved verbatim during migration from Supabase so no foreign key
 * anywhere else has to be rewritten.
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    email: citext("email").notNull(),
    // Argon2id via Bun.password. Null for invite-only accounts that have not
    // set a password yet — those authenticate through the set-password flow.
    passwordHash: text("password_hash"),
    emailConfirmedAt: timestamp("email_confirmed_at", { withTimezone: true }),
    lastSignInAt: timestamp("last_sign_in_at", { withTimezone: true }),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("users_email_key").on(table.email)],
);

/**
 * Refresh-token sessions. Access tokens stay stateless and short-lived; the
 * refresh token is the revocable half, stored only as a SHA-256 hash so a
 * database leak cannot be replayed against the API.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    refreshTokenHash: text("refresh_token_hash").notNull(),
    // Rotation lineage: reuse of a already-rotated token means the token was
    // stolen, and the whole family gets revoked.
    familyId: uuid("family_id").notNull(),
    userAgent: text("user_agent"),
    ip: inet("ip"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("sessions_refresh_token_hash_key").on(table.refreshTokenHash),
    index("sessions_user_id_idx").on(table.userId),
    index("sessions_family_id_idx").on(table.familyId),
    index("sessions_expires_at_idx").on(table.expiresAt),
  ],
);

/** Single-use tokens for email confirmation, password reset and invites. */
export const authTokens = pgTable(
  "auth_tokens",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // 'email_confirm' | 'password_reset' | 'invite'
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("auth_tokens_token_hash_key").on(table.tokenHash),
    index("auth_tokens_user_kind_idx").on(table.userId, table.kind),
  ],
);

/** Carried over unchanged from the Supabase schema. */
export const profiles = pgTable("profiles", {
  id: uuid("id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  fullName: text("full_name"),
  avatarUrl: text("avatar_url"),
  role: text("role").default("lawyer"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Profile = typeof profiles.$inferSelect;
