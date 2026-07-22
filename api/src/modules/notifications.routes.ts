import { Hono } from "hono";
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { notifications } from "../db/schema/comms.ts";
import { getAuth, requireAuth } from "../http/middleware.ts";
import { paginated, paginationSchema, validateQuery } from "../http/validate.ts";
import { notFound } from "../http/errors.ts";

/**
 * Notifications — always the caller's own. The unread count is served from a
 * partial index, so the bell badge stays O(unread) rather than scanning every
 * notification the user has ever received.
 */
const router = new Hono();
router.use("*", requireAuth);

router.get("/", async (c) => {
  const auth = getAuth(c);
  const { limit, cursor } = validateQuery(c, paginationSchema);

  const filters = [eq(notifications.userId, auth.userId)];
  if (cursor) filters.push(lt(notifications.createdAt, new Date(cursor)));
  if (c.req.query("unread") === "true") filters.push(isNull(notifications.readAt));

  const rows = await db
    .select()
    .from(notifications)
    .where(and(...filters))
    .orderBy(desc(notifications.createdAt))
    .limit(limit + 1);
  return c.json(paginated(rows, limit));
});

router.get("/unread-count", async (c) => {
  const auth = getAuth(c);
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.userId, auth.userId), isNull(notifications.readAt)));
  return c.json({ count: row?.count ?? 0 });
});

router.post("/:id/read", async (c) => {
  const auth = getAuth(c);
  const [row] = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.id, c.req.param("id")),
        eq(notifications.userId, auth.userId),
        isNull(notifications.readAt),
      ),
    )
    .returning();
  // Idempotent: already-read (or unknown-to-you) returns the current state.
  if (!row) {
    const [existing] = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.id, c.req.param("id")), eq(notifications.userId, auth.userId)))
      .limit(1);
    if (!existing) throw notFound("Notification");
    return c.json(existing);
  }
  return c.json(row);
});

router.post("/read-all", async (c) => {
  const auth = getAuth(c);
  const result = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, auth.userId), isNull(notifications.readAt)));
  return c.json({ marked: result.count ?? 0 });
});

export default router;
