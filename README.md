# Mohkam — self-hosted backend

Production backend for **Project Genesis Build** (Mohkam / محكم), replacing
hosted Supabase with a self-contained Docker Compose stack.

## What this is

The Lovable project used Supabase for database, auth, storage and RLS. This
replaces all four with services you run yourself:

| Concern | Was | Now |
|---|---|---|
| Database | Supabase Postgres | Postgres 17 + pgvector |
| Connection pooling | Supavisor | PgBouncer (transaction mode) |
| Auth | Supabase GoTrue | Own JWT + Argon2id, refresh rotation |
| Row security | Postgres RLS | Application authorization (`src/authz/`) |
| Storage | Supabase Storage | MinIO (S3-compatible) |
| Vector search | external | pgvector + HNSW |
| Background work | edge functions / cron pokes | BullMQ workers + repeatable jobs |
| TLS / routing | Lovable | Caddy (automatic ACME) |

## Stack

```
caddy ──► api ×N ──► pgbouncer ──► postgres 17 + pgvector
            │
            ├──► redis (cache, rate limits, queues)
            └──► minio (documents)

worker ×N ──► document-index · ai-task · sms-send · maintenance
```

All services share a single Docker network (the compose project default), so
the stack only ever consumes one subnet — it won't exhaust Docker's address
pool. Only the API (port 9222) and MinIO (9000/9001) are published to the host;
Postgres, Redis and PgBouncer are reachable only from inside the network.

## Quick start — one command

No `.env` needed. Sane local defaults are baked into the compose file:

```bash
docker compose up -d --build
```

That's it. The stack comes up and the API is on **http://localhost:9222**:

```bash
curl http://localhost:9222/healthz     # {"status":"ok"}
curl http://localhost:9222/readyz      # dependency + feature status
```

- API — http://localhost:9222
- MinIO console — http://localhost:9001  (user/pass: `mohkam` / `mohkam_local_dev`)
- Change the API port with `API_PORT=8080 docker compose up -d`.

AI features (search, summaries) need a Novita key — set `NOVITA_API_KEY` in a
`.env` file (see below). Without it those endpoints return 503; everything
else works.

### Tests

```bash
# 58 checks: auth, refresh rotation, orgs, roles, CRUD, tenant isolation.
# The suites register many users from one IP, so relax the auth rate limit:
AUTH_RATE_LIMIT=1000 docker compose up -d api
docker compose exec api bun scripts/smoke-test.ts

# 34 checks: financials (invoice→payment→recompute), timer, calendar, notifications.
docker compose exec api bun scripts/domains-test.ts

# 28 checks: upload → MinIO → worker → embeddings → pgvector → AI. Needs a Novita key.
SMOKE_BASE_URL=http://localhost:9222 bun api/scripts/integration-test.ts
```

## Production

For a real deployment, create a `.env` (copy `.env.example`) with **strong
secrets**, your real API keys, and a public `S3_PUBLIC_URL`. Generate secrets
alphanumeric, not base64 — base64's `/` and `+` break the connection URLs:

```bash
LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 44
```

The baked-in defaults (`mohkam_local_dev`, `local_dev_*_secret`) are for local
use only and must never reach production.

### TLS + scaling (edge profile)

```bash
# Caddy terminates TLS and load-balances across N api replicas.
docker compose --profile edge up -d --scale api=6 --scale worker=4
```

Set `DOMAIN` and `ACME_EMAIL` in `.env` first. Caddy re-resolves upstreams
from Docker DNS every 5s, so new replicas take traffic without a reload.

### Observability (optional)

```bash
docker compose --profile observability up -d   # Prometheus + Grafana on :3001
```

## Capacity

Sized for thousands of users on a single mid-size host:

- **PgBouncer** collapses ~5000 client connections onto 40 Postgres backends.
  Postgres degrades badly past a few hundred real connections; this is the
  single most important scaling component here.
- **Stateless API** — no session affinity required, so replicas scale flat.
- **Presigned uploads** go browser → MinIO directly. A 200MB file never
  occupies an API worker.
- **Everything slow is queued.** Text extraction, embeddings, AI generation
  and SMS all run in the worker, off the request path.
- **Keyset pagination** everywhere; no `OFFSET` scans, hard cap of 100 rows.

## Configuration

All configuration is environment-driven and validated by Zod at boot
(`src/env.ts`) — a missing or malformed variable fails the container
immediately rather than at 3am inside a request handler.

Integrations degrade rather than crash when unconfigured. `GET /readyz`
reports which are live:

```json
{ "features": { "ai": true, "speechToText": false, "sms": false, "tracing": false } }
```

### API keys carried over

- `NOVITA_API_KEY` — **carried over from the Lovable project**, already set in
  `.env`. Base URL and model (`meta-llama/llama-3.3-70b-instruct`) match the
  original `src/lib/ai-gateway.server.ts`.
- `ELEVENLABS_API_KEY` — **blank, and was blank in the Lovable project too.**
  There was no key to copy. STT stays disabled until you paste one in; the
  scribe-token and transcribe routes return 503 rather than failing obscurely.
- `TWILIO_*` — not present in the original `.env` either. SMS is queued and
  recorded as blocked (`blocked_reason: unconfigured`) until configured.

## Security posture

- **Argon2id** password hashing (Bun native). Inherited Supabase **bcrypt**
  hashes are detected and verified, then silently upgraded on next login — no
  forced reset during migration.
- **Refresh token rotation with reuse detection.** Tokens are stored only as
  SHA-256 hashes. Replaying a rotated token revokes the entire family.
- **Tenant isolation is application-enforced.** See the warning below.
- **Rate limiting** is Redis-backed, so limits are shared across replicas
  rather than multiplied by the replica count.
- Secrets are redacted from logs by path (`src/observability/logger.ts`).
- Containers run as a non-root user; the API image carries no shell HTTP client.

### ⚠️ The RLS tradeoff you accepted

Postgres no longer enforces tenancy. Under Supabase, a forgotten `WHERE`
clause was still safe because RLS filtered it. **That safety net is gone.**

`src/authz/policy.ts` is now the only boundary between tenants. Two rules keep
this tractable, and both must hold:

1. No handler hand-builds a tenant-scoped query. Use `scopeToOrg`,
   `scopeToOwner`, `assertCaseAccess` or `assertOrgRole`.
2. Denials increment `authz_denials_total`. Alert on it — a tenancy bug
   appears as a metric spike rather than as silent cross-tenant reads.

The smoke test covers isolation for cases, clients, list endpoints and forged
`X-Org-Id` headers. Extend it whenever you add a tenant-scoped endpoint.

## Observability

- `GET /healthz` — liveness. Checks nothing external, deliberately: a Redis
  blip must not restart every API container.
- `GET /readyz` — readiness, with per-dependency detail.
- `GET /metrics` — Prometheus. HTTP latency/count, auth failures, authz
  denials, AI latency and token spend, queue depth, SMS outcomes.
- Grafana at `:3000` internally, provisioned with Prometheus as its datasource.

Metrics are labelled by matched **route pattern**, never raw path, so `:id`
parameters cannot explode metric cardinality.

## Layout

```
api/src/
  env.ts                 Zod-validated environment
  db/schema/             41 original tables + users/sessions/chunks
  auth/                  Argon2id, JWT, rotation, sessions
  authz/                 ← the RLS replacement. Read this first.
  http/                  app, middleware, rate limiting, errors
  modules/               route handlers
  services/              redis, cache, storage, ai, language
  queue/                 BullMQ definitions
  worker/                processors + repeatable schedules
  scripts/smoke-test.ts  end-to-end verification
ops/                     Caddyfile, Postgres init, Prometheus, Grafana
docs/MIGRATION.md        moving data off hosted Supabase
```

## Verification status

**Verified end to end against running containers** (86 automated checks):

- Schema, migrations, extensions; PgBouncer transaction pooling
- Auth: register, login, Argon2id, refresh rotation, reuse detection
- Organizations: creation, invites (registered and pending), role gating,
  last-owner protection, immediate cache invalidation on role change
- Tenant isolation across cases, clients, orgs, search and jobs
- Storage: presigned upload, server-side confirm, download round trip
- Worker: text extraction (plain text **and PDF via pdfjs under Bun**),
  chunking, real Novita embeddings, pgvector HNSW retrieval
- AI: task queue, grounded generation, the Arabic/English language lock
- Graceful drain on SIGTERM

**Not verified:**

- **Caddy and TLS** — never started; needs a real domain and DNS.
- **Prometheus scraping and Grafana dashboards** — configured, not exercised.
- **SMS** — no Twilio credentials, so quiet hours, opt-out and daily-cap
  logic are untested code paths.
- **Cron jobs** — registered on boot, but none has been observed firing.
- **Load** — the capacity claims above are design intent. No load test has
  been run.

## What is not built yet

Implemented and live-tested: `auth`, `orgs`, `clients` (with aggregates +
conflict check), `cases` (with clientId filters), `documents`, `ai` (search +
tasks), `financials` (invoices with gapless numbering, payments with
allocation + invoice recompute, quotes, expenses), `time-entries` (start/stop
timer), `calendar` (appointments + deadlines), `notifications`.

Still to build: prebills, debt collection, meetings/live-sessions, analytics,
activity-log feed, SMS send + templates, password-reset / magic-link auth
flows, and the public webhook routes (Twilio inbound/status, ElevenLabs
scribe).

Every one of those tables, enums and indexes already exists in the schema, and
the worker jobs backing debt reminders, invoice ageing, schedule sweeps and
recurrence are implemented. What remains is HTTP handlers following the
pattern in `modules/cases.routes.ts` and `modules/financials.routes.ts`.

**The frontend does not talk to this yet.** The Lovable app still calls
`supabase-js` throughout. Until that client layer is replaced, nothing in the
app reaches this API. See `docs/MIGRATION.md` §6.
