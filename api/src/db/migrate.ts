import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDirectClient } from "./index.ts";
import { logger } from "../observability/logger.ts";

/**
 * Runs pending migrations, then exits. compose gates the api and worker on
 * this completing successfully, so a failed migration blocks the deploy
 * instead of leaving containers running against a half-migrated schema.
 *
 * Uses the direct connection: DDL cannot run through PgBouncer's transaction
 * pooling. Drizzle takes an advisory lock, so concurrent starts are safe —
 * only one replica applies the migrations.
 */
const client = createDirectClient();

try {
  logger.info("running migrations");
  await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
  logger.info("migrations complete");
  await client.end();
  process.exit(0);
} catch (error) {
  logger.fatal({ err: error }, "migration failed");
  await client.end().catch(() => {});
  process.exit(1);
}
