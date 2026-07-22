import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.ts";
import { organizations } from "./org.ts";
import { cases } from "./cases.ts";

/**
 * Append-only audit trail. Legal practice records carry retention and
 * accountability obligations, so rows here are never updated or deleted by
 * application code — see the revoke grants in the migration.
 */
export const activityLog = pgTable(
  "activity_log",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid("org_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    actorId: uuid("actor_id").references(() => users.id, {
      onDelete: "set null",
    }),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id"),
    caseId: uuid("case_id").references(() => cases.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    summary: text("summary"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("activity_log_org_created_idx").on(table.orgId, table.createdAt.desc()),
    index("activity_log_case_idx").on(table.caseId, table.createdAt.desc()),
    index("activity_log_entity_idx").on(table.entityType, table.entityId),
    index("activity_log_actor_idx").on(table.actorId),
  ],
);

export type ActivityLogEntry = typeof activityLog.$inferSelect;
