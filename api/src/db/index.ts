import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../env.ts";
import { logger } from "../observability/logger.ts";
import * as schema from "./schema/index.ts";

/**
 * Connections go through PgBouncer in transaction pooling mode, which cannot
 * support server-side prepared statements or LISTEN/NOTIFY. `prepare: false`
 * is mandatory here — without it queries fail intermittently under load, once
 * a pooled backend is reused by a different client.
 */
const client = postgres(env.DATABASE_URL, {
  max: env.DB_POOL_MAX,
  idle_timeout: 30,
  connect_timeout: 10,
  prepare: false,
  onnotice: () => {},
  transform: { undefined: null },
});

export const db = drizzle(client, { schema, casing: "snake_case" });

export type Database = typeof db;

/**
 * A direct (non-pooled) connection for migrations and anything needing
 * session state. Callers own the lifecycle and must close it.
 */
export function createDirectClient() {
  return postgres(env.DATABASE_DIRECT_URL ?? env.DATABASE_URL, {
    max: 1,
    prepare: false,
    onnotice: () => {},
  });
}

export async function checkDatabase(): Promise<boolean> {
  try {
    await client`SELECT 1`;
    return true;
  } catch (error) {
    logger.error({ err: error }, "database healthcheck failed");
    return false;
  }
}

export async function closeDatabase() {
  await client.end({ timeout: 5 });
}

export { schema };
