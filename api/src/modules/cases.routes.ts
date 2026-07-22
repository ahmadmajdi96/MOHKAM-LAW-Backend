import { Hono } from "hono";
import { z } from "zod";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { caseMembers, cases } from "../db/schema/cases.ts";
import { activityLog } from "../db/schema/audit.ts";
import {
  CAN_WRITE_CASES,
  assertCaseAccess,
  assertOrgRole,
} from "../authz/policy.ts";
import { getAuth, requireAuth } from "../http/middleware.ts";
import { paginated, paginationSchema, validate, validateQuery } from "../http/validate.ts";
import { notFound } from "../http/errors.ts";

const router = new Hono();
router.use("*", requireAuth);

const caseInputSchema = z.object({
  title: z.string().min(1).max(300),
  clientId: z.string().uuid().nullable().optional(),
  caseNumber: z.string().max(100).nullable().optional(),
  court: z.string().max(200).nullable().optional(),
  courtRoom: z.string().max(100).nullable().optional(),
  jurisdiction: z.string().max(200).nullable().optional(),
  judge: z.string().max(200).nullable().optional(),
  opposingParty: z.string().max(300).nullable().optional(),
  opposingCounsel: z.string().max(300).nullable().optional(),
  status: z.enum(["open", "closed", "on_hold", "archived"]).optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).nullable().optional(),
  description: z.string().max(20_000).nullable().optional(),
  responsibleLawyer: z.string().uuid().nullable().optional(),
  agreedFee: z.string().nullable().optional(),
  retainerAmount: z.string().nullable().optional(),
  hourlyRate: z.string().nullable().optional(),
  feeCurrency: z.string().length(3).nullable().optional(),
});

/**
 * List — every case the caller can reach: owned, assigned, explicitly shared,
 * or belonging to the active org. The visibility predicate is built here once
 * rather than trusting each caller to remember it.
 */
router.get("/", async (c) => {
  const auth = getAuth(c);
  const { limit, cursor, q } = validateQuery(c, paginationSchema);

  const visible = or(
    eq(cases.ownerId, auth.userId),
    eq(cases.responsibleLawyer, auth.userId),
    sql`EXISTS (
      SELECT 1 FROM case_members cm
      WHERE cm.case_id = ${cases.id} AND cm.user_id = ${auth.userId}
    )`,
    auth.orgId ? eq(cases.orgId, auth.orgId) : sql`false`,
  );

  const filters = [visible];
  if (cursor) filters.push(lt(cases.createdAt, new Date(cursor)));
  if (q) {
    filters.push(
      or(
        sql`${cases.title} ILIKE ${"%" + q + "%"}`,
        sql`${cases.caseNumber} ILIKE ${"%" + q + "%"}`,
      )!,
    );
  }

  // clientId filter, including the special value "null" for unassigned cases —
  // backs the client detail view and the "attach case" picker.
  const clientId = c.req.query("clientId");
  if (clientId === "null") filters.push(sql`${cases.clientId} IS NULL`);
  else if (clientId) filters.push(eq(cases.clientId, clientId));

  const status = c.req.query("status");
  if (status) filters.push(eq(cases.status, status));

  const rows = await db
    .select()
    .from(cases)
    .where(and(...filters))
    .orderBy(desc(cases.createdAt))
    // Fetch one extra row to detect whether another page exists, without a
    // second COUNT query.
    .limit(limit + 1);

  return c.json(paginated(rows, limit));
});

router.get("/:id", async (c) => {
  const auth = getAuth(c);
  // Throws 404 for both "missing" and "not yours" — see authz/policy.ts.
  const row = await assertCaseAccess(auth, c.req.param("id"));

  const members = await db
    .select({
      userId: caseMembers.userId,
      role: caseMembers.role,
      createdAt: caseMembers.createdAt,
    })
    .from(caseMembers)
    .where(eq(caseMembers.caseId, row.id));

  return c.json({ ...row, members });
});

router.post("/", async (c) => {
  const auth = getAuth(c);
  const body = await validate(c, caseInputSchema);

  if (auth.orgId) {
    await assertOrgRole(auth, auth.orgId, CAN_WRITE_CASES, "case:create");
  }

  const created = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(cases)
      .values({ ...body, ownerId: auth.userId, orgId: auth.orgId })
      .returning();

    if (!row) throw new Error("case insert returned no row");

    await tx.insert(activityLog).values({
      orgId: auth.orgId,
      actorId: auth.userId,
      entityType: "case",
      entityId: row.id,
      caseId: row.id,
      action: "created",
      summary: row.title,
    });

    return row;
  });

  return c.json(created, 201);
});

router.patch("/:id", async (c) => {
  const auth = getAuth(c);
  const existing = await assertCaseAccess(auth, c.req.param("id"));
  const body = await validate(c, caseInputSchema.partial());

  if (existing.orgId) {
    await assertOrgRole(auth, existing.orgId, CAN_WRITE_CASES, "case:update");
  }

  const [updated] = await db
    .update(cases)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(cases.id, existing.id))
    .returning();

  await db.insert(activityLog).values({
    orgId: existing.orgId,
    actorId: auth.userId,
    entityType: "case",
    entityId: existing.id,
    caseId: existing.id,
    action: "updated",
    metadata: { fields: Object.keys(body) },
  });

  return c.json(updated);
});

/**
 * Closing is a distinct operation rather than a status PATCH: it records the
 * outcome and timestamp together, which the analytics views depend on.
 */
router.post("/:id/close", async (c) => {
  const auth = getAuth(c);
  const existing = await assertCaseAccess(auth, c.req.param("id"));
  const body = await validate(
    c,
    z.object({
      result: z.enum(["won", "lost", "settled", "withdrawn", "other"]),
      note: z.string().max(5_000).optional(),
    }),
  );

  if (existing.orgId) {
    await assertOrgRole(auth, existing.orgId, CAN_WRITE_CASES, "case:close");
  }

  const [updated] = await db
    .update(cases)
    .set({
      status: "closed",
      closeResult: body.result,
      closeNote: body.note ?? null,
      closedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(cases.id, existing.id))
    .returning();

  await db.insert(activityLog).values({
    orgId: existing.orgId,
    actorId: auth.userId,
    entityType: "case",
    entityId: existing.id,
    caseId: existing.id,
    action: "closed",
    summary: body.result,
  });

  return c.json(updated);
});

router.post("/:id/members", async (c) => {
  const auth = getAuth(c);
  const existing = await assertCaseAccess(auth, c.req.param("id"));
  const body = await validate(
    c,
    z.object({
      userId: z.string().uuid(),
      role: z.string().max(50).default("associate"),
    }),
  );

  if (existing.orgId) {
    await assertOrgRole(auth, existing.orgId, CAN_WRITE_CASES, "case:share");
  }

  const [member] = await db
    .insert(caseMembers)
    .values({ caseId: existing.id, userId: body.userId, role: body.role, addedBy: auth.userId })
    .onConflictDoUpdate({
      target: [caseMembers.caseId, caseMembers.userId],
      set: { role: body.role, updatedAt: new Date() },
    })
    .returning();

  return c.json(member, 201);
});

router.delete("/:id/members/:userId", async (c) => {
  const auth = getAuth(c);
  const existing = await assertCaseAccess(auth, c.req.param("id"));

  if (existing.orgId) {
    await assertOrgRole(auth, existing.orgId, CAN_WRITE_CASES, "case:share");
  }

  const result = await db
    .delete(caseMembers)
    .where(
      and(
        eq(caseMembers.caseId, existing.id),
        eq(caseMembers.userId, c.req.param("userId")),
      ),
    );

  if (result.count === 0) throw notFound("Case member");
  return c.body(null, 204);
});

export default router;
