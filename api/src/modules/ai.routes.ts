import { Hono } from "hono";
import { z } from "zod";
import { assertCaseAccess } from "../authz/policy.ts";
import { getAuth, requireAuth } from "../http/middleware.ts";
import { aiRateLimit } from "../http/rate-limit.ts";
import { validate } from "../http/validate.ts";
import { notFound, serviceUnavailable } from "../http/errors.ts";
import { features } from "../env.ts";
import { searchChunks } from "../services/retrieval.ts";
import { aiTaskQueue, enqueueAiTask } from "../queue/queues.ts";

const router = new Hono();
router.use("*", requireAuth);

/**
 * Vector search over the firm's indexed documents.
 *
 * Scoping is enforced inside the SQL predicate, not applied to the results —
 * see services/retrieval.ts. A case filter is authorized first.
 */
router.post("/search", aiRateLimit, async (c) => {
  const auth = getAuth(c);
  const body = await validate(
    c,
    z.object({
      query: z.string().min(2).max(2_000),
      caseId: z.string().uuid().optional(),
      limit: z.number().int().min(1).max(50).default(10),
      minSimilarity: z.number().min(0).max(1).default(0.25),
    }),
  );

  if (!features.ai) {
    throw serviceUnavailable("ai_unconfigured", "AI is not configured on this server");
  }

  if (body.caseId) await assertCaseAccess(auth, body.caseId);

  const results = await searchChunks({
    query: body.query,
    orgId: auth.orgId,
    ...(body.caseId ? { caseId: body.caseId } : {}),
    limit: body.limit,
    minSimilarity: body.minSimilarity,
  });

  return c.json({ data: results });
});

/**
 * Submit a long-running AI task. Returns a job id immediately — generation can
 * take 40s+, which is far too long to hold an HTTP connection open.
 */
router.post("/tasks", aiRateLimit, async (c) => {
  const auth = getAuth(c);
  const body = await validate(
    c,
    z.object({
      kind: z.enum(["summarize-case", "draft-document", "analyze-document", "research"]),
      locale: z.enum(["ar", "en"]).default("en"),
      input: z.record(z.string(), z.unknown()).default({}),
    }),
  );

  if (!features.ai) {
    throw serviceUnavailable("ai_unconfigured", "AI is not configured on this server");
  }

  // Authorize the referenced case before queueing — the worker runs outside
  // any request context and cannot check the caller's permissions later.
  if (typeof body.input.caseId === "string") {
    await assertCaseAccess(auth, body.input.caseId);
  }

  const job = await enqueueAiTask({
    kind: body.kind,
    userId: auth.userId,
    orgId: auth.orgId,
    locale: body.locale,
    input: body.input,
  });

  return c.json({ jobId: job.id, state: "queued" }, 202);
});

router.get("/tasks/:jobId", async (c) => {
  const auth = getAuth(c);
  const job = await aiTaskQueue.getJob(c.req.param("jobId"));
  if (!job) throw notFound("Task");

  // Jobs are not tenant-scoped in Redis, so ownership is checked here.
  if ((job.data as { userId?: string }).userId !== auth.userId) throw notFound("Task");

  const state = await job.getState();
  return c.json({
    jobId: job.id,
    state,
    progress: job.progress,
    result: state === "completed" ? job.returnvalue : null,
    failedReason: state === "failed" ? job.failedReason : null,
  });
});

export default router;
