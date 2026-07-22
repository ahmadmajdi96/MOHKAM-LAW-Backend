import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { bodyLimit } from "hono/body-limit";
import { env } from "../env.ts";
import { logger } from "../observability/logger.ts";
import { AppError } from "./errors.ts";
import { requestId, requestLogger } from "./middleware.ts";
import { generalRateLimit } from "./rate-limit.ts";

import healthRoutes from "../modules/health.routes.ts";
import authRoutes from "../modules/auth.routes.ts";
import organizationRoutes from "../modules/organizations.routes.ts";
import clientRoutes from "../modules/clients.routes.ts";
import caseRoutes from "../modules/cases.routes.ts";
import documentRoutes from "../modules/documents.routes.ts";
import aiRoutes from "../modules/ai.routes.ts";
import financialsRoutes from "../modules/financials.routes.ts";
import timeEntryRoutes from "../modules/time-entries.routes.ts";
import calendarRoutes from "../modules/calendar.routes.ts";
import notificationRoutes from "../modules/notifications.routes.ts";

export function createApp() {
  const app = new Hono();

  // Health and metrics come first and skip every other middleware — they must
  // stay answerable when the app is rate-limited or degraded.
  app.route("/", healthRoutes);

  app.use("*", requestId);
  app.use("*", requestLogger);
  app.use("*", secureHeaders());

  app.use(
    "*",
    cors({
      origin: env.CORS_ORIGINS,
      allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization", "X-Org-Id", "X-Request-Id"],
      exposeHeaders: ["X-Request-Id", "RateLimit-Remaining", "RateLimit-Reset"],
      credentials: true,
      maxAge: 86_400,
    }),
  );

  // 1MB is ample for JSON. Actual file bytes never traverse the API — they go
  // to object storage via presigned URLs.
  app.use("*", bodyLimit({ maxSize: 1024 * 1024 }));

  app.use("/v1/*", generalRateLimit);

  app.route("/v1/auth", authRoutes);
  app.route("/v1/orgs", organizationRoutes);
  app.route("/v1/clients", clientRoutes);
  app.route("/v1/cases", caseRoutes);
  app.route("/v1/documents", documentRoutes);
  app.route("/v1/ai", aiRoutes);
  app.route("/v1/financials", financialsRoutes);
  app.route("/v1/time-entries", timeEntryRoutes);
  app.route("/v1/calendar", calendarRoutes);
  app.route("/v1/notifications", notificationRoutes);

  app.notFound((c) =>
    c.json({ error: { code: "not_found", message: "No such endpoint" } }, 404),
  );

  app.onError((err, c) => {
    const requestIdValue = c.get("requestId");

    if (err instanceof AppError) {
      return c.json(
        {
          error: {
            code: err.code,
            message: err.message,
            ...(err.details ? { details: err.details } : {}),
          },
          requestId: requestIdValue,
        },
        err.status as 400,
      );
    }

    // Anything unrecognised is a bug. Log it in full, but return an opaque
    // message — stack traces and driver errors must not reach the client.
    logger.error({ err, requestId: requestIdValue }, "unhandled error");

    return c.json(
      {
        error: {
          code: "internal_error",
          message: "Something went wrong on our end",
        },
        requestId: requestIdValue,
      },
      500,
    );
  });

  return app;
}
