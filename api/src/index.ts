import { createApp } from "./http/app.ts";
import { env } from "./env.ts";
import { logger } from "./observability/logger.ts";
import { closeDatabase } from "./db/index.ts";
import { closeRedis } from "./services/redis.ts";
import { closeQueues } from "./queue/queues.ts";

const app = createApp();

const server = Bun.serve({
  port: env.PORT,
  hostname: "0.0.0.0",
  fetch: app.fetch,
  // Generous enough for large AI streams, short enough to reclaim a stuck
  // socket rather than leaking a connection slot.
  idleTimeout: 120,
});

logger.info(
  { port: env.PORT, env: env.NODE_ENV },
  "mohkam api listening",
);

/**
 * Graceful shutdown.
 *
 * Behind a load balancer, exiting immediately on SIGTERM drops in-flight
 * requests during every deploy. Instead: stop accepting new connections, let
 * active requests finish, then close backing resources. compose gives us 30s
 * (stop_grace_period) before SIGKILL, so the drain budget is set below that.
 */
const DRAIN_TIMEOUT_MS = 25_000;
let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal }, "shutdown initiated — draining");

  const forceExit = setTimeout(() => {
    logger.error("drain timed out — forcing exit");
    process.exit(1);
  }, DRAIN_TIMEOUT_MS);

  try {
    // `false` = do not abort in-flight requests; wait for them.
    await server.stop(false);
    logger.info("http server drained");

    await Promise.allSettled([closeQueues(), closeRedis(), closeDatabase()]);
    logger.info("resources closed — exiting cleanly");

    clearTimeout(forceExit);
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, "error during shutdown");
    clearTimeout(forceExit);
    process.exit(1);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// An unhandled rejection leaves the process in an unknown state. Log it and
// let the orchestrator restart a clean one rather than serving from a
// corrupted runtime.
process.on("unhandledRejection", (reason) => {
  logger.fatal({ err: reason }, "unhandled rejection");
  void shutdown("unhandledRejection");
});

process.on("uncaughtException", (error) => {
  logger.fatal({ err: error }, "uncaught exception");
  void shutdown("uncaughtException");
});
