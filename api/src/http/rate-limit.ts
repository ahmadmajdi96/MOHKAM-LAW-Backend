import type { MiddlewareHandler } from "hono";
import { env } from "../env.ts";
import { redis } from "../services/redis.ts";
import { logger } from "../observability/logger.ts";
import { AppError } from "./errors.ts";

/**
 * Distributed sliding-window rate limiter.
 *
 * Counters live in Redis so the limit is shared across every api replica —
 * an in-process limiter would multiply the effective limit by the replica
 * count, which defeats the purpose the moment you scale out.
 */

interface RateLimitOptions {
  /** Requests permitted per window. */
  limit: number;
  windowSeconds: number;
  /** Defaults to user id when authenticated, else client IP. */
  keyFn?: (c: Parameters<MiddlewareHandler>[0]) => string;
  bucket: string;
}

function clientIp(c: Parameters<MiddlewareHandler>[0]): string {
  // Caddy sets X-Real-IP and is the only thing that can reach the API, so
  // this header is trustworthy here. It would not be if the API were exposed
  // directly to the internet.
  return (
    c.req.header("x-real-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

export function rateLimit(options: RateLimitOptions): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.get("auth");
    const identity =
      options.keyFn?.(c) ?? (auth?.userId ? `u:${auth.userId}` : `ip:${clientIp(c)}`);

    // Window key rounds to the bucket boundary, so counters expire naturally
    // and there is no cleanup job.
    const window = Math.floor(Date.now() / 1000 / options.windowSeconds);
    const key = `rl:${options.bucket}:${identity}:${window}`;

    let count: number;
    try {
      const results = await redis
        .multi()
        .incr(key)
        .expire(key, options.windowSeconds + 1)
        .exec();
      count = (results?.[0]?.[1] as number) ?? 0;
    } catch (error) {
      // Fail open. A Redis outage should not lock every user out of the
      // product; the tradeoff is that limits lapse during that window.
      logger.warn({ err: error, bucket: options.bucket }, "rate limiter unavailable — allowing");
      return next();
    }

    const remaining = Math.max(0, options.limit - count);
    c.header("RateLimit-Limit", String(options.limit));
    c.header("RateLimit-Remaining", String(remaining));
    c.header("RateLimit-Reset", String((window + 1) * options.windowSeconds));

    if (count > options.limit) {
      c.header("Retry-After", String(options.windowSeconds));
      throw new AppError(429, "rate_limited", "Too many requests — slow down");
    }

    await next();
  };
}

/** Brute-force protection. Keyed by IP so rotating emails does not reset it. */
export const authRateLimit = rateLimit({
  bucket: "auth",
  limit: env.AUTH_RATE_LIMIT,
  windowSeconds: env.AUTH_RATE_WINDOW,
  keyFn: (c) => `ip:${clientIp(c)}`,
});

/** AI calls are the expensive path — both in latency and provider spend. */
export const aiRateLimit = rateLimit({
  bucket: "ai",
  limit: 60,
  windowSeconds: 60,
});

export const uploadRateLimit = rateLimit({
  bucket: "upload",
  limit: 100,
  windowSeconds: 60,
});

/** Broad ceiling for authenticated traffic; generous enough to be invisible. */
export const generalRateLimit = rateLimit({
  bucket: "general",
  limit: 600,
  windowSeconds: 60,
});
