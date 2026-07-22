import { Hono } from "hono";
import { checkDatabase } from "../db/index.ts";
import { checkRedis } from "../services/redis.ts";
import { checkStorage } from "../services/storage.ts";
import { registry } from "../observability/metrics.ts";
import { features } from "../env.ts";

const router = new Hono();

/**
 * Liveness. Deliberately checks nothing external: if this returns 200 the
 * process is running, and that is all a restart decision should depend on.
 * Wiring dependency checks in here means a Redis blip restarts every API
 * container, turning a degradation into an outage.
 */
router.get("/healthz", (c) => c.json({ status: "ok" }));

/**
 * Readiness. Checks dependencies, and is what the load balancer should use to
 * decide whether to route traffic here.
 */
router.get("/readyz", async (c) => {
  const [database, redis, storage] = await Promise.all([
    checkDatabase(),
    checkRedis(),
    checkStorage(),
  ]);

  const ready = database && redis && storage;
  return c.json(
    {
      status: ready ? "ready" : "degraded",
      checks: { database, redis, storage },
      features,
    },
    ready ? 200 : 503,
  );
});

/** Prometheus scrape target. Reachable only on the internal network. */
router.get("/metrics", async (c) => {
  c.header("content-type", registry.contentType);
  return c.body(await registry.metrics());
});

export default router;
