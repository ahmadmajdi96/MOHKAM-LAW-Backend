import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.ts";

/**
 * NOTE ON TENANCY: `clients` is owner-scoped, not org-scoped — there is no
 * `org_id` column, matching the original schema. Visibility to colleagues is
 * therefore derived through the cases a client is attached to, not through
 * org membership. See authz/policy.ts, which encodes this rule explicitly.
 */
export const clients = pgTable(
  "clients",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: text("type").notNull().default("individual"),
    status: text("status").notNull().default("active"),
    email: text("email"),
    phone: text("phone"),
    company: text("company"),
    nationalId: text("national_id"),
    address: text("address"),
    country: text("country"),
    taxId: text("tax_id"),
    notes: text("notes"),

    // Consent must be recorded before any marketing or reminder SMS is sent.
    smsConsentAt: timestamp("sms_consent_at", { withTimezone: true }),
    smsConsentSource: text("sms_consent_source"),
    preferredSmsLanguage: text("preferred_sms_language"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("clients_owner_idx").on(table.ownerId),
    // Trigram index: the client picker searches Arabic and Latin names with
    // ILIKE '%…%', which a btree index cannot serve.
    index("clients_name_trgm_idx").using(
      "gin",
      sql`${table.name} gin_trgm_ops`,
    ),
    index("clients_phone_idx").on(table.phone),
  ],
);

export const clientInteractions = pgTable(
  "client_interactions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("note"),
    title: text("title"),
    body: text("body"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("client_interactions_client_idx").on(
      table.clientId,
      table.occurredAt.desc(),
    ),
    index("client_interactions_owner_idx").on(table.ownerId),
  ],
);

export type Client = typeof clients.$inferSelect;
export type ClientInteraction = typeof clientInteractions.$inferSelect;
