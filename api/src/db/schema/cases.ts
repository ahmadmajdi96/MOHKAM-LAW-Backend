import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
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

export const cases = pgTable(
  "cases",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Nullable: cases created before the org model was introduced have none.
    orgId: uuid("org_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    clientId: uuid("client_id").references(() => clients.id, {
      onDelete: "set null",
    }),
    responsibleLawyer: uuid("responsible_lawyer").references(() => users.id, {
      onDelete: "set null",
    }),

    title: text("title").notNull(),
    caseNumber: text("case_number"),
    court: text("court"),
    courtRoom: text("court_room"),
    jurisdiction: text("jurisdiction"),
    judge: text("judge"),
    opposingParty: text("opposing_party"),
    opposingCounsel: text("opposing_counsel"),
    status: text("status").notNull().default("open"),
    priority: text("priority").default("medium"),
    description: text("description"),

    agreedFee: numeric("agreed_fee"),
    retainerAmount: numeric("retainer_amount"),
    hourlyRate: numeric("hourly_rate"),
    feeCurrency: text("fee_currency").default("JOD"),

    closeResult: text("close_result"),
    closeNote: text("close_note"),
    closedAt: timestamp("closed_at", { withTimezone: true }),

    openedAt: timestamp("opened_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("cases_owner_idx").on(table.ownerId),
    index("cases_org_idx").on(table.orgId),
    index("cases_client_idx").on(table.clientId),
    // Case list is filtered by status and sorted newest-first.
    index("cases_org_status_idx").on(table.orgId, table.status, table.createdAt.desc()),
    index("cases_title_trgm_idx").using("gin", sql`${table.title} gin_trgm_ops`),
    index("cases_case_number_idx").on(table.caseNumber),
  ],
);

/** Explicit per-case ACL, layered on top of org membership. */
export const caseMembers = pgTable(
  "case_members",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("associate"),
    addedBy: uuid("added_by").references(() => users.id, {
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
    uniqueIndex("case_members_case_user_key").on(table.caseId, table.userId),
    index("case_members_user_idx").on(table.userId),
  ],
);

export const caseNotes = pgTable(
  "case_notes",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("case_notes_case_idx").on(table.caseId, table.createdAt.desc())],
);

export const caseParties = pgTable(
  "case_parties",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    role: text("role").notNull().default("other"),
    contact: text("contact"),
    email: text("email"),
    phone: text("phone"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("case_parties_case_idx").on(table.caseId)],
);

export const caseEvents = pgTable(
  "case_events",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("update"),
    title: text("title").notNull(),
    body: text("body"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    completed: boolean("completed").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("case_events_case_idx").on(table.caseId, table.createdAt.desc()),
    index("case_events_scheduled_idx").on(table.scheduledAt),
  ],
);

export const appointments = pgTable(
  "appointments",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").references(() => cases.id, { onDelete: "set null" }),
    clientId: uuid("client_id").references(() => clients.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    description: text("description"),
    location: text("location"),
    kind: text("kind").notNull().default("meeting"),
    color: text("color"),
    allDay: boolean("all_day").notNull().default(false),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Calendar reads are always a date-window scan for one user.
    index("appointments_owner_starts_idx").on(table.ownerId, table.startsAt),
    index("appointments_case_idx").on(table.caseId),
  ],
);

export const deadlines = pgTable(
  "deadlines",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid("org_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    caseId: uuid("case_id").references(() => cases.id, { onDelete: "cascade" }),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    assignedTo: uuid("assigned_to").references(() => users.id, {
      onDelete: "set null",
    }),
    kind: text("kind").notNull().default("deadline"),
    title: text("title").notNull(),
    description: text("description"),
    location: text("location"),
    court: text("court"),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    reminderDays: integer("reminder_days")
      .array()
      .notNull()
      .default(sql`ARRAY[7, 3, 1]`),
    status: text("status").notNull().default("open"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    completedBy: uuid("completed_by").references(() => users.id, {
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
    // The reminder sweep scans open deadlines by due date across all orgs.
    index("deadlines_status_due_idx").on(table.status, table.dueAt),
    index("deadlines_org_due_idx").on(table.orgId, table.dueAt),
    index("deadlines_case_idx").on(table.caseId),
    index("deadlines_assigned_idx").on(table.assignedTo),
  ],
);

export type Case = typeof cases.$inferSelect;
export type CaseMember = typeof caseMembers.$inferSelect;
export type Deadline = typeof deadlines.$inferSelect;
export type Appointment = typeof appointments.$inferSelect;
