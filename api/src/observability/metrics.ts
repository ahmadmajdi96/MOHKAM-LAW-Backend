import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from "prom-client";

export const registry = new Registry();

collectDefaultMetrics({ register: registry });

export const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request latency",
  // Buckets are tuned for an interactive API: the interesting boundary is
  // ~300ms (feels instant) through 2s (user notices), not the default spread.
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5, 10],
  labelNames: ["method", "route", "status"] as const,
  registers: [registry],
});

export const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status"] as const,
  registers: [registry],
});

export const authFailuresTotal = new Counter({
  name: "auth_failures_total",
  help: "Failed authentication attempts",
  labelNames: ["reason"] as const,
  registers: [registry],
});

/** A spike here means a tenancy bug or an active probing attempt. */
export const authzDenialsTotal = new Counter({
  name: "authz_denials_total",
  help: "Authorization denials by resource",
  labelNames: ["resource", "action"] as const,
  registers: [registry],
});

export const aiRequestDuration = new Histogram({
  name: "ai_request_duration_seconds",
  help: "Upstream AI provider latency",
  buckets: [0.5, 1, 2, 5, 10, 20, 40, 80],
  labelNames: ["model", "operation", "status"] as const,
  registers: [registry],
});

export const aiTokensTotal = new Counter({
  name: "ai_tokens_total",
  help: "Tokens consumed upstream",
  labelNames: ["model", "kind"] as const,
  registers: [registry],
});

export const queueJobsTotal = new Counter({
  name: "queue_jobs_total",
  help: "Queue jobs by terminal outcome",
  labelNames: ["queue", "status"] as const,
  registers: [registry],
});

export const queueDepth = new Gauge({
  name: "queue_depth",
  help: "Jobs currently waiting",
  labelNames: ["queue"] as const,
  registers: [registry],
});

export const smsSentTotal = new Counter({
  name: "sms_sent_total",
  help: "Outbound SMS by outcome",
  labelNames: ["status", "reason"] as const,
  registers: [registry],
});
