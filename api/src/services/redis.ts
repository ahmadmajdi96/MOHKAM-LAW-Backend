import { Redis } from "ioredis";
import { env } from "../env.ts";
import { logger } from "../observability/logger.ts";

function build(label: string, overrides: Record<string, unknown> = {}) {
  const client = new Redis(env.REDIS_URL, {
    // Fail the request rather than queueing forever when Redis is down —
    // callers treat cache errors as a miss and fall through to Postgres.
    maxRetriesPerRequest: 3,
    enableOfflineQueue: false,
    lazyConnect: false,
    retryStrategy: (times) => Math.min(times * 200, 3_000),
    ...overrides,
  });

  client.on("error", (err) => logger.error({ err, label }, "redis error"));
  client.on("reconnecting", () => logger.warn({ label }, "redis reconnecting"));

  return client;
}

/** General-purpose cache + rate-limit counters. */
export const redis = build("cache");

/**
 * BullMQ requires its own connection with blocking commands enabled and
 * retries disabled; sharing the cache client corrupts both.
 */
export function createQueueConnection() {
  return build("queue", {
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
  });
}

export async function checkRedis(): Promise<boolean> {
  try {
    return (await redis.ping()) === "PONG";
  } catch (error) {
    logger.error({ err: error }, "redis healthcheck failed");
    return false;
  }
}

export async function closeRedis() {
  await redis.quit().catch(() => redis.disconnect());
}
