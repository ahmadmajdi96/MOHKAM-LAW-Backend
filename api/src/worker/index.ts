import { Worker, type Job } from "bullmq";
import { env } from "../env.ts";
import { logger } from "../observability/logger.ts";
import { queueJobsTotal, registry } from "../observability/metrics.ts";
import { createQueueConnection, closeRedis } from "../services/redis.ts";
import { closeDatabase } from "../db/index.ts";
import { QUEUE_NAMES } from "../queue/queues.ts";
import { processDocumentIndex } from "./processors/document-index.ts";
import { processAiTask } from "./processors/ai-task.ts";
import { processSms } from "./processors/sms.ts";
import { processMaintenance } from "./processors/maintenance.ts";
import { registerSchedules } from "./schedules.ts";

const connection = createQueueConnection();

function build(
  name: string,
  handler: (job: Job) => Promise<unknown>,
  concurrency: number,
) {
  const worker = new Worker(name, handler, {
    connection,
    concurrency,
    // A job that dies with its container (OOM, SIGKILL) is reclaimed after
    // this window rather than being lost.
    stalledInterval: 30_000,
    maxStalledCount: 2,
  });

  worker.on("completed", (job) => {
    queueJobsTotal.inc({ queue: name, status: "completed" });
    logger.debug({ queue: name, jobId: job.id }, "job completed");
  });

  worker.on("failed", (job, err) => {
    const exhausted = (job?.attemptsMade ?? 0) >= (job?.opts.attempts ?? 1);
    queueJobsTotal.inc({
      queue: name,
      status: exhausted ? "failed" : "retrying",
    });
    logger[exhausted ? "error" : "warn"](
      { queue: name, jobId: job?.id, attempt: job?.attemptsMade, err },
      exhausted ? "job failed permanently" : "job failed — will retry",
    );
  });

  worker.on("error", (err) => logger.error({ queue: name, err }, "worker error"));

  return worker;
}

const workers = [
  build(QUEUE_NAMES.documentIndex, processDocumentIndex, env.WORKER_CONCURRENCY),
  // AI jobs are long and upstream-rate-limited; more concurrency here just
  // converts into 429s from the provider.
  build(QUEUE_NAMES.aiTask, processAiTask, Math.max(2, Math.floor(env.WORKER_CONCURRENCY / 2))),
  build(QUEUE_NAMES.smsSend, processSms, 4),
  build(QUEUE_NAMES.maintenance, processMaintenance, 1),
];

await registerSchedules();

// Minimal HTTP surface so Prometheus can scrape worker metrics.
const server = Bun.serve({
  port: 3001,
  hostname: "0.0.0.0",
  fetch: async (req) => {
    const { pathname } = new URL(req.url);
    if (pathname === "/healthz") return new Response("ok");
    if (pathname === "/metrics") {
      return new Response(await registry.metrics(), {
        headers: { "content-type": registry.contentType },
      });
    }
    return new Response("not found", { status: 404 });
  },
});

logger.info(
  { concurrency: env.WORKER_CONCURRENCY, queues: Object.values(QUEUE_NAMES) },
  "mohkam worker started",
);

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal }, "worker shutdown — finishing active jobs");

  const forceExit = setTimeout(() => {
    logger.error("worker drain timed out — forcing exit");
    process.exit(1);
  }, 50_000);

  try {
    await server.stop(true);
    // close() stops accepting new jobs and waits for active ones to finish.
    await Promise.all(workers.map((worker) => worker.close()));
    await Promise.allSettled([closeRedis(), closeDatabase()]);
    clearTimeout(forceExit);
    logger.info("worker stopped cleanly");
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, "error during worker shutdown");
    clearTimeout(forceExit);
    process.exit(1);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
