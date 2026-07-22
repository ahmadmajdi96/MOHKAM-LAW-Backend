import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.ts";
import { organizations } from "./org.ts";
import { clients } from "./crm.ts";
import { cases } from "./cases.ts";
import { debtCases } from "./debt.ts";

export const smsTemplates = pgTable(
  "sms_templates",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    language: text("language").notNull(),
    body: text("body").notNull(),
    version: integer("version").notNull().default(1),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Exactly one active template per (org, kind, language).
    uniqueIndex("sms_templates_active_key")
      .on(table.orgId, table.kind, table.language)
      .where(sql`is_active`),
  ],
);

/**
 * Suppression list. Checked before every outbound send — a match here is an
 * unconditional block, independent of consent flags on the recipient record.
 */
export const smsOptOuts = pgTable(
  "sms_opt_outs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    phone: text("phone").notNull(),
    reason: text("reason"),
    optedOutAt: timestamp("opted_out_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => [uniqueIndex("sms_opt_outs_org_phone_key").on(table.orgId, table.phone)],
);

export const smsMessages = pgTable(
  "sms_messages",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    ownerId: uuid("owner_id").references(() => users.id, {
      onDelete: "set null",
    }),
    orgId: uuid("org_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    clientId: uuid("client_id").references(() => clients.id, {
      onDelete: "set null",
    }),
    caseId: uuid("case_id").references(() => cases.id, { onDelete: "set null" }),
    debtCaseId: uuid("debt_case_id").references(() => debtCases.id, {
      onDelete: "set null",
    }),
    templateId: uuid("template_id").references(() => smsTemplates.id, {
      onDelete: "set null",
    }),
    context: text("context").notNull().default("manual"),
    toNumber: text("to_number").notNull(),
    fromNumber: text("from_number").notNull(),
    senderId: text("sender_id"),
    body: text("body").notNull(),
    language: text("language"),
    // GSM-7 vs UCS-2: Arabic forces UCS-2, which caps a segment at 70 chars.
    // Both are recorded so cost per message can be reconciled against Twilio.
    encoding: text("encoding"),
    segmentCount: integer("segment_count"),
    twilioSid: text("twilio_sid"),
    status: text("status").notNull().default("queued"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    blockedReason: text("blocked_reason"),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Status-callback webhooks look messages up by Twilio's SID.
    index("sms_messages_twilio_sid_idx").on(table.twilioSid),
    index("sms_messages_org_sent_idx").on(table.orgId, table.sentAt.desc()),
    index("sms_messages_to_number_idx").on(table.toNumber, table.sentAt.desc()),
    index("sms_messages_case_idx").on(table.caseId),
  ],
);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid("org_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    link: text("link"),
    entityType: text("entity_type"),
    entityId: uuid("entity_id"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The bell badge counts unread rows for one user — partial index keeps
    // that count O(unread) rather than O(all notifications ever).
    index("notifications_user_unread_idx")
      .on(table.userId, table.createdAt.desc())
      .where(sql`read_at IS NULL`),
    index("notifications_user_created_idx").on(
      table.userId,
      table.createdAt.desc(),
    ),
  ],
);

export const meetings = pgTable(
  "meetings",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("Meeting"),
    // Jitsi room identifier.
    roomName: text("room_name").notNull(),
    caseId: uuid("case_id").references(() => cases.id, { onDelete: "set null" }),
    clientId: uuid("client_id").references(() => clients.id, {
      onDelete: "set null",
    }),
    transcript: text("transcript").default(""),
    turns: jsonb("turns").default([]),
    participants: jsonb("participants").default([]),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("meetings_owner_started_idx").on(table.ownerId, table.startedAt.desc()),
    index("meetings_room_idx").on(table.roomName),
  ],
);

export const liveSessions = pgTable(
  "live_sessions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").references(() => cases.id, { onDelete: "set null" }),
    clientId: uuid("client_id").references(() => clients.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull().default("Live session"),
    status: text("status").notNull().default("recording"),
    language: text("language").notNull().default("ar"),
    transcript: text("transcript").notNull().default(""),
    turns: jsonb("turns").notNull().default([]),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    durationSeconds: integer("duration_seconds"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("live_sessions_owner_started_idx").on(
      table.ownerId,
      table.startedAt.desc(),
    ),
  ],
);

export type SmsMessage = typeof smsMessages.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
