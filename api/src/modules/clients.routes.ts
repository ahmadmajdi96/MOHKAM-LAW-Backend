import { Hono } from "hono";
import { z } from "zod";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { clientInteractions, clients } from "../db/schema/crm.ts";
import { getAuth, requireAuth } from "../http/middleware.ts";
import {
  paginated,
  paginationSchema,
  validate,
  validateQuery,
} from "../http/validate.ts";
import { notFound } from "../http/errors.ts";

const router = new Hono();
router.use("*", requireAuth);

const clientInputSchema = z.object({
  name: z.string().min(1).max(300),
  type: z.enum(["individual", "company"]).optional(),
  status: z.enum(["active", "inactive", "archived"]).optional(),
  email: z.string().email().max(320).nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  company: z.string().max(300).nullable().optional(),
  nationalId: z.string().max(100).nullable().optional(),
  address: z.string().max(1000).nullable().optional(),
  country: z.string().max(100).nullable().optional(),
  taxId: z.string().max(100).nullable().optional(),
  notes: z.string().max(20_000).nullable().optional(),
  preferredSmsLanguage: z.enum(["ar", "en"]).nullable().optional(),
});

/**
 * Clients are owner-scoped (no org_id — see schema/crm.ts), widened to any
 * client attached to a case the caller can reach. Written as one EXISTS so
 * sharing does not cost an extra round trip.
 */
function visibleClients(userId: string, orgId: string | null) {
  return sql`(
    ${clients.ownerId} = ${userId}
    OR EXISTS (
      SELECT 1 FROM cases c
      WHERE c.client_id = ${clients.id}
        AND (
          c.owner_id = ${userId}
          OR c.responsible_lawyer = ${userId}
          OR EXISTS (
            SELECT 1 FROM case_members cm
            WHERE cm.case_id = c.id AND cm.user_id = ${userId}
          )
          ${orgId ? sql`OR c.org_id = ${orgId}` : sql``}
        )
    )
  )`;
}

router.get("/", async (c) => {
  const auth = getAuth(c);
  const { limit, cursor, q } = validateQuery(c, paginationSchema);

  const filters = [visibleClients(auth.userId, auth.orgId)];
  if (cursor) filters.push(lt(clients.createdAt, new Date(cursor)));
  if (q) {
    // Served by the trigram index on name; also matches phone and company.
    filters.push(
      sql`(
        ${clients.name} ILIKE ${"%" + q + "%"}
        OR ${clients.company} ILIKE ${"%" + q + "%"}
        OR ${clients.phone} ILIKE ${"%" + q + "%"}
      )`,
    );
  }

  const rows = await db
    .select()
    .from(clients)
    .where(and(...filters))
    .orderBy(desc(clients.createdAt))
    .limit(limit + 1);

  // Aggregates the list needs — open/total case counts and last interaction —
  // computed in one grouped pass over just this page's ids. Two bounded
  // queries instead of the N+1 the frontend would otherwise do per row.
  const ids = rows.map((r) => r.id);
  const aggregates = new Map<
    string,
    { activeCases: number; totalCases: number; lastInteraction: string | null }
  >();

  if (ids.length > 0) {
    const [caseCounts, lastIntr] = await Promise.all([
      db.execute<{ client_id: string; active: number; total: number }>(sql`
        SELECT client_id,
          count(*) FILTER (WHERE status IN ('open','pending','on_hold'))::int AS active,
          count(*)::int AS total
        FROM cases
        WHERE client_id = ANY(${sql`ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`,`)}]::uuid[]`})
        GROUP BY client_id
      `),
      db.execute<{ client_id: string; last: string }>(sql`
        SELECT client_id, max(occurred_at)::text AS last
        FROM client_interactions
        WHERE client_id = ANY(${sql`ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`,`)}]::uuid[]`})
        GROUP BY client_id
      `),
    ]);

    for (const id of ids) aggregates.set(id, { activeCases: 0, totalCases: 0, lastInteraction: null });
    for (const row of caseCounts) {
      const agg = aggregates.get(row.client_id)!;
      agg.activeCases = Number(row.active);
      agg.totalCases = Number(row.total);
    }
    for (const row of lastIntr) aggregates.get(row.client_id)!.lastInteraction = row.last;
  }

  const flat = rows.map((r) => ({ ...r, ...aggregates.get(r.id)! }));
  return c.json(paginated(flat, limit));
});

async function loadVisibleClient(clientId: string, userId: string, orgId: string | null) {
  const [row] = await db
    .select()
    .from(clients)
    .where(and(eq(clients.id, clientId), visibleClients(userId, orgId)))
    .limit(1);
  if (!row) throw notFound("Client");
  return row;
}

router.get("/:id", async (c) => {
  const auth = getAuth(c);
  const row = await loadVisibleClient(c.req.param("id"), auth.userId, auth.orgId);
  return c.json(row);
});

router.post("/", async (c) => {
  const auth = getAuth(c);
  const body = await validate(c, clientInputSchema);

  const [created] = await db
    .insert(clients)
    .values({ ...body, ownerId: auth.userId })
    .returning();

  return c.json(created, 201);
});

router.patch("/:id", async (c) => {
  const auth = getAuth(c);
  const existing = await loadVisibleClient(c.req.param("id"), auth.userId, auth.orgId);
  const body = await validate(c, clientInputSchema.partial());

  const [updated] = await db
    .update(clients)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(clients.id, existing.id))
    .returning();

  return c.json(updated);
});

/**
 * Deleting is restricted to the owner even though colleagues can read the
 * record through a shared case — visibility and destruction are not the same
 * permission.
 */
router.delete("/:id", async (c) => {
  const auth = getAuth(c);
  const result = await db
    .delete(clients)
    .where(and(eq(clients.id, c.req.param("id")), eq(clients.ownerId, auth.userId)));

  if (result.count === 0) throw notFound("Client");
  return c.body(null, 204);
});

router.get("/:id/interactions", async (c) => {
  const auth = getAuth(c);
  const client = await loadVisibleClient(c.req.param("id"), auth.userId, auth.orgId);
  const { limit, cursor } = validateQuery(c, paginationSchema);

  const filters = [eq(clientInteractions.clientId, client.id)];
  if (cursor) filters.push(lt(clientInteractions.createdAt, new Date(cursor)));

  const rows = await db
    .select()
    .from(clientInteractions)
    .where(and(...filters))
    .orderBy(desc(clientInteractions.occurredAt))
    .limit(limit + 1);

  return c.json(paginated(rows, limit));
});

router.post("/:id/interactions", async (c) => {
  const auth = getAuth(c);
  const client = await loadVisibleClient(c.req.param("id"), auth.userId, auth.orgId);
  const body = await validate(
    c,
    z.object({
      kind: z.string().max(50).default("note"),
      title: z.string().max(300).nullable().optional(),
      body: z.string().max(20_000).nullable().optional(),
      occurredAt: z.string().datetime().optional(),
    }),
  );

  const [created] = await db
    .insert(clientInteractions)
    .values({
      clientId: client.id,
      ownerId: auth.userId,
      kind: body.kind,
      title: body.title ?? null,
      body: body.body ?? null,
      ...(body.occurredAt ? { occurredAt: new Date(body.occurredAt) } : {}),
    })
    .returning();

  return c.json(created, 201);
});

/**
 * Interaction update/delete are keyed by interaction id and scoped by owner —
 * you edit or remove only interactions you authored, independent of who can
 * see the client.
 */
router.patch("/interactions/:interactionId", async (c) => {
  const auth = getAuth(c);
  const body = await validate(
    c,
    z.object({
      kind: z.string().max(50).optional(),
      title: z.string().max(300).nullable().optional(),
      body: z.string().max(20_000).nullable().optional(),
    }),
  );

  const [updated] = await db
    .update(clientInteractions)
    .set(body)
    .where(
      and(
        eq(clientInteractions.id, c.req.param("interactionId")),
        eq(clientInteractions.ownerId, auth.userId),
      ),
    )
    .returning();

  if (!updated) throw notFound("Interaction");
  return c.json(updated);
});

router.delete("/interactions/:interactionId", async (c) => {
  const auth = getAuth(c);
  const result = await db
    .delete(clientInteractions)
    .where(
      and(
        eq(clientInteractions.id, c.req.param("interactionId")),
        eq(clientInteractions.ownerId, auth.userId),
      ),
    );
  if (result.count === 0) throw notFound("Interaction");
  return c.body(null, 204);
});

/**
 * Conflict check — fuzzy name match plus exact identity match across the
 * caller's clients, backing the "conflict of interest" screen before a new
 * client or matter is opened. Trigram-indexed, so ILIKE stays fast.
 */
router.post("/conflict-check", async (c) => {
  const auth = getAuth(c);
  const body = await validate(
    c,
    z.object({
      name: z.string().min(2).max(300),
      nationalId: z.string().max(100).optional(),
      taxId: z.string().max(100).optional(),
      email: z.string().max(320).optional(),
      phone: z.string().max(40).optional(),
    }),
  );

  const visible = visibleClients(auth.userId, auth.orgId);
  const tokens = body.name.trim().split(/\s+/).filter((t) => t.length >= 2);
  const nameClause =
    tokens.length > 0
      ? sql`(${sql.join(
          tokens.map((t) => sql`${clients.name} ILIKE ${"%" + t.replace(/[%_]/g, "\\$&") + "%"}`),
          sql` OR `,
        )})`
      : sql`${clients.name} ILIKE ${"%" + body.name.trim() + "%"}`;

  const nameMatches = await db
    .select()
    .from(clients)
    .where(and(visible, nameClause))
    .limit(25);

  // Exact identity matches are the strongest signal — surfaced separately.
  const identityClauses = [
    body.nationalId ? eq(clients.nationalId, body.nationalId.trim()) : null,
    body.taxId ? eq(clients.taxId, body.taxId.trim()) : null,
    body.email ? sql`${clients.email} ILIKE ${body.email.trim()}` : null,
    body.phone && body.phone.replace(/\D/g, "").length >= 6
      ? sql`${clients.phone} ILIKE ${"%" + body.phone.replace(/\D/g, "").slice(-8) + "%"}`
      : null,
  ].filter(Boolean) as ReturnType<typeof eq>[];

  const identityMatches =
    identityClauses.length > 0
      ? await db
          .select()
          .from(clients)
          .where(and(visible, or(...identityClauses)))
          .limit(25)
      : [];

  return c.json({ nameMatches, identityMatches });
});

export default router;
