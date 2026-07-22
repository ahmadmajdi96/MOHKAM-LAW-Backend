/**
 * Container HEALTHCHECK probe.
 *
 * Hits liveness, not readiness: Docker restarts an unhealthy container, and a
 * momentarily unreachable Redis is not a reason to restart a healthy API.
 */
export {}; // marks this file a module, so top-level await is allowed

const port = process.env.PORT ?? "3000";

try {
  const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
    signal: AbortSignal.timeout(3_000),
  });
  process.exit(response.ok ? 0 : 1);
} catch {
  process.exit(1);
}
