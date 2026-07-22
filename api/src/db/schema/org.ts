import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { memberStatus, orgRole, orgType } from "./enums.ts";
import { users } from "./auth.ts";

/**
 * The tenant boundary. Every org-scoped table carries `org_id`, and the
 * authorization layer refuses any query that does not filter on it.
 */
export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  type: orgType("type").notNull(),
  legalName: text("legal_name").notNull(),
  displayName: text("display_name"),
  email: text("email"),
  phone: text("phone"),
  address: text("address"),
  taxId: text("tax_id"),
  logoPath: text("logo_path"),
  country: text("country"),
  currency: text("currency").notNull().default("SAR"),
  preferredLanguage: text("preferred_language").notNull().default("en"),
  defaultTaxRate: numeric("default_tax_rate", { precision: 5, scale: 2 })
    .notNull()
    .default("15.00"),
  invoicePrefix: text("invoice_prefix").notNull().default("INV"),
  quotePrefix: text("quote_prefix").notNull().default("QUO"),

  // SMS compliance controls — quiet hours are enforced in the worker before
  // any message is handed to Twilio.
  smsSenderId: text("sms_sender_id"),
  smsQuietHoursStart: time("sms_quiet_hours_start").notNull().default("21:00:00"),
  smsQuietHoursEnd: time("sms_quiet_hours_end").notNull().default("09:00:00"),
  smsTimezone: text("sms_timezone").notNull().default("Asia/Amman"),
  smsDailyCapPerRecipient: integer("sms_daily_cap_per_recipient")
    .notNull()
    .default(1),
  smsBilingualFooter: boolean("sms_bilingual_footer").notNull().default(true),

  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const organizationMembers = pgTable(
  "organization_members",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // Null while an invite is outstanding; filled in when the invitee signs up.
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    invitedEmail: text("invited_email"),
    role: orgRole("role").notNull().default("associate"),
    status: memberStatus("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The hot path: "is this user a member of this org, and as what role?"
    // Runs on every single authenticated request.
    uniqueIndex("organization_members_org_user_key")
      .on(table.orgId, table.userId)
      .where(sql`user_id IS NOT NULL`),
    index("organization_members_user_idx").on(table.userId),
    index("organization_members_org_idx").on(table.orgId),
    index("organization_members_invited_email_idx").on(table.invitedEmail),
  ],
);

export type Organization = typeof organizations.$inferSelect;
export type OrganizationMember = typeof organizationMembers.$inferSelect;
