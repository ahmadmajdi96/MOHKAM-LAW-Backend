# Migrating off hosted Supabase

Moving `okfnirvmlhcqfqxrgxdz` (the Lovable Cloud project) onto this stack.

Read this end to end before starting. The auth migration in particular has a
step that is easy to get wrong and expensive to discover late.

## What has to move

| Data | Source | Destination | Difficulty |
|---|---|---|---|
| 41 public tables | Supabase Postgres | Postgres 17 | Straightforward |
| `auth.users` | Supabase GoTrue | `public.users` | **Needs care — see below** |
| Storage objects | Supabase Storage | MinIO | Straightforward |
| RLS policies | Postgres | `src/authz/` | Already reimplemented |
| Edge functions / cron | Supabase | BullMQ worker | Already reimplemented |

## 0. Before you touch anything

```bash
# Full logical backup of the live database.
pg_dump "$SUPABASE_DIRECT_URL" \
  --format=custom --no-owner --no-acl \
  --file=mohkam-$(date +%Y%m%d).dump
```

Keep it off the machine you are migrating onto. Do a rehearsal run against a
throwaway stack first and only then schedule the real cutover.

You need the Supabase **direct** connection string (port 5432, not the pooler)
and the **service role key**. Neither is in the project's `.env` — Lovable Cloud
injects them at runtime. Get them from the Supabase dashboard under
Project Settings → Database and → API.

## 1. Schema

Do **not** replay the 33 Supabase migrations. This stack's schema is generated
from Drizzle and already includes everything they built, plus the tables that
replace `auth.users`.

```bash
docker compose run --rm migrate
```

Verify: 45 tables, 15 enum types.

```bash
docker compose exec postgres psql -U mohkam -d mohkam \
  -c "SELECT count(*) FROM information_schema.tables
      WHERE table_schema='public' AND table_type='BASE TABLE';"
```

## 2. Users — the one that needs care

Supabase keeps identities in `auth.users`, which this stack replaces with
`public.users`. **Preserve the UUIDs.** Every `owner_id`, `user_id`,
`created_by` and `actor_id` across all 41 tables is a foreign key onto those
ids. Regenerating them orphans the entire dataset.

```sql
-- Run against Supabase, export the result.
SELECT
  id,
  email,
  encrypted_password AS password_hash,
  email_confirmed_at,
  last_sign_in_at,
  created_at
FROM auth.users
WHERE deleted_at IS NULL;
```

Load that straight into `public.users`. The column layout matches deliberately.

**Passwords carry over.** Supabase stores bcrypt; `src/auth/password.ts`
detects a bcrypt prefix, verifies against it, and transparently rehashes to
Argon2id on that user's next successful login. Nobody is forced to reset.

Then backfill profiles for any user missing one:

```sql
INSERT INTO profiles (id, full_name)
SELECT u.id, u.email FROM users u
LEFT JOIN profiles p ON p.id = u.id
WHERE p.id IS NULL;
```

### Users you will not be able to migrate

OAuth-only accounts (Google sign-in, magic-link-only users) have no
`encrypted_password`. They land with `password_hash = NULL` and cannot log in
until they go through password reset. Count them before cutover so the number
does not surprise you:

```sql
SELECT count(*) FROM auth.users
WHERE encrypted_password IS NULL AND deleted_at IS NULL;
```

## 3. Table data

Copy in dependency order — parents before children, or foreign keys reject the
rows:

```
users → profiles → organizations → organization_members → clients → cases
  → case_members, case_notes, case_parties, case_events, appointments,
    deadlines, documents → document_versions, document_shares
  → quotes → tax_invoices → draft_invoices, payment_schedules, payments
    → payment_allocations, client_credits
  → expenses, time_entries, prebills → prebill_lines
  → debt_cases → debt_case_payers, debt_case_assignees,
    debt_collection_payments, debt_reminder_rules, debt_sms_log
  → sms_templates, sms_opt_outs, sms_messages, notifications,
    meetings, live_sessions, courtroom_simulations, activity_log
```

Per table:

```bash
psql "$SUPABASE_DIRECT_URL" -c "\COPY (SELECT * FROM public.cases) TO STDOUT WITH CSV HEADER" \
| docker compose exec -T postgres psql -U mohkam -d mohkam \
    -c "\COPY public.cases FROM STDIN WITH CSV HEADER"
```

For a large dataset, deferring constraints beats ordering by hand:

```sql
BEGIN;
SET CONSTRAINTS ALL DEFERRED;
-- ... all copies ...
COMMIT;
```

Reindex and refresh planner statistics once loaded — without `ANALYZE` the
planner works from empty-table estimates and picks sequential scans:

```sql
REINDEX DATABASE mohkam;
ANALYZE;
```

## 4. Storage

Supabase Storage → MinIO. Object **keys change**: this stack namespaces them
`orgs/{orgId}/cases/{caseId}/{documentId}/{filename}` so tenant deletion and
export are prefix operations.

```bash
mc alias set src https://okfnirvmlhcqfqxrgxdz.supabase.co/storage/v1/s3 \
  "$SUPABASE_S3_ACCESS_KEY" "$SUPABASE_S3_SECRET_KEY"
mc alias set dst http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"

mc mirror --preserve src/documents dst/mohkam
```

Then rewrite `documents.storage_path` (and `document_versions.storage_path`) to
the new keys. Verify nothing dangles before deleting the source:

```sql
SELECT count(*) FROM documents WHERE storage_path NOT LIKE 'orgs/%';
```

## 5. Rebuild the vector index

RAG previously ran against an external index; embeddings now live in
`document_chunks`. Nothing to copy — it has to be rebuilt from the documents:

```sql
-- Queue every document with extractable text for re-indexing.
SELECT id, storage_path FROM documents WHERE extracted_text IS NOT NULL;
```

Enqueue those through `enqueueDocumentIndex`. This costs one embedding API call
per ~1200 characters, so price it against your Novita quota before running it
across the whole corpus. Run it in batches and watch `queue_depth`.

## 6. Point the frontend at this API

The Lovable app talks to `supabase-js`. That client is now gone, and this is
the largest remaining piece of work — it is a frontend change, not a
backend one.

Roughly:

- `supabase.auth.signInWithPassword` → `POST /v1/auth/login`
- `supabase.auth.getSession` / refresh → `POST /v1/auth/refresh`
- `supabase.from('cases').select()` → `GET /v1/cases`
- `supabase.storage.upload` → `POST /v1/documents/upload-url`, PUT to the
  presigned URL, then `POST /v1/documents/:id/confirm`

Send the active organization as an `X-Org-Id` header on every request — this
stack re-checks membership per request rather than trusting a token claim, so
role changes and removals take effect immediately.

## 7. Cutover

1. Put the app in maintenance mode.
2. Take a final `pg_dump`.
3. Run steps 2–5 against production.
4. Point DNS at Caddy; confirm the certificate is issued.
5. `docker compose exec api bun scripts/smoke-test.ts`.
6. Log in as a real user and confirm their cases, clients and documents are
   all present and openable.
7. Keep the Supabase project **paused, not deleted**, for at least 30 days.

## Rollback

Until DNS moves, rollback is repointing the frontend at Supabase. After DNS
moves, it is DNS again plus replaying any writes taken since cutover — which is
why step 1 is maintenance mode rather than a live migration.
