import { redis } from "./redis.ts";
import { logger } from "../observability/logger.ts";

/**
 * Cache reads never throw. A Redis outage degrades this system to
 * "every request hits Postgres" — slower, but still correct and serving.
 * A cache that can take the API down is worse than no cache.
 */
export const cache = {
  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await redis.get(key);
      return raw === null ? null : (JSON.parse(raw) as T);
    } catch (error) {
      logger.warn({ err: error, key }, "cache read failed — treating as miss");
      return null;
    }
  },

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
    } catch (error) {
      logger.warn({ err: error, key }, "cache write failed — ignoring");
    }
  },

  async del(...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    try {
      await redis.del(...keys);
    } catch (error) {
      logger.warn({ err: error, keys }, "cache delete failed");
    }
  },

  /**
   * Invalidate by prefix using SCAN. Never use KEYS here — it blocks the
   * single-threaded Redis event loop for the duration of the scan.
   */
  async delByPrefix(prefix: string): Promise<void> {
    try {
      let cursor = "0";
      do {
        const [next, found] = await redis.scan(
          cursor,
          "MATCH",
          `${prefix}*`,
          "COUNT",
          200,
        );
        cursor = next;
        if (found.length > 0) await redis.del(...found);
      } while (cursor !== "0");
    } catch (error) {
      logger.warn({ err: error, prefix }, "cache prefix delete failed");
    }
  },

  /**
   * Read-through helper. Concurrent misses all compute the value — acceptable
   * here because every cached computation is a cheap indexed read, not an
   * expensive aggregate. Add a lock if that stops being true.
   */
  async remember<T>(
    key: string,
    ttlSeconds: number,
    compute: () => Promise<T>,
  ): Promise<T> {
    const hit = await this.get<T>(key);
    if (hit !== null) return hit;

    const value = await compute();
    await this.set(key, value, ttlSeconds);
    return value;
  },
};
