import { Hono } from "hono";
import { z } from "zod";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { timeEntries } from "../db/schema/billing.ts";
import { getAuth, requireAuth } from "../http/middleware.ts";
import { paginated, paginationSchema, validate, validateQuery } from "../http/validate.ts";
import { conflict, notFound } from "../http/errors.ts";

/**
 * Time entries — owner-scoped (each lawyer logs their own time). Includes a
 * start/stop timer whose "one running timer per user" rule is enforced in the
 * database (a partial unique index), so a double-tap on start cannot create two.
 */
const router = new Hono();
router.use("*", requireAuth);

router.get("/", async (c) => {
  const auth = getAuth(c);
  const { limit, cursor } = validateQuery(c, paginationSchema);

  const filters = [eq(timeEntries.ownerId, auth.userId)];
  if (cursor) filters.push(lt(timeEntries.createdAt, new Date(cursor)));
  const caseId = c.req.query("caseId");
  if (caseId) filters.push(eq(timeEntries.caseId, caseId));

  const rows = await db
    .select()
    .from(timeEntries)
    .where(and(...filters))
    .orderBy(desc(timeEntries.startedAt))
    .limit(limit + 1);
  return c.json(paginated(rows, limit));
});

/** The currently-running timer for this user, if any. */
router.get("/running", async (c) => {
  const auth = getAuth(c);
  const [row] = await db
    .select()
    .from(timeEntries)
    .where(and(eq(timeEntries.ownerId, auth.userId), eq(timeEntries.isRunning, true)))
    .limit(1);
  return c.json({ running: row ?? null });
});

const entryInput = z.object({
  caseId: z.string().uuid().nullable().optional(),
  clientId: z.string().uuid().nullable().optional(),
  description: z.string().max(2_000).default(""),
  activityType: z.string().max(50).default("work"),
  startedAt: z.string().datetime().optional(),
  endedAt: z.string().datetime().nullable().optional(),
  durationSeconds: z.number().int().min(0).default(0),
  hourlyRate: z.string().nullable().optional(),
  currency: z.string().length(3).default("JOD"),
  billable: z.boolean().default(true),
});

/** Log a completed entry (manual time). */
router.post("/", async (c) => {
  const auth = getAuth(c);
  const body = await validate(c, entryInput);

  const [row] = await db
    .insert(timeEntries)
    .values({
      ownerId: auth.userId,
      caseId: body.caseId ?? null,
      clientId: body.clientId ?? null,
      description: body.description,
      activityType: body.activityType,
      ...(body.startedAt ? { startedAt: new Date(body.startedAt) } : {}),
      endedAt: body.endedAt ? new Date(body.endedAt) : null,
      durationSeconds: body.durationSeconds,
      hourlyRate: body.hourlyRate ?? null,
      currency: body.currency,
      billable: body.billable,
      status: "logged",
      isRunning: false,
    })
    .returning();

  return c.json(row, 201);
});

/** Start a timer. The DB unique index rejects a second concurrent start. */
router.post("/start", async (c) => {
  const auth = getAuth(c);
  const body = await validate(
    c,
    z.object({
      caseId: z.string().uuid().nullable().optional(),
      clientId: z.string().uuid().nullable().optional(),
      description: z.string().max(2_000).default(""),
    }),
  );

  try {
    const [row] = await db
      .insert(timeEntries)
      .values({
        ownerId: auth.userId,
        caseId: body.caseId ?? null,
        clientId: body.clientId ?? null,
        description: body.description,
        startedAt: new Date(),
        isRunning: true,
        status: "running",
      })
      .returning();
    return c.json(row, 201);
  } catch (err) {
    // Partial unique index violation → a timer is already running. The pg error
    // code can sit on the error or its cause depending on how the driver wraps
    // it, so check both plus the index name as a fallback.
    const e = err as { code?: string; cause?: { code?: string }; message?: string };
    const isUniqueViolation =
      e.code === "23505" ||
      e.cause?.code === "23505" ||
      (e.message?.includes("time_entries_one_running_per_user") ?? false);
    if (isUniqueViolation) {
      throw conflict("timer_running", "You already have a running timer");
    }
    throw err;
  }
});

/** Stop the running timer, computing duration from started_at. */
router.post("/:id/stop", async (c) => {
  const auth = getAuth(c);
  const [row] = await db
    .update(timeEntries)
    .set({
      isRunning: false,
      status: "logged",
      endedAt: new Date(),
      durationSeconds: sql`GREATEST(0, EXTRACT(EPOCH FROM (now() - ${timeEntries.startedAt}))::int)`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(timeEntries.id, c.req.param("id")),
        eq(timeEntries.ownerId, auth.userId),
        eq(timeEntries.isRunning, true),
      ),
    )
    .returning();

  if (!row) throw notFound("Running timer");
  return c.json(row);
});

router.patch("/:id", async (c) => {
  const auth = getAuth(c);
  const { startedAt, endedAt, ...rest } = await validate(c, entryInput.partial());
  const [row] = await db
    .update(timeEntries)
    .set({
      ...rest,
      ...(startedAt ? { startedAt: new Date(startedAt) } : {}),
      ...(endedAt ? { endedAt: new Date(endedAt) } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(timeEntries.id, c.req.param("id")), eq(timeEntries.ownerId, auth.userId)))
    .returning();
  if (!row) throw notFound("Time entry");
  return c.json(row);
});

router.delete("/:id", async (c) => {
  const auth = getAuth(c);
  const result = await db
    .delete(timeEntries)
    .where(and(eq(timeEntries.id, c.req.param("id")), eq(timeEntries.ownerId, auth.userId)));
  if (result.count === 0) throw notFound("Time entry");
  return c.body(null, 204);
});

export default router;
