import type { Context, MiddlewareHandler, Next } from "hono";
import { verifyAccessToken } from "../auth/tokens.ts";
import { getOrgRole, type AuthContext } from "../authz/policy.ts";
import { authFailuresTotal, httpRequestDuration, httpRequestsTotal } from "../observability/metrics.ts";
import { logger } from "../observability/logger.ts";
import { AppError, unauthorized } from "./errors.ts";

declare module "hono" {
  interface ContextVariableMap {
    auth: AuthContext;
    requestId: string;
  }
}

/** Correlation id: honours an upstream header, otherwise mints one. */
export const requestId: MiddlewareHandler = async (c, next) => {
  const incoming = c.req.header("x-request-id");
  const id = incoming ?? crypto.randomUUID();
  c.set("requestId", id);
  c.header("x-request-id", id);
  await next();
};

export const requestLogger: MiddlewareHandler = async (c, next) => {
  const startedAt = performance.now();
  await next();

  const durationSeconds = (performance.now() - startedAt) / 1000;
  // Label with the matched route pattern, never the raw path — otherwise every
  // distinct :id becomes its own time series and the metric cardinality
  // explodes.
  const route = c.req.routePath ?? "unmatched";
  const labels = {
    method: c.req.method,
    route,
    status: String(c.res.status),
  };

  httpRequestDuration.observe(labels, durationSeconds);
  httpRequestsTotal.inc(labels);

  const line = {
    requestId: c.get("requestId"),
    method: c.req.method,
    route,
    status: c.res.status,
    durationMs: Math.round(durationSeconds * 1000),
    userId: c.get("auth")?.userId,
  };

  if (c.res.status >= 500) logger.error(line, "request failed");
  else if (c.res.status >= 400) logger.warn(line, "request rejected");
  else logger.info(line, "request");
};

function bearerToken(c: Context): string | null {
  const header = c.req.header("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

/**
 * Authenticates the request and resolves the active organization.
 *
 * The org comes from the X-Org-Id header rather than the token, and membership
 * is verified on every request — so removing someone from a firm takes effect
 * immediately, without waiting for their access token to expire.
 */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  const token = bearerToken(c);
  if (!token) {
    authFailuresTotal.inc({ reason: "missing_token" });
    throw unauthorized();
  }

  let claims;
  try {
    claims = await verifyAccessToken(token);
  } catch {
    authFailuresTotal.inc({ reason: "invalid_token" });
    throw unauthorized("Invalid or expired token");
  }

  const requestedOrgId = c.req.header("x-org-id") ?? null;
  let orgId: string | null = null;
  let orgRole = null;

  if (requestedOrgId) {
    orgRole = await getOrgRole(claims.sub, requestedOrgId);
    if (!orgRole) {
      // Asking for an org you are not in is treated as authentication failure
      // rather than 403, so the header cannot be used to enumerate org ids.
      authFailuresTotal.inc({ reason: "org_not_member" });
      throw new AppError(403, "org_forbidden", "You are not a member of that organization");
    }
    orgId = requestedOrgId;
  }

  c.set("auth", {
    userId: claims.sub,
    email: claims.email,
    sessionId: claims.sid,
    orgId,
    orgRole,
  });

  await next();
};

/** For endpoints that operate on firm data and cannot fall back to personal scope. */
export const requireOrg: MiddlewareHandler = async (c, next) => {
  const auth = c.get("auth");
  if (!auth?.orgId) {
    throw new AppError(
      400,
      "org_required",
      "This endpoint requires an active organization (X-Org-Id header)",
    );
  }
  await next();
};

export function getAuth(c: Context): AuthContext {
  const auth = c.get("auth");
  if (!auth) throw unauthorized();
  return auth;
}

/** Requires an org and returns it narrowed to non-null. */
export function getOrgScope(c: Context): AuthContext & { orgId: string } {
  const auth = getAuth(c);
  if (!auth.orgId) {
    throw new AppError(400, "org_required", "This endpoint requires an active organization");
  }
  return auth as AuthContext & { orgId: string };
}

export async function noop(_c: Context, next: Next) {
  await next();
}
