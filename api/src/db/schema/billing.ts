import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
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
import {
  allocationKind,
  expenseKind,
  expenseStatus,
  invoiceStatus,
  paymentMethod,
  prebillStatus,
  quoteStatus,
  scheduleStatus,
} from "./enums.ts";

// Money is numeric(14,2) throughout and surfaces as a string in JS. Never
// parse it to a float for arithmetic — do the maths in SQL or a decimal type.
const money = (name: string) => numeric(name, { precision: 14, scale: 2 });

export const quotes = pgTable(
  "quotes",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    number: text("number").notNull(),
    clientId: uuid("client_id").references(() => clients.id, {
      onDelete: "set null",
    }),
    // Denormalised so a historical document still renders correctly after the
    // client record is renamed or deleted.
    clientName: text("client_name").notNull(),
    caseId: uuid("case_id").references(() => cases.id, { onDelete: "set null" }),
    issueDate: date("issue_date").notNull().default(sql`CURRENT_DATE`),
    validUntil: date("valid_until"),
    status: quoteStatus("status").notNull().default("draft"),
    currency: text("currency").notNull().default("SAR"),
    taxRate: numeric("tax_rate", { precision: 5, scale: 2 })
      .notNull()
      .default("0"),
    subtotal: money("subtotal").notNull().default("0"),
    taxAmount: money("tax_amount").notNull().default("0"),
    total: money("total").notNull().default("0"),
    notes: text("notes"),
    items: jsonb("items").notNull().default([]),
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
    uniqueIndex("quotes_org_number_key").on(table.orgId, table.number),
    index("quotes_org_status_idx").on(table.orgId, table.status),
    index("quotes_client_idx").on(table.clientId),
  ],
);

export const taxInvoices = pgTable(
  "tax_invoices",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    number: text("number").notNull(),
    quoteId: uuid("quote_id").references(() => quotes.id, {
      onDelete: "set null",
    }),
    clientId: uuid("client_id").references(() => clients.id, {
      onDelete: "set null",
    }),
    clientName: text("client_name").notNull(),
    caseId: uuid("case_id").references(() => cases.id, { onDelete: "set null" }),
    issueDate: date("issue_date").notNull().default(sql`CURRENT_DATE`),
    dueDate: date("due_date"),
    status: invoiceStatus("status").notNull().default("draft"),
    currency: text("currency").notNull().default("JOD"),
    taxRate: numeric("tax_rate", { precision: 5, scale: 2 })
      .notNull()
      .default("0"),
    subtotal: money("subtotal").notNull().default("0"),
    taxAmount: money("tax_amount").notNull().default("0"),
    total: money("total").notNull().default("0"),
    // Maintained by recomputeInvoiceFromAllocations, never written directly.
    amountPaid: money("amount_paid").notNull().default("0"),
    notes: text("notes"),
    items: jsonb("items").notNull().default([]),
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
    // Invoice numbers must be gapless and unique per org for tax audit.
    uniqueIndex("tax_invoices_org_number_key").on(table.orgId, table.number),
    index("tax_invoices_org_status_idx").on(table.orgId, table.status),
    // Drives the overdue sweep and the ageing report.
    index("tax_invoices_due_date_idx").on(table.dueDate),
    index("tax_invoices_client_idx").on(table.clientId),
    index("tax_invoices_case_idx").on(table.caseId),
  ],
);

export const draftInvoices = pgTable(
  "draft_invoices",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    number: text("number"),
    clientId: uuid("client_id").references(() => clients.id, {
      onDelete: "set null",
    }),
    clientName: text("client_name").notNull(),
    caseId: uuid("case_id").references(() => cases.id, { onDelete: "set null" }),
    issueDate: date("issue_date").notNull().default(sql`CURRENT_DATE`),
    dueDate: date("due_date"),
    status: text("status").notNull().default("draft"),
    currency: text("currency").notNull().default("USD"),
    taxRate: numeric("tax_rate", { precision: 5, scale: 2 })
      .notNull()
      .default("0"),
    subtotal: money("subtotal").notNull().default("0"),
    taxAmount: money("tax_amount").notNull().default("0"),
    total: money("total").notNull().default("0"),
    notes: text("notes"),
    items: jsonb("items").notNull().default([]),
    // Time entries folded into this draft, so they can be released back to
    // unbilled if the draft is discarded.
    timeEntryIds: uuid("time_entry_ids").array().notNull().default(sql`'{}'`),
    acceptedInvoiceId: uuid("accepted_invoice_id").references(
      () => taxInvoices.id,
      { onDelete: "set null" },
    ),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
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
    index("draft_invoices_org_status_idx").on(table.orgId, table.status),
    index("draft_invoices_client_idx").on(table.clientId),
  ],
);

export const clientCredits = pgTable(
  "client_credits",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    clientId: uuid("client_id").references(() => clients.id, {
      onDelete: "set null",
    }),
    clientName: text("client_name").notNull(),
    amount: money("amount").notNull(),
    appliedAmount: money("applied_amount").notNull().default("0"),
    currency: text("currency").notNull(),
    sourcePaymentId: uuid("source_payment_id"),
    note: text("note"),
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
    index("client_credits_org_idx").on(table.orgId),
    index("client_credits_client_idx").on(table.clientId),
  ],
);

export const paymentSchedules = pgTable(
  "payment_schedules",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    invoiceId: uuid("invoice_id").references(() => taxInvoices.id, {
      onDelete: "set null",
    }),
    clientId: uuid("client_id").references(() => clients.id, {
      onDelete: "set null",
    }),
    clientName: text("client_name").notNull(),
    description: text("description"),
    dueDate: date("due_date").notNull(),
    amount: money("amount").notNull(),
    currency: text("currency").notNull().default("JOD"),
    status: scheduleStatus("status").notNull().default("upcoming"),
    reminderSentAt: timestamp("reminder_sent_at", { withTimezone: true }),
    // Installment plan grouping: plan_id ties the instalments together.
    planId: uuid("plan_id"),
    installmentNo: integer("installment_no"),
    installmentCount: integer("installment_count"),
    // FK omitted deliberately to keep billing.ts free of a circular import
    // with debt.ts; the constraint is added in the SQL migration.
    debtCaseId: uuid("debt_case_id"),
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
    // The daily reminder sweep: due, not yet reminded.
    index("payment_schedules_status_due_idx").on(table.status, table.dueDate),
    index("payment_schedules_org_idx").on(table.orgId),
    index("payment_schedules_plan_idx").on(table.planId),
  ],
);

export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    invoiceId: uuid("invoice_id").references(() => taxInvoices.id, {
      onDelete: "set null",
    }),
    scheduleId: uuid("schedule_id").references(() => paymentSchedules.id, {
      onDelete: "set null",
    }),
    clientId: uuid("client_id").references(() => clients.id, {
      onDelete: "set null",
    }),
    clientName: text("client_name").notNull(),
    amount: money("amount").notNull(),
    currency: text("currency").notNull().default("JOD"),
    method: paymentMethod("method").notNull().default("bank_transfer"),
    reference: text("reference"),
    paidAt: date("paid_at").notNull().default(sql`CURRENT_DATE`),
    notes: text("notes"),
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
    index("payments_org_paid_idx").on(table.orgId, table.paidAt.desc()),
    index("payments_invoice_idx").on(table.invoiceId),
    index("payments_client_idx").on(table.clientId),
  ],
);

/**
 * A payment can be split across several targets (part invoice, part retainer,
 * part credit). Invoice balances are derived by summing these rows, which is
 * why amount_paid on tax_invoices is recomputed rather than incremented.
 */
export const paymentAllocations = pgTable(
  "payment_allocations",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payments.id, { onDelete: "cascade" }),
    kind: allocationKind("kind").notNull(),
    invoiceId: uuid("invoice_id").references(() => taxInvoices.id, {
      onDelete: "cascade",
    }),
    scheduleId: uuid("schedule_id").references(() => paymentSchedules.id, {
      onDelete: "cascade",
    }),
    retainerCaseId: uuid("retainer_case_id").references(() => cases.id, {
      onDelete: "set null",
    }),
    creditId: uuid("credit_id").references(() => clientCredits.id, {
      onDelete: "set null",
    }),
    // See note on paymentSchedules.debtCaseId.
    debtCaseId: uuid("debt_case_id"),
    amount: money("amount").notNull(),
    currency: text("currency").notNull(),
    note: text("note"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("payment_allocations_payment_idx").on(table.paymentId),
    index("payment_allocations_invoice_idx").on(table.invoiceId),
    index("payment_allocations_org_idx").on(table.orgId),
  ],
);

export const expenses = pgTable(
  "expenses",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").references(() => cases.id, { onDelete: "set null" }),
    clientId: uuid("client_id").references(() => clients.id, {
      onDelete: "set null",
    }),
    kind: expenseKind("kind").notNull().default("other"),
    description: text("description"),
    amount: money("amount").notNull(),
    currency: text("currency").notNull().default("JOD"),
    incurredOn: date("incurred_on").notNull().default(sql`CURRENT_DATE`),
    billable: boolean("billable").notNull().default(true),
    status: expenseStatus("status").notNull().default("wip"),
    invoiceId: uuid("invoice_id").references(() => taxInvoices.id, {
      onDelete: "set null",
    }),
    receiptUrl: text("receipt_url"),
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
    // Prebill generation scans unbilled billable expenses for a case+period.
    index("expenses_org_status_idx").on(table.orgId, table.status),
    index("expenses_case_idx").on(table.caseId, table.incurredOn),
  ],
);

export const timeEntries = pgTable(
  "time_entries",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").references(() => cases.id, { onDelete: "set null" }),
    clientId: uuid("client_id").references(() => clients.id, {
      onDelete: "set null",
    }),
    description: text("description").notNull().default(""),
    activityType: text("activity_type").notNull().default("work"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    durationSeconds: integer("duration_seconds").notNull().default(0),
    hourlyRate: numeric("hourly_rate", { precision: 12, scale: 2 }),
    currency: text("currency").notNull().default("USD"),
    billable: boolean("billable").notNull().default(true),
    status: text("status").notNull().default("logged"),
    invoiceId: uuid("invoice_id").references(() => taxInvoices.id, {
      onDelete: "set null",
    }),
    isRunning: boolean("is_running").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("time_entries_owner_started_idx").on(
      table.ownerId,
      table.startedAt.desc(),
    ),
    index("time_entries_case_idx").on(table.caseId),
    // At most one running timer per user — enforced in the database so a
    // double-tap on "start" cannot create two.
    uniqueIndex("time_entries_one_running_per_user")
      .on(table.ownerId)
      .where(sql`is_running`),
  ],
);

export const prebills = pgTable(
  "prebills",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").references(() => cases.id, { onDelete: "set null" }),
    clientId: uuid("client_id").references(() => clients.id, {
      onDelete: "set null",
    }),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    status: prebillStatus("status").notNull().default("draft"),
    currency: text("currency").notNull().default("JOD"),
    subtotalTime: money("subtotal_time").notNull().default("0"),
    subtotalExpenses: money("subtotal_expenses").notNull().default("0"),
    discount: money("discount").notNull().default("0"),
    total: money("total").notNull().default("0"),
    narrative: text("narrative"),
    approvedBy: uuid("approved_by").references(() => users.id, {
      onDelete: "set null",
    }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
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
    index("prebills_org_status_idx").on(table.orgId, table.status),
    index("prebills_case_period_idx").on(
      table.caseId,
      table.periodStart,
      table.periodEnd,
    ),
  ],
);

export const prebillLines = pgTable(
  "prebill_lines",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    prebillId: uuid("prebill_id")
      .notNull()
      .references(() => prebills.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    timeEntryId: uuid("time_entry_id").references(() => timeEntries.id, {
      onDelete: "set null",
    }),
    expenseId: uuid("expense_id").references(() => expenses.id, {
      onDelete: "set null",
    }),
    description: text("description"),
    quantity: money("quantity").notNull().default("0"),
    unitPrice: money("unit_price").notNull().default("0"),
    amount: money("amount").notNull().default("0"),
    included: boolean("included").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("prebill_lines_prebill_idx").on(table.prebillId)],
);

export type TaxInvoice = typeof taxInvoices.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type TimeEntry = typeof timeEntries.$inferSelect;
export type Expense = typeof expenses.$inferSelect;
