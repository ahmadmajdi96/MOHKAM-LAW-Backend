import { Hono } from "hono";
import { z } from "zod";
import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { appointments, deadlines } from "../db/schema/cases.ts";
import { assertCaseAccess } from "../authz/policy.ts";
import { getAuth, requireAuth } from "../http/middleware.ts";
import { validate } from "../http/validate.ts";
import { notFound } from "../http/errors.ts";

/**
 * Calendar — appointments and deadlines. Both are read as date-window scans
 * (the calendar shows a month), so these list by range rather than keyset
 * pagination; the window bounds the result size.
 */
const router = new Hono();
router.use("*", requireAuth);

// ------------------------------------------------------------ appointments

router.get("/appointments", async (c) => {
  const auth = getAuth(c);
  const from = c.req.query("from");
  const to = c.req.query("to");

  const filters = [eq(appointments.ownerId, auth.userId)];
  if (from) filters.push(gte(appointments.startsAt, new Date(from)));
  if (to) filters.push(lte(appointments.startsAt, new Date(to)));
  const caseId = c.req.query("caseId");
  if (caseId) filters.push(eq(appointments.caseId, caseId));

  const rows = await db
    .select()
    .from(appointments)
    .where(and(...filters))
    .orderBy(asc(appointments.startsAt))
    .limit(500);
  return c.json({ data: rows });
});

const appointmentInput = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(5_000).nullable().optional(),
  location: z.string().max(300).nullable().optional(),
  kind: z.string().max(50).default("meeting"),
  caseId: z.string().uuid().nullable().optional(),
  clientId: z.string().uuid().nullable().optional(),
  color: z.string().max(20).nullable().optional(),
  allDay: z.boolean().default(false),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
});

router.post("/appointments", async (c) => {
  const auth = getAuth(c);
  const body = await validate(c, appointmentInput);
  if (body.caseId) await assertCaseAccess(auth, body.caseId);

  const [row] = await db
    .insert(appointments)
    .values({
      ownerId: auth.userId,
      title: body.title,
      description: body.description ?? null,
      location: body.location ?? null,
      kind: body.kind,
      caseId: body.caseId ?? null,
      clientId: body.clientId ?? null,
      color: body.color ?? null,
      allDay: body.allDay,
      startsAt: new Date(body.startsAt),
      endsAt: new Date(body.endsAt),
    })
    .returning();
  return c.json(row, 201);
});

router.patch("/appointments/:id", async (c) => {
  const auth = getAuth(c);
  const { startsAt, endsAt, ...rest } = await validate(c, appointmentInput.partial());
  const [row] = await db
    .update(appointments)
    .set({
      ...rest,
      ...(startsAt ? { startsAt: new Date(startsAt) } : {}),
      ...(endsAt ? { endsAt: new Date(endsAt) } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(appointments.id, c.req.param("id")), eq(appointments.ownerId, auth.userId)))
    .returning();
  if (!row) throw notFound("Appointment");
  return c.json(row);
});

router.delete("/appointments/:id", async (c) => {
  const auth = getAuth(c);
  const result = await db
    .delete(appointments)
    .where(and(eq(appointments.id, c.req.param("id")), eq(appointments.ownerId, auth.userId)));
  if (result.count === 0) throw notFound("Appointment");
  return c.body(null, 204);
});

// --------------------------------------------------------------- deadlines

router.get("/deadlines", async (c) => {
  const auth = getAuth(c);
  const status = c.req.query("status");

  // Deadlines are visible if owned, assigned, or in the active org.
  const visible = sql`(
    ${deadlines.ownerId} = ${auth.userId}
    OR ${deadlines.assignedTo} = ${auth.userId}
    ${auth.orgId ? sql`OR ${deadlines.orgId} = ${auth.orgId}` : sql``}
  )`;

  const filters = [visible];
  if (status) filters.push(eq(deadlines.status, status));
  const caseId = c.req.query("caseId");
  if (caseId) filters.push(eq(deadlines.caseId, caseId));

  const rows = await db
    .select()
    .from(deadlines)
    .where(and(...filters))
    .orderBy(asc(deadlines.dueAt))
    .limit(500);
  return c.json({ data: rows });
});

const deadlineInput = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(5_000).nullable().optional(),
  kind: z.string().max(50).default("deadline"),
  caseId: z.string().uuid().nullable().optional(),
  court: z.string().max(200).nullable().optional(),
  location: z.string().max(300).nullable().optional(),
  dueAt: z.string().datetime(),
  reminderDays: z.array(z.number().int()).optional(),
  assignedTo: z.string().uuid().nullable().optional(),
});

router.post("/deadlines", async (c) => {
  const auth = getAuth(c);
  const body = await validate(c, deadlineInput);
  if (body.caseId) await assertCaseAccess(auth, body.caseId);

  const [row] = await db
    .insert(deadlines)
    .values({
      ownerId: auth.userId,
      orgId: auth.orgId,
      title: body.title,
      description: body.description ?? null,
      kind: body.kind,
      caseId: body.caseId ?? null,
      court: body.court ?? null,
      location: body.location ?? null,
      dueAt: new Date(body.dueAt),
      ...(body.reminderDays ? { reminderDays: body.reminderDays } : {}),
      assignedTo: body.assignedTo ?? null,
    })
    .returning();
  return c.json(row, 201);
});

/** Complete a deadline — records who closed it and when, like case close. */
router.post("/deadlines/:id/complete", async (c) => {
  const auth = getAuth(c);
  const [row] = await db
    .update(deadlines)
    .set({
      status: "done",
      completedAt: new Date(),
      completedBy: auth.userId,
      updatedAt: new Date(),
    })
    .where(eq(deadlines.id, c.req.param("id")))
    .returning();
  if (!row) throw notFound("Deadline");
  return c.json(row);
});

router.patch("/deadlines/:id", async (c) => {
  const auth = getAuth(c);
  const { dueAt, ...rest } = await validate(c, deadlineInput.partial());
  const [row] = await db
    .update(deadlines)
    .set({
      ...rest,
      ...(dueAt ? { dueAt: new Date(dueAt) } : {}),
      updatedAt: new Date(),
    })
    .where(eq(deadlines.id, c.req.param("id")))
    .returning();
  if (!row) throw notFound("Deadline");
  return c.json(row);
});

router.delete("/deadlines/:id", async (c) => {
  const auth = getAuth(c);
  const result = await db
    .delete(deadlines)
    .where(and(eq(deadlines.id, c.req.param("id")), eq(deadlines.ownerId, auth.userId)));
  if (result.count === 0) throw notFound("Deadline");
  return c.body(null, 204);
});

export default router;
