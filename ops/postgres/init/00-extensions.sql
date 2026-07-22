-- Runs once, on an empty data directory, before the app's own migrations.
-- Extensions must exist before Drizzle migrations reference vector/citext types.

CREATE EXTENSION IF NOT EXISTS pgcrypto;            -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;              -- case-insensitive email
CREATE EXTENSION IF NOT EXISTS pg_trgm;             -- fuzzy client/case search
CREATE EXTENSION IF NOT EXISTS vector;              -- RAG embeddings
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;  -- query-level metrics
CREATE EXTENSION IF NOT EXISTS btree_gin;

-- Arabic text search: Postgres ships no Arabic stemmer, so index Arabic content
-- with the 'simple' configuration plus trigram indexes rather than a stemmer
-- that would silently mangle it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'arabic_simple') THEN
    CREATE TEXT SEARCH CONFIGURATION arabic_simple (COPY = simple);
  END IF;
END $$;
