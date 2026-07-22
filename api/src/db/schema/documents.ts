import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { users } from "./auth.ts";
import { cases } from "./cases.ts";
import { clients } from "./crm.ts";
import { organizations } from "./org.ts";

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").references(() => cases.id, { onDelete: "set null" }),
    clientId: uuid("client_id").references(() => clients.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    mimeType: text("mime_type"),
    size: bigint("size", { mode: "number" }),
    // Object key in the S3 bucket. Files are never served from disk.
    storagePath: text("storage_path").notNull(),
    extractedText: text("extracted_text"),
    tags: text("tags").array(),
    category: text("category"),
    isTemplate: boolean("is_template").notNull().default(false),
    currentVersion: integer("current_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("documents_owner_idx").on(table.ownerId),
    index("documents_case_idx").on(table.caseId),
    index("documents_client_idx").on(table.clientId),
    index("documents_tags_idx").using("gin", table.tags),
    // Full-text over extracted OCR/parse output. 'simple' rather than a
    // language stemmer, since the corpus mixes Arabic and English.
    index("documents_text_fts_idx").using(
      "gin",
      sql`to_tsvector('simple', coalesce(${table.extractedText}, ''))`,
    ),
  ],
);

export const documentVersions = pgTable(
  "document_versions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    storagePath: text("storage_path").notNull(),
    size: bigint("size", { mode: "number" }),
    mimeType: text("mime_type"),
    note: text("note"),
    uploadedBy: uuid("uploaded_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("document_versions_doc_version_key").on(
      table.documentId,
      table.version,
    ),
  ],
);

/**
 * Public share links (consumed by the /share/:token route). The token column
 * stores only a hash — the plaintext is shown once, at creation.
 */
export const documentShares = pgTable(
  "document_shares",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    accessCount: integer("access_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("document_shares_token_key").on(table.token),
    index("document_shares_document_idx").on(table.documentId),
  ],
);

export const drafts = pgTable(
  "drafts",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").references(() => cases.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    template: text("template"),
    variables: jsonb("variables").default({}),
    content: text("content").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("drafts_owner_idx").on(table.ownerId, table.updatedAt.desc()),
    index("drafts_case_idx").on(table.caseId),
  ],
);

export const courtroomSimulations = pgTable(
  "courtroom_simulations",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").references(() => cases.id, { onDelete: "set null" }),
    title: text("title"),
    scenario: jsonb("scenario").notNull(),
    transcript: jsonb("transcript").notNull().default([]),
    verdict: jsonb("verdict"),
    score: integer("score"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("courtroom_simulations_owner_idx").on(table.ownerId)],
);

/**
 * NEW — did not exist under hosted Supabase, where RAG ran against an external
 * index. Self-hosting brings retrieval into Postgres via pgvector, removing a
 * network hop and a third-party dependency from every AI request.
 *
 * Dimension 1024 matches baai/bge-m3 (AI_EMBEDDING_MODEL). Changing the model
 * requires a migration to resize this column and a full re-index.
 */
export const documentChunks = pgTable(
  "document_chunks",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid("org_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").references(() => cases.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    tokenCount: integer("token_count"),
    embedding: vector("embedding", { dimensions: 1024 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("document_chunks_doc_index_key").on(
      table.documentId,
      table.chunkIndex,
    ),
    // HNSW beats IVFFlat for recall at this corpus size and needs no training
    // step, so a freshly restored database is immediately queryable.
    index("document_chunks_embedding_idx")
      .using("hnsw", table.embedding.op("vector_cosine_ops"))
      .with({ m: 16, ef_construction: 64 }),
    index("document_chunks_org_idx").on(table.orgId),
  ],
);

export type Document = typeof documents.$inferSelect;
export type DocumentChunk = typeof documentChunks.$inferSelect;
