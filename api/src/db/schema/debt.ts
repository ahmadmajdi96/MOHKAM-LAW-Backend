import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { users } from "./auth.ts";
import { organizations } from "./org.ts";
import { clients } from "./crm.ts";
import { taxInvoices } from "./billing.ts";
import {
  debtCaseStatus,
  debtPayerStatus,
  debtSmsKind,
  debtType,
} from "./enums.ts";

const money = (name: string) => numeric(name, { precision: 14, scale: 2 });

export const debtCases = pgTable(
  "debt_cases",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    clientId: uuid("client_id").references(() => clients.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    description: text("description"),
    debtType: debtType("debt_type").notNull().default("other"),
    totalAmount: money("total_amount").notNull().default("0"),
    currency: text("currency").notNull().default("USD"),
    // 'percent' | 'flat' — how the firm's collection fee is computed.
    serviceFeeType: text("service_fee_type").notNull().default("percent"),
    serviceFeeValue: money("service_fee_value").notNull().default("0"),
    status: debtCaseStatus("status").notNull().default("active"),
    dueDate: date("due_date"),
    forwarderName: text("forwarder_name"),
    forwarderContact: text("forwarder_contact"),
    reference: text("reference"),

    // Recurring debts (rent, instalments) spawn child cases from a parent.
    recurrence: text("recurrence").default("none"),
    recurrenceInterval: integer("recurrence_interval").default(1),
    nextRecurAt: date("next_recur_at"),
    parentDebtCaseId: uuid("parent_debt_case_id").references(
      (): AnyPgColumn => debtCases.id,
      { onDelete: "set null" },
    ),

    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("debt_cases_org_status_idx").on(table.orgId, table.status),
    index("debt_cases_client_idx").on(table.clientId),
    // Drives the recurrence sweep.
    index("debt_cases_next_recur_idx").on(table.nextRecurAt),
  ],
);

export const debtCasePayers = pgTable(
  "debt_case_payers",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    caseId: uuid("case_id")
      .notNull()
      .references(() => debtCases.id, { onDelete: "cascade" }),
    clientId: uuid("client_id").references(() => clients.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    phone: text("phone"),
    email: text("email"),
    amountDue: money("amount_due").notNull().default("0"),
    amountPaid: money("amount_paid").notNull().default("0"),
    dueDate: date("due_date"),
    status: debtPayerStatus("status").notNull().default("pending"),
    notes: text("notes"),

    lastReminderSentAt: timestamp("last_reminder_sent_at", {
      withTimezone: true,
    }),
    lastReminderKind: debtSmsKind("last_reminder_kind"),

    // Consent and suppression. opted_out_at is checked before every send;
    // a non-null value is an absolute block, regardless of rules.
    smsConsentAt: timestamp("sms_consent_at", { withTimezone: true }),
    smsConsentSource: text("sms_consent_source"),
    optedOutAt: timestamp("opted_out_at", { withTimezone: true }),

    promiseToPayDate: date("promise_to_pay_date"),
    promiseAmount: money("promise_amount"),
    promisedAt: timestamp("promised_at", { withTimezone: true }),
    disputeReason: text("dispute_reason"),
    disputedAt: timestamp("disputed_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("debt_case_payers_case_idx").on(table.caseId),
    index("debt_case_payers_status_due_idx").on(table.status, table.dueDate),
    index("debt_case_payers_phone_idx").on(table.phone),
  ],
);

export const debtCaseAssignees = pgTable(
  "debt_case_assignees",
  {
    caseId: uuid("case_id")
      .notNull()
      .references(() => debtCases.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("collector"),
    phone: text("phone"),
    notifySms: boolean("notify_sms").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.caseId, table.userId] }),
    index("debt_case_assignees_user_idx").on(table.userId),
  ],
);

export const debtCollectionPayments = pgTable(
  "debt_collection_payments",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    caseId: uuid("case_id")
      .notNull()
      .references(() => debtCases.id, { onDelete: "cascade" }),
    payerId: uuid("payer_id").references(() => debtCasePayers.id, {
      onDelete: "set null",
    }),
    // received = fee retained + forwarded to the creditor.
    amountReceived: money("amount_received").notNull().default("0"),
    serviceFee: money("service_fee").notNull().default("0"),
    amountForwarded: money("amount_forwarded").notNull().default("0"),
    forwarderName: text("forwarder_name"),
    method: text("method").notNull().default("bank_transfer"),
    reference: text("reference"),
    paidAt: date("paid_at").notNull().default(sql`CURRENT_DATE`),
    currency: text("currency").notNull().default("USD"),
    notes: text("notes"),
    invoiceId: uuid("invoice_id").references(() => taxInvoices.id, {
      onDelete: "set null",
    }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("debt_collection_payments_case_idx").on(table.caseId),
    index("debt_collection_payments_org_paid_idx").on(
      table.orgId,
      table.paidAt.desc(),
    ),
  ],
);

export const debtReminderRules = pgTable(
  "debt_reminder_rules",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    caseId: uuid("case_id")
      .notNull()
      .references(() => debtCases.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    // Negative = before due date, positive = after.
    offsetDays: integer("offset_days").notNull().default(0),
    kind: text("kind").notNull().default("reminder_upcoming"),
    messageTemplate: text("message_template").notNull(),
    active: boolean("active").notNull().default(true),
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
    index("debt_reminder_rules_case_active_idx").on(table.caseId, table.active),
  ],
);

export const debtSmsLog = pgTable(
  "debt_sms_log",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").references(() => debtCases.id, {
      onDelete: "set null",
    }),
    payerId: uuid("payer_id").references(() => debtCasePayers.id, {
      onDelete: "set null",
    }),
    assigneeUserId: uuid("assignee_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    phone: text("phone").notNull(),
    message: text("message").notNull(),
    kind: debtSmsKind("kind").notNull().default("manual"),
    status: text("status").notNull().default("sent"),
    twilioSid: text("twilio_sid"),
    error: text("error"),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Enforces the per-recipient daily cap: count sends to a phone today.
    index("debt_sms_log_phone_sent_idx").on(table.phone, table.sentAt.desc()),
    index("debt_sms_log_case_idx").on(table.caseId),
    index("debt_sms_log_org_sent_idx").on(table.orgId, table.sentAt.desc()),
  ],
);

export type DebtCase = typeof debtCases.$inferSelect;
export type DebtCasePayer = typeof debtCasePayers.$inferSelect;
