import { pgEnum } from "drizzle-orm/pg-core";

// Mirrors the Postgres enum types verbatim. Member order is significant:
// altering it requires an explicit ALTER TYPE migration, never an edit here.

export const orgType = pgEnum("org_type", ["solo", "firm"]);

export const orgRole = pgEnum("org_role", [
  "owner",
  "partner",
  "associate",
  "paralegal",
  "accountant",
  "assistant",
]);

export const memberStatus = pgEnum("member_status", [
  "active",
  "invited",
  "disabled",
]);

export const invoiceStatus = pgEnum("invoice_status", [
  "draft",
  "issued",
  "partial",
  "paid",
  "overdue",
  "void",
  "sent",
  "viewed",
  "written_off",
]);

export const quoteStatus = pgEnum("quote_status", [
  "draft",
  "sent",
  "accepted",
  "rejected",
  "expired",
  "converted",
]);

export const paymentMethod = pgEnum("payment_method", [
  "cash",
  "bank_transfer",
  "card",
  "cheque",
  "other",
]);

export const allocationKind = pgEnum("allocation_kind", [
  "invoice",
  "schedule",
  "retainer",
  "credit_apply",
  "debt_case",
]);

export const scheduleStatus = pgEnum("schedule_status", [
  "upcoming",
  "due",
  "paid",
  "overdue",
  "cancelled",
  "paused",
]);

export const expenseKind = pgEnum("expense_kind", [
  "court_fee",
  "expert",
  "translation",
  "filing",
  "travel",
  "other",
]);

export const expenseStatus = pgEnum("expense_status", [
  "wip",
  "billed",
  "written_off",
  "non_billable",
]);

export const prebillStatus = pgEnum("prebill_status", [
  "draft",
  "approved",
  "billed",
  "void",
]);

export const debtType = pgEnum("debt_type", [
  "rent",
  "loan",
  "service",
  "installment",
  "other",
]);

export const debtCaseStatus = pgEnum("debt_case_status", [
  "active",
  "paid",
  "partial",
  "overdue",
  "cancelled",
]);

export const debtPayerStatus = pgEnum("debt_payer_status", [
  "pending",
  "partial",
  "paid",
  "overdue",
  "cancelled",
]);

export const debtSmsKind = pgEnum("debt_sms_kind", [
  "reminder_upcoming",
  "reminder_due",
  "reminder_overdue",
  "assignment",
  "manual",
]);
